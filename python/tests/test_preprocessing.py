import math
import unittest
from spread_model.preprocessing import split_dataset, feature_window, z_scores

class CausalPreprocessing(unittest.TestCase):
    def rows(self):
        return [(i, math.exp(1 + 0.7 * (2 + i / 1000) + 0.01 * math.sin(i)), math.exp(2 + i / 1000)) for i in range(1000)]

    def test_future_cannot_change_training_state_or_labels(self):
        original = self.rows()
        normalizer, splits = split_dataset(original)
        changed = [(t, a * 2 if t >= 700 else a, b) for t, a, b in original]
        other_normalizer, other_splits = split_dataset(changed)
        self.assertEqual(normalizer, other_normalizer)
        self.assertEqual(splits[0], other_splits[0])
        self.assertNotEqual(splits[1], other_splits[1])
        self.assertEqual(len(splits[0][0]), 700 - 50 - 20 + 1)

    def test_training_and_serving_use_identical_windows(self):
        rows = self.rows()
        normalizer, splits = split_dataset(rows)
        self.assertEqual(splits[1][0][0], feature_window(z_scores(rows[700:750], normalizer)))
        with self.assertRaises(ValueError): feature_window([0] * 49)

    def test_rejects_ambiguous_or_interrupted_observations(self):
        rows = self.rows()
        for modified in [rows[:1] + rows, [(0, -1, 2)] + rows[1:], rows[:20] + rows[200:]]:
            with self.assertRaises(ValueError): split_dataset(modified)

if __name__ == '__main__': unittest.main()
