"""
FastAPI inference server for the SpreadReversionLSTM model.
Start with: uvicorn spread_model.serve:app --port 8765 --reload

The TypeScript bot calls POST /predict with:
  { spreadHistory: number[], features: object }

Returns:
  { reversionProb: number, confidence: number, modelLoaded: boolean }

If no checkpoint is available (model not yet trained), returns safe defaults
(reversionProb=0.5, confidence=0.0, modelLoaded=false) — the TypeScript
side checks modelLoaded and ignores the DL confidence when false.
"""

import os
import json
import numpy as np
from pathlib import Path
from typing import Any

try:
    import torch
    from spread_model.model import SpreadReversionLSTM, create_model
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(
    title="Spread Reversion Model Sidecar",
    description="Predicts P(spread reversion) for EUR/GBP + AUD/NZD correlation basket",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

CHECKPOINT_DIR = Path(__file__).parent.parent / "checkpoints"
CHECKPOINT_PATH = CHECKPOINT_DIR / "spread_reversion_best.pt"

_model = None
_model_loaded = False


def load_model() -> bool:
    global _model, _model_loaded
    if not TORCH_AVAILABLE:
        return False
    if not CHECKPOINT_PATH.exists():
        print(f"[sidecar] No checkpoint at {CHECKPOINT_PATH} — run `npm run sidecar:train` first")
        return False
    try:
        _model = create_model()
        state = torch.load(str(CHECKPOINT_PATH), map_location="cpu")
        _model.load_state_dict(state["model_state_dict"])
        _model.eval()
        _model_loaded = True
        print(f"[sidecar] Model loaded from {CHECKPOINT_PATH}")
        return True
    except Exception as e:
        print(f"[sidecar] Failed to load model: {e}")
        return False


@app.on_event("startup")
async def startup_event():
    load_model()
    print(f"[sidecar] Spread reversion sidecar ready. Model loaded: {_model_loaded}")


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class PredictRequest(BaseModel):
    # Last N spread z-score values (oldest first)
    spreadHistory: list[float]
    # Optional signal metadata from the strategy
    features: dict[str, Any] = {}


class PredictResponse(BaseModel):
    reversionProb: float    # P(reversion) in [0, 1]
    confidence: float       # Model confidence (0 if model not loaded)
    modelLoaded: bool       # Whether a trained checkpoint is available
    inputLength: int        # Actual input length used


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "modelLoaded": _model_loaded, "torchAvailable": TORCH_AVAILABLE}


@app.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest) -> PredictResponse:
    if not _model_loaded or _model is None:
        return PredictResponse(
            reversionProb=0.5,   # Neutral — no model to consult
            confidence=0.0,
            modelLoaded=False,
            inputLength=len(request.spreadHistory),
        )

    seq_len = SpreadReversionLSTM.SEQ_LEN
    n_features = SpreadReversionLSTM.N_FEATURES

    # Build feature matrix from spread history
    # Features: [spread_z, spread_delta, vol_20, cointegration_p, regime]
    spread = np.array(request.spreadHistory[-seq_len:], dtype=np.float32)
    n = len(spread)

    if n < 5:
        return PredictResponse(
            reversionProb=0.5,
            confidence=0.0,
            modelLoaded=True,
            inputLength=n,
        )

    # Pad if shorter than seq_len
    if n < seq_len:
        spread = np.pad(spread, (seq_len - n, 0), mode="edge")

    # Build feature vector per timestep
    delta = np.diff(spread, prepend=spread[0])
    vol = _rolling_std(spread, 20)
    cointegp = float(request.features.get("cointegP", 0.5))
    regime = float(request.features.get("regime", 0.5))  # 0=trending, 1=reverting

    features = np.stack([
        spread,
        delta,
        vol,
        np.full_like(spread, cointegp),
        np.full_like(spread, regime),
    ], axis=-1)  # (seq_len, n_features)

    # Inference
    x = torch.tensor(features[np.newaxis], dtype=torch.float32)  # (1, seq_len, n_features)
    with torch.no_grad():
        prob = _model(x).item()

    # Confidence: how far from 0.5 (uncertain) the prediction is
    confidence = min(1.0, abs(prob - 0.5) * 2.0)

    return PredictResponse(
        reversionProb=float(prob),
        confidence=float(confidence),
        modelLoaded=True,
        inputLength=seq_len,
    )


def _rolling_std(arr: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling standard deviation."""
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        window_data = arr[max(0, i - window + 1):i + 1]
        result[i] = float(np.std(window_data)) if len(window_data) > 1 else 0.0
    return result
