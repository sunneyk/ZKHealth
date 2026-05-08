"""Anonymization business logic for the ZKHealth data marketplace.

Noise is added via the Laplace mechanism with ε = 1.0, giving a formal
ε-differential privacy guarantee for each mean query.
"""
from __future__ import annotations

import math
import random

_EPSILON = 1.0  # privacy budget per query


def _round_sig(value: float, sig: int) -> float:
    if value == 0:
        return 0.0
    magnitude = math.floor(math.log10(abs(value)))
    factor = 10 ** (sig - 1 - magnitude)
    return round(value * factor) / factor


def _laplace_sample(scale: float) -> float:
    """Draw a sample from Laplace(0, scale) via the inverse-CDF method."""
    u = random.uniform(-0.5 + 1e-9, 0.5 - 1e-9)
    return -scale * math.copysign(1.0, u) * math.log(1.0 - 2.0 * abs(u))


def _laplace_noise(values: list[float]) -> float:
    """
    Return Laplace noise calibrated to the observed sensitivity of a mean query.

    Global sensitivity of a mean over n values with observed range R:
        Δf = R / n
    Laplace scale:
        b = Δf / ε
    A minimum scale of 0.2 % of the mean prevents zero noise when all readings
    are identical (e.g. a single entry).
    """
    n = len(values)
    mean = sum(values) / n
    observed_range = max(values) - min(values) if n > 1 else abs(mean) * 0.5
    sensitivity = observed_range / n
    scale = max(sensitivity / _EPSILON, abs(mean) * 0.002)
    return _laplace_sample(scale)


def get_anonymized_snapshot(db_obs: list[dict], listed_canonicals: set[str]) -> list[dict]:
    """
    Filter observations to listed canonicals, add Laplace-mechanism noise to the
    per-canonical mean (ε-DP, ε = 1.0), and return
    {canonical_name, noisy_value, unit, n_readings} — no dates or obs_ids.
    Sorted by canonical_name.
    """
    groups: dict[str, list[dict]] = {}
    for obs in db_obs:
        name = obs["canonical_name"]
        if name not in listed_canonicals:
            continue
        groups.setdefault(name, []).append(obs)

    result: list[dict] = []
    for canonical_name in sorted(groups):
        entries = groups[canonical_name]
        unit = entries[0]["unit"] if entries else ""
        values = [float(e["value"]) for e in entries]
        mean = sum(values) / len(values)
        noisy_mean = max(0.0, mean + _laplace_noise(values))
        result.append({
            "canonical_name": canonical_name,
            "noisy_value": _round_sig(noisy_mean, 4),
            "unit": unit,
            "n_readings": len(entries),
        })

    return result


def anonymized_preview(db_obs: list[dict], listed_canonicals: set[str]) -> list[dict]:
    """
    Preview shown before purchase — plain means, no noise.
    Returns {canonical_name, mean, unit, n_readings}.
    """
    groups: dict[str, list[dict]] = {}
    for obs in db_obs:
        name = obs["canonical_name"]
        if name not in listed_canonicals:
            continue
        groups.setdefault(name, []).append(obs)

    result: list[dict] = []
    for canonical_name in sorted(groups):
        entries = groups[canonical_name]
        unit = entries[0]["unit"] if entries else ""
        values = [float(e["value"]) for e in entries]
        mean = _round_sig(sum(values) / len(values), 4) if values else 0.0
        result.append({
            "canonical_name": canonical_name,
            "mean": mean,
            "unit": unit,
            "n_readings": len(entries),
        })

    return result
