"""
Training script for SpreadReversionLSTM.

Usage: python spread_model/train.py [--db PATH] [--epochs N] [--pair SYMBOL_A-SYMBOL_B]

Loads historical spread data from data/trading.db,
trains the LSTM model, saves best checkpoint to python/checkpoints/.

Run this AFTER you have collected enough data with npm run research:daemon
and have a baseline Sharpe from the rule-based CorrelationPairStrategy to beat.

Minimum training data: 10,000 spread observations (~3h of continuous collection)
Recommended: 100,000+ spread observations (~30h of daemon running)
"""

import argparse
import sqlite3
import os
import sys
import numpy as np
from pathlib import Path
from datetime import datetime

try:
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset
    from spread_model.model import SpreadReversionLSTM, create_model
except ImportError as e:
    print(f"Missing dependencies: {e}")
    print("Install with: pip install -r requirements.txt")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SEQ_LEN = SpreadReversionLSTM.SEQ_LEN   # 50
N_FEATURES = SpreadReversionLSTM.N_FEATURES  # 5
REVERSION_HORIZON = 20    # ticks: label=1 if |z| < 0.5 within 20 ticks
REVERSION_TARGET_Z = 0.5  # threshold for "reverted"

PROJECT_ROOT = Path(__file__).parent.parent.parent
DB_PATH = PROJECT_ROOT / "data" / "trading.db"
CHECKPOINT_DIR = Path(__file__).parent.parent / "checkpoints"
CHECKPOINT_DIR.mkdir(exist_ok=True)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_spread_data(db_path: Path, pair_id: str) -> tuple[np.ndarray, np.ndarray]:
    """
    Load spread z-scores for a pair from SQLite.
    Returns (features, labels) for training.
    """
    if not db_path.exists():
        raise FileNotFoundError(
            f"Database not found at {db_path}\n"
            "Run `npm run research:daemon` first to collect data."
        )

    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Get pair state
    cursor.execute(
        "SELECT symbol_a, symbol_b, beta_hedge_ratio, spread_mean, spread_std FROM pair_spread_state WHERE pair_id = ?",
        (pair_id,),
    )
    state_row = cursor.fetchone()
    if not state_row:
        conn.close()
        raise ValueError(
            f"No spread state found for pair '{pair_id}'.\n"
            "Run npm run research:daemon with EUR/GBP and AUD/NZD in DAEMON_CATEGORIES."
        )

    symbol_a, symbol_b, beta, spread_mean, spread_std = state_row

    # Get synchronized tick prices for both symbols
    cursor.execute(
        """
        SELECT a.epoch, a.price as price_a, b.price as price_b
        FROM ticks a
        JOIN ticks b ON a.epoch = b.epoch
        WHERE a.symbol = ? AND b.symbol = ?
        ORDER BY a.epoch ASC
        """,
        (symbol_a, symbol_b),
    )
    rows = cursor.fetchall()
    conn.close()

    if len(rows) < SEQ_LEN + REVERSION_HORIZON + 100:
        raise ValueError(
            f"Insufficient data: {len(rows)} synchronized ticks (need ≥{SEQ_LEN + REVERSION_HORIZON + 100}).\n"
            "Run npm run research:daemon for longer to collect more data."
        )

    print(f"Loaded {len(rows):,} synchronized tick pairs for {symbol_a}/{symbol_b}")

    # Compute spread z-scores
    import math
    spreads = []
    for _, price_a, price_b in rows:
        if price_a > 0 and price_b > 0:
            spread = math.log(price_a) - beta * math.log(price_b)
            z = (spread - spread_mean) / (spread_std + 1e-10)
            spreads.append(z)

    spreads_arr = np.array(spreads, dtype=np.float32)

    # Build features and labels
    X, y = [], []
    for i in range(SEQ_LEN, len(spreads_arr) - REVERSION_HORIZON):
        window = spreads_arr[i - SEQ_LEN:i]
        delta = np.diff(window, prepend=window[0])
        vol = _rolling_std(window, 20)

        features = np.stack([
            window,
            delta,
            vol,
            np.zeros(SEQ_LEN),  # cointegration (placeholder, no per-tick data)
            np.zeros(SEQ_LEN),  # regime (placeholder)
        ], axis=-1)

        # Label: 1 if |z| < REVERSION_TARGET_Z within next REVERSION_HORIZON ticks
        future_z = spreads_arr[i:i + REVERSION_HORIZON]
        label = int(np.any(np.abs(future_z) < REVERSION_TARGET_Z))

        X.append(features)
        y.append(label)

    X_arr = np.array(X, dtype=np.float32)
    y_arr = np.array(y, dtype=np.float32)

    pos_rate = y_arr.mean()
    print(f"Dataset: {len(X_arr):,} samples, {pos_rate:.1%} reversion (positive) labels")

    return X_arr, y_arr


