"""Research-only training with frozen normalization and isolated raw-time splits."""
import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid
from spread_model.preprocessing import SCHEMA, split_dataset

ROOT = Path(__file__).resolve().parents[2]


def load_rows(db_path, pair_id):
    with sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True) as conn:
        pair = conn.execute('SELECT symbol_a,symbol_b FROM pair_spread_state WHERE pair_id=?', (pair_id,)).fetchone()
        if not pair:
            raise ValueError('Unknown pair')
        rows = conn.execute('SELECT a.epoch,a.price,b.price FROM ticks a JOIN ticks b ON a.epoch=b.epoch WHERE a.symbol=? AND b.symbol=? ORDER BY a.epoch', pair).fetchall()
    return pair, rows


def train(db_path, pair_id, epochs=50, batch_size=256, lr=0.001, seed=1729):
    if epochs < 1 or batch_size < 1 or not 0 < lr < 1:
        raise ValueError('Invalid training settings')
    import numpy as np
    import torch
    from torch.utils.data import DataLoader, TensorDataset
    from spread_model.model import create_model
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)
    np.random.seed(seed)
    pair, rows = load_rows(db_path, pair_id)
    if len(rows) < 10000:
        raise ValueError('At least 10000 synchronized observations are required')
    normalizer, splits = split_dataset(rows)
    loaders = [DataLoader(TensorDataset(torch.tensor(np.asarray(x), dtype=torch.float32), torch.tensor(y, dtype=torch.float32)),
                          batch_size=batch_size, shuffle=False) for x, y in splits]
    model = create_model()  # CPU reference path; no nondeterministic accelerator assumptions.
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-5)
    criterion = torch.nn.BCELoss(reduction='sum')

    def evaluate(loader):
        model.eval()
        total, count = 0.0, 0
        with torch.no_grad():
            for x, y in loader:
                total += criterion(model(x).reshape(-1), y).item()
                count += len(y)
        return total / count

    best_loss, best_state = float('inf'), None
    for epoch in range(epochs):
        model.train()
        for x, y in loaders[0]:
            optimizer.zero_grad()
            loss = criterion(model(x).reshape(-1), y) / len(y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        validation_loss = evaluate(loaders[1])
        if validation_loss < best_loss:
            best_loss = validation_loss
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
        print(f'Epoch {epoch + 1}/{epochs}: validation BCE={validation_loss:.6f}')
    if best_state is None:
        raise ValueError('Training produced no finite checkpoint')
    model.load_state_dict(best_state)
    dataset_id = hashlib.sha256(json.dumps(rows, allow_nan=False).encode()).hexdigest()
    folder = ROOT / 'python' / 'checkpoints'
    folder.mkdir(exist_ok=True)
    # An interrupted or previously evaluated holdout must not be silently reused.
    with (folder / f'holdout-{dataset_id}.json').open('x') as claim:
        json.dump({'dataset_id': dataset_id, 'pair_id': pair_id, 'seed': seed, 'epochs': epochs, 'batch_size': batch_size, 'lr': lr}, claim)
    test_loss = evaluate(loaders[2])  # Read once, after selection; never selects an epoch.
    metadata = {'schema': SCHEMA, 'pair_id': pair_id, 'symbols': list(pair), 'seed': seed,
                'normalizer': asdict(normalizer), 'normalizer_id': normalizer.identity,
                'dataset_id': dataset_id,
                'code_id': hashlib.sha256(b''.join((Path(__file__).parent / file).read_bytes() for file in ['train.py', 'preprocessing.py', 'model.py'])).hexdigest(),
                'torch_version': str(torch.__version__), 'numpy_version': str(np.__version__),
                'split_policy': '70/15/15 raw chronological; independent feature and label windows',
                'epochs': epochs, 'batch_size': batch_size, 'lr': lr, 'validation_loss': best_loss,
                'test_loss': test_loss, 'created_at': datetime.now(timezone.utc).isoformat(),
                'research_only': True}
    checkpoint = folder / f'{uuid.uuid4()}.pt'
    torch.save({'model_state_dict': best_state, 'metadata': metadata}, checkpoint)
    print(f'Research checkpoint: {checkpoint}. Test BCE={test_loss:.6f}; not trading eligibility.')
    return checkpoint


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=ROOT / 'data' / 'trading.db')
    parser.add_argument('--pair', default='frxEURGBP-frxAUDNZD')
    parser.add_argument('--epochs', type=int, default=50)
    parser.add_argument('--batch-size', type=int, default=256)
    parser.add_argument('--lr', type=float, default=0.001)
    parser.add_argument('--seed', type=int, default=1729)
    args = parser.parse_args()
    train(args.db, args.pair, args.epochs, args.batch_size, args.lr, args.seed)
