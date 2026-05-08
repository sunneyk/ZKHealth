"""Anonymization business logic for the ZKHealth data marketplace."""
from __future__ import annotations

import math
import random


def _round_sig(value: float, sig: int) -> float:
    """Round value to sig significant figures."""
    if value == 0:
        return 0.0
    magnitude = math.floor(math.log10(abs(value)))
    factor = 10 ** (sig - 1 - magnitude)
    return round(value * factor) / factor


def get_anonymized_snapshot(db_obs: list[dict], listed_canonicals: set[str]) -> list[dict]:
    """
    Filter observations to listed canonicals, add ±5% uniform noise to each
    value, round to 4 significant figures, and return a list of
    {canonical_name, noisy_value, unit, n_readings} with NO dates or obs_ids.
    Sorted by canonical_name.
    """
    # Group by canonical_name
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
        noisy_values = []
        for entry in entries:
            val = float(entry["value"])
            noise = random.uniform(-0.05, 0.05) * val
            noisy_values.append(_round_sig(val + noise, 4))
        # Return the noisy mean across all readings for this canonical
        noisy_mean = _round_sig(sum(noisy_values) / len(noisy_values), 4) if noisy_values else 0.0
        result.append({
            "canonical_name": canonical_name,
            "noisy_value": noisy_mean,
            "unit": unit,
            "n_readings": len(entries),
        })

    return result


def anonymized_preview(db_obs: list[dict], listed_canonicals: set[str]) -> list[dict]:
    """
    Same filtering as get_anonymized_snapshot but returns plain means (no noise),
    labeled as preview. Returns {canonical_name, mean, unit, n_readings}.
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
        mean = _round_sig(sum(values) / len(values), 4) if values else 0.0
        result.append({
            "canonical_name": canonical_name,
            "mean": mean,
            "unit": unit,
            "n_readings": len(entries),
        })

    return result