def _rolling_std(arr: np.ndarray, window: int) -> np.ndarray:
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        slice_ = arr[max(0, i - window + 1):i + 1]
        result[i] = float(np.std(slice_)) if len(slice_) > 1 else 0.0
    return result


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train(db_path: Path, pair_id: str, epochs: int = 50, batch_size: int = 256, lr: float = 1e-3):
    print(f"\n{'='*60}")
    print(f"SpreadReversionLSTM Training")
    print(f"Pair: {pair_id}")
    print(f"Epochs: {epochs}, Batch size: {batch_size}, LR: {lr}")
    print(f"{'='*60}\n")

    X, y = load_spread_data(db_path, pair_id)

    # Train/val split (80/20, time-ordered — no shuffling)
    split = int(len(X) * 0.8)
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    # Class-balanced sampling
    pos_weight = torch.tensor([(y_train == 0).sum() / max((y_train == 1).sum(), 1)])

    train_ds = TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train))
    val_ds = TensorDataset(torch.from_numpy(X_val), torch.from_numpy(y_val))
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    model = create_model().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=5, factor=0.5)
    criterion = nn.BCELoss(reduction="none")

    best_val_loss = float("inf")
    checkpoint_path = CHECKPOINT_DIR / "spread_reversion_best.pt"

    for epoch in range(1, epochs + 1):
        # Train
        model.train()
        train_loss = 0.0
        for X_batch, y_batch in train_loader:
            X_batch, y_batch = X_batch.to(device), y_batch.to(device)
            optimizer.zero_grad()
            pred = model(X_batch).squeeze()
            # Apply pos_weight for class imbalance
            weights = torch.where(y_batch == 1, pos_weight.to(device), torch.ones(1, device=device))
            loss = (criterion(pred, y_batch) * weights).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += loss.item()

        # Validate
        model.eval()
        val_loss = 0.0
        val_correct = 0
        val_total = 0
        with torch.no_grad():
            for X_batch, y_batch in val_loader:
                X_batch, y_batch = X_batch.to(device), y_batch.to(device)
                pred = model(X_batch).squeeze()
                loss = criterion(pred, y_batch).mean()
                val_loss += loss.item()
                predicted = (pred > 0.5).float()
                val_correct += (predicted == y_batch).sum().item()
                val_total += len(y_batch)

        avg_train = train_loss / len(train_loader)
        avg_val = val_loss / len(val_loader)
        accuracy = val_correct / max(val_total, 1) * 100
        scheduler.step(avg_val)

        print(f"Epoch {epoch:3d}/{epochs} | train_loss={avg_train:.4f} | val_loss={avg_val:.4f} | val_acc={accuracy:.1f}%")

        if avg_val < best_val_loss:
            best_val_loss = avg_val
            torch.save({
                "epoch": epoch,
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "val_loss": avg_val,
                "pair_id": pair_id,
                "trained_at": datetime.utcnow().isoformat(),
            }, str(checkpoint_path))
            print(f"  ✓ New best checkpoint saved ({avg_val:.4f})")

    print(f"\nTraining complete. Best val loss: {best_val_loss:.4f}")
    print(f"Checkpoint: {checkpoint_path}")
    print("\nStart the sidecar: npm run sidecar:serve")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train SpreadReversionLSTM")
    parser.add_argument("--db", type=str, default=str(DB_PATH), help="Path to trading.db")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument(
        "--pair",
        type=str,
        default="frxEURGBP-frxAUDNZD",
        help="Pair ID (must match pair_spread_state.pair_id in DB)",
    )
    args = parser.parse_args()

    train(
        db_path=Path(args.db),
        pair_id=args.pair,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
    )
