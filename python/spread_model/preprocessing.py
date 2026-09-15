"""Shared causal preprocessing. No ML dependencies, database state, or fitted globals."""
import hashlib
import json
import math
from dataclasses import asdict, dataclass

SCHEMA = "frozen-pair-ols-v1"
SEQ_LEN = 50
HORIZON = 20

@dataclass(frozen=True)
class Normalizer:
    alpha: float
    beta: float
    mean: float
    std: float

    @property
    def identity(self):
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True, allow_nan=False).encode()).hexdigest()


def validate_rows(rows, max_gap=60):
    previous = None
    for epoch, a, b in rows:
        if not all(math.isfinite(v) for v in (epoch, a, b)) or a <= 0 or b <= 0:
            raise ValueError("Invalid pair observation")
        if previous is not None and (epoch <= previous or epoch - previous > max_gap):
            raise ValueError("Pair timestamps must be unique, ordered, and within gap policy")
        previous = epoch


def fit_normalizer(training):
    validate_rows(training)
    if len(training) < SEQ_LEN + HORIZON:
        raise ValueError("Insufficient training data")
    x = [math.log(row[2]) for row in training]
    y = [math.log(row[1]) for row in training]
    mx, my = sum(x) / len(x), sum(y) / len(y)
    denominator = sum((v - mx) ** 2 for v in x)
    if denominator <= 0:
        raise ValueError("Undefined hedge ratio")
    beta = sum((a - mx) * (b - my) for a, b in zip(x, y)) / denominator
    alpha = my - beta * mx
    residuals = [b - alpha - beta * a for a, b in zip(x, y)]
    mean = sum(residuals) / len(residuals)
    std = math.sqrt(sum((v - mean) ** 2 for v in residuals) / len(residuals))
    if not math.isfinite(std) or std <= 1e-12:
        raise ValueError("Degenerate spread variance")
    return Normalizer(alpha, beta, mean, std)


def z_scores(rows, normalizer):
    validate_rows(rows)
    if not math.isfinite(normalizer.std) or normalizer.std <= 0:
        raise ValueError("Invalid frozen normalization")
    return [(math.log(a) - normalizer.alpha - normalizer.beta * math.log(b) - normalizer.mean) / normalizer.std for _, a, b in rows]


def feature_window(values):
    if len(values) != SEQ_LEN or not all(math.isfinite(value) for value in values):
        raise ValueError("Exactly 50 finite observations required; no padding")
    result = []
    for i, value in enumerate(values):
        trailing = values[max(0, i - 19):i + 1]
        mean = sum(trailing) / len(trailing)
        vol = math.sqrt(sum((v - mean) ** 2 for v in trailing) / len(trailing))
        # Both unavailable channels are fixed identically in training and serving.
        result.append([value, value - values[i - 1] if i else 0.0, vol, 0.0, 0.0])
    return result


def examples(segment, normalizer):
    values = z_scores(segment, normalizer)
    features, labels = [], []
    for boundary in range(SEQ_LEN, len(values) - HORIZON + 1):
        features.append(feature_window(values[boundary - SEQ_LEN:boundary]))
        labels.append(float(any(abs(v) < 0.5 for v in values[boundary:boundary + HORIZON])))
    if not features:
        raise ValueError("Split too short for isolated features and label horizons")
    return features, labels


def split_dataset(rows):
    validate_rows(rows)
    first, second = int(len(rows) * 0.7), int(len(rows) * 0.85)
    train, validation, test = rows[:first], rows[first:second], rows[second:]
    normalizer = fit_normalizer(train)
    return normalizer, [examples(part, normalizer) for part in (train, validation, test)]
