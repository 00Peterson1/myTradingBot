"""
Spread Reversion LSTM Model
===========================
Predicts short-horizon probability that a diverged pair spread will
revert toward the mean (|z| → 0) within the next 20 ticks.

Architecture (grounded in arXiv:2111.04709 + arXiv:2103.09750):
  Input:  50-tick window of [spread_z, spread_delta, vol_20, regime]
  Model:  LSTM(hidden=64, layers=2) → Dropout(0.2) → Linear(64→1) → Sigmoid
  Output: P(spread reverts to |z| < 0.5 within 20 ticks)
  Loss:   Binary cross-entropy (balanced by positive/negative ratio)
  Task:   Binary classification: reversion (1) vs non-reversion (0)

Training data comes from pair_spread_state + tick_features tables in
data/trading.db (produced by npm run research:daemon).

Build this AFTER the rule-based CorrelationPairStrategy has a baseline
Sharpe to beat. The model's job is to refine timing/confidence on top
of the z-score signal — not to replace it.
"""

import torch
import torch.nn as nn
from torch import Tensor


class SpreadReversionLSTM(nn.Module):
    """
    LSTM model for spread mean-reversion probability prediction.

    Input shape:  (batch_size, seq_len=50, n_features=5)
    Output shape: (batch_size, 1)  — probability in [0, 1]

    Features per tick (n_features = 5):
      0. spread_z       — spread z-score (continuous)
      1. spread_delta   — change in spread z from prior tick
      2. vol_20         — 20-period rolling std of spread
      3. cointegration  — rolling cointegration p-value (lower = stronger)
      4. regime         — 0=trending, 1=mean-reverting (from HMM or ATR)
    """

    SEQ_LEN = 50
    N_FEATURES = 5

    def __init__(
        self,
        hidden_size: int = 64,
        num_layers: int = 2,
        dropout: float = 0.2,
    ):
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers

        self.lstm = nn.LSTM(
            input_size=self.N_FEATURES,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
        )

        self.head = nn.Sequential(
            nn.Dropout(dropout),
            nn.Linear(hidden_size, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
            nn.Sigmoid(),
        )

    def forward(self, x: Tensor) -> Tensor:
        """
        Args:
            x: (batch, seq_len, n_features)
        Returns:
            prob: (batch, 1) — P(reversion within 20 ticks)
        """
        lstm_out, _ = self.lstm(x)
        # Use last timestep output only (many-to-one)
        last = lstm_out[:, -1, :]
        prob = self.head(last)
        return prob


def create_model(
    hidden_size: int = 64,
    num_layers: int = 2,
    dropout: float = 0.2,
) -> SpreadReversionLSTM:
    """Factory function for consistent model creation."""
    return SpreadReversionLSTM(
        hidden_size=hidden_size,
        num_layers=num_layers,
        dropout=dropout,
    )


if __name__ == "__main__":
    # Quick smoke test
    model = create_model()
    dummy = torch.randn(8, SpreadReversionLSTM.SEQ_LEN, SpreadReversionLSTM.N_FEATURES)
    out = model(dummy)
    print(f"Model output shape: {out.shape}")  # (8, 1)
    print(f"Sample probabilities: {out.squeeze().detach().numpy()}")
    total_params = sum(p.numel() for p in model.parameters())
    print(f"Total parameters: {total_params:,}")
