"""Research inference using the checkpoint's frozen training normalizer.

Set MODEL_CHECKPOINT to an explicit new-format checkpoint. Legacy checkpoints
and externally normalized spreadHistory inputs are intentionally unsupported.
"""
from contextlib import asynccontextmanager
import math
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from spread_model.preprocessing import SCHEMA, Normalizer, feature_window, z_scores

_model = None
_metadata = None
_normalizer = None


def load_model():
    global _model, _metadata, _normalizer
    _model = _metadata = _normalizer = None
    path = os.environ.get('MODEL_CHECKPOINT')
    if not path:
        return False
    import torch
    from spread_model.model import create_model
    state = torch.load(Path(path), map_location='cpu', weights_only=True)
    metadata = state['metadata']
    if metadata['schema'] != SCHEMA or metadata.get('research_only') is not True:
        raise ValueError('Unsupported checkpoint metadata')
    normalizer = Normalizer(**metadata['normalizer'])
    if normalizer.identity != metadata['normalizer_id']:
        raise ValueError('Checkpoint normalization identity mismatch')
    candidate = create_model()
    candidate.load_state_dict(state['model_state_dict'])
    candidate.eval()
    _model, _metadata, _normalizer = candidate, metadata, normalizer
    return True


@asynccontextmanager
async def lifespan(app):
    load_model()  # An explicitly configured invalid checkpoint fails startup visibly.
    yield


app = FastAPI(title='Research spread inference', version='0.2.0', lifespan=lifespan)


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    pairId: str
    # Exactly 50 ordered (epoch, priceA, priceB) observations, without padding.
    observations: list[tuple[float, float, float]] = Field(min_length=50, max_length=50)


@app.get('/health')
async def health():
    return {'modelLoaded': _model is not None, 'researchOnly': True,
            'pairId': _metadata['pair_id'] if _metadata else None,
            'normalizerId': _normalizer.identity if _normalizer else None}


@app.post('/predict')
async def predict(request: PredictRequest):
    if _model is None or _metadata is None or _normalizer is None:
        raise HTTPException(503, 'No research checkpoint loaded')
    if request.pairId != _metadata['pair_id']:
        raise HTTPException(422, 'Checkpoint pair mismatch')
    try:
        features = feature_window(z_scores(request.observations, _normalizer))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    import torch
    with torch.no_grad():
        probability = _model(torch.tensor([features], dtype=torch.float32)).item()
    if not math.isfinite(probability) or not 0 <= probability <= 1:
        raise HTTPException(500, 'Invalid model output')
    return {'reversionProb': probability, 'modelLoaded': True, 'researchOnly': True,
            'normalizerId': _normalizer.identity, 'inputLength': 50}
