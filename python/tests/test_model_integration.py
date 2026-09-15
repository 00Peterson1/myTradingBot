import importlib.util
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

AVAILABLE = all(importlib.util.find_spec(name) for name in ('torch', 'numpy', 'fastapi', 'httpx'))

@unittest.skipUnless(AVAILABLE, 'Install the Python research dependencies for model integration checks')
class ModelIntegration(unittest.TestCase):
    def test_cpu_training_checkpoint_and_inference(self):
        import torch
        from fastapi.testclient import TestClient
        from spread_model import train, serve
        rows = [(i, math.exp(1 + .7 * (2 + i / 10000) + .01 * math.sin(i)), math.exp(2 + i / 10000)) for i in range(10000)]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'python').mkdir()
            with patch.object(train, 'ROOT', root), patch.object(train, 'load_rows', return_value=(('A', 'B'), rows)):
                checkpoint = train.train(root / 'unused.db', 'A-B', epochs=1, batch_size=512, seed=123)
            state = torch.load(checkpoint, weights_only=True)
            self.assertTrue(math.isfinite(state['metadata']['test_loss']))
            self.assertEqual(len(state['metadata']['code_id']), 64)
            with patch.dict(os.environ, {'MODEL_CHECKPOINT': str(checkpoint)}):
                with TestClient(serve.app) as client:
                    self.assertTrue(client.get('/health').json()['modelLoaded'])
                    response = client.post('/predict', json={'pairId': 'A-B', 'observations': rows[-50:]})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertTrue(0 <= response.json()['reversionProb'] <= 1)
                    self.assertEqual(response.json()['normalizerId'], state['metadata']['normalizer_id'])
                    self.assertEqual(client.post('/predict', json={'pairId': 'WRONG', 'observations': rows[-50:]}).status_code, 422)
                    self.assertEqual(client.post('/predict', json={'pairId': 'A-B', 'observations': rows[-49:]}).status_code, 422)
                    self.assertEqual(client.post('/predict', json={'spreadHistory': [0] * 50}).status_code, 422)
            self.assertEqual(len(list((root / 'python' / 'checkpoints').glob('holdout-*.json'))), 1)

    def test_legacy_checkpoint_fails_instead_of_loading_incompatible_features(self):
        import torch
        from fastapi.testclient import TestClient
        from spread_model import serve
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / 'legacy.pt'
            torch.save({'model_state_dict': {}}, checkpoint)
            with patch.dict(os.environ, {'MODEL_CHECKPOINT': str(checkpoint)}):
                with self.assertRaises(KeyError):
                    with TestClient(serve.app): pass

if __name__ == '__main__': unittest.main()
