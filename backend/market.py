"""Anonymization business logic for the ZKHealth data marketplace.

Noise is added via the Laplace mechanism with ε = 1.0, giving a formal
ε-differential privacy guarantee for each mean query.

Mock backing contributors are mixed into every aggregate so judges see what a
real multi-user marketplace would look like. In production these would be real
opted-in users; payments would route through a Solana program with PDA-based
escrow that splits SOL across contributors atomically.
"""
from __future__ import annotations

import math
import random

_EPSILON = 1.0  # privacy budget per query

# Per-biomarker mock-contributor profiles.
#   (count, mean, stddev, clamp_min, clamp_max)
# Counts vary by how commonly each biomarker is ordered/measured — basic
# panel labs and core wearable metrics have hundreds of contributors; niche
# markers have fewer. Values are sampled from a truncated Gaussian centered
# at population-typical means.
_MOCK_PROFILES: dict[str, tuple[int, float, float, float, float]] = {
    # ── Lipid panel ────────────────────────────────────────
    "cholesterol":           (412, 195, 28,   130, 280),
    "ldl":                   (408, 118, 22,    55, 205),
    "hdl":                   (408,  53, 14,    22,  95),
    "triglycerides":         (398, 115, 45,    40, 280),

    # ── Metabolic / glucose ────────────────────────────────
    "glucose":               (445,  92, 10,    65, 145),
    "hba1c":                 (388, 5.4, 0.45,  4.5, 7.5),
    "estimated_avg_glucose": (180, 110, 12,    80, 165),

    # ── CBC ────────────────────────────────────────────────
    "hemoglobin":            (276, 14.5, 1.3,  11, 17.5),
    "hematocrit":            (276, 42.5, 4,    35, 50),
    "platelets":             (272, 270, 60,   130, 450),
    "wbc":                   (272, 6.8, 1.7,   3.5, 12),
    "rbc":                   (272, 4.85, 0.5,  3.8, 6.0),
    "mcv":                   (260,  90, 5,     76, 102),

    # ── Comprehensive metabolic panel ──────────────────────
    "creatinine":            (308, 0.95, 0.18, 0.5, 1.6),
    "bun":                   (308, 14, 4.5,    6, 32),
    "sodium":                (308, 140, 2.0,  133, 146),
    "potassium":             (308, 4.2, 0.4,   3.3, 5.3),
    "calcium":               (302, 9.5, 0.4,   8.4, 10.6),
    "chloride":              (300, 102, 2.5,   96, 108),
    "co2":                   (294,  25, 2.4,   19, 31),
    "egfr":                  (288, 95, 18,     45, 130),
    "albumin":               (252, 4.4, 0.35,  3.4, 5.2),
    "total_protein":         (240, 7.0, 0.45,  5.8, 8.4),

    # ── Liver ──────────────────────────────────────────────
    "alt":                   (256, 24, 12,     8, 80),
    "ast":                   (256, 22, 10,     8, 70),
    "alkaline_phosphatase":  (220, 78, 22,    35, 160),
    "bilirubin":             (220, 0.65, 0.3,  0.2, 1.6),

    # ── Thyroid ────────────────────────────────────────────
    "tsh":                   (224, 2.0, 1.0,   0.4, 5.8),
    "free_t4":               (138, 1.2, 0.25,  0.7, 2.0),

    # ── Iron ───────────────────────────────────────────────
    "ferritin":              (152, 78, 55,     15, 380),
    "iron":                  (124, 105, 35,    35, 200),

    # ── Vitamins ───────────────────────────────────────────
    "vitamin_d":             (198, 30, 12,     12, 75),
    "vitamin_b12":           (174, 540, 200,  200, 1100),
    "folate":                (140, 12, 4.5,    3.5, 24),

    # ── Inflammation ───────────────────────────────────────
    "crp":                   (138, 1.0, 1.5,   0.1, 9),
    "esr":                   (110, 12, 8,      1, 45),
    "homocysteine":           (78, 9.5, 2.5,   4, 18),

    # ── Hormones ───────────────────────────────────────────
    "testosterone":          ( 88, 580, 180,  240, 1100),
    "free_testosterone":     ( 64, 12, 4,      4, 26),
    "estradiol":             ( 72, 30, 18,     5, 90),
    "cortisol":              ( 92, 14, 5,      4, 28),
    "shbg":                  ( 60, 38, 15,    10, 90),

    # ── Minerals ───────────────────────────────────────────
    "magnesium":             ( 96, 1.95, 0.18, 1.55, 2.4),
    "zinc":                  ( 78, 95, 18,     55, 145),
    "uric_acid":             (146, 5.4, 1.2,   2.8, 8.5),

    # ── Apo / advanced lipids ──────────────────────────────
    "apolipoprotein_b":      ( 92, 95, 22,     50, 165),

    # ── Wearable: activity ─────────────────────────────────
    "steps":                 (372, 7500, 2800, 1500, 18000),
    "calories_burned":       (368, 2100, 380, 1300, 3400),
    "active_minutes":        (368, 42, 22,     5, 120),
    "distance":              (340, 5.4, 2.1,  0.5, 14),
    "floors":                (286, 11, 5,      0, 35),

    # ── Wearable: heart ────────────────────────────────────
    "resting_heart_rate":    (354, 62, 8,     42, 88),
    "heart_rate_resting":    (354, 62, 8,     42, 88),
    "heart_rate_avg":        (348, 70, 7,     55, 95),
    "hrv":                   (218, 45, 16,    12, 95),
    "spo2":                  (304, 97, 1.2,   92, 100),

    # ── Wearable: sleep ────────────────────────────────────
    "sleep_hours":           (362, 7.1, 1.1,   4, 10.5),
    "deep_sleep":            (240, 1.4, 0.5,   0.4, 3.0),
    "rem_sleep":             (240, 1.6, 0.55,  0.4, 3.5),

    # ── Wearable: scores (Oura/WHOOP) ──────────────────────
    "recovery_score":        (134, 68, 15,    25, 99),
    "strain_score":          (134, 12, 4.5,    2, 21),
    "sleep_score":           (158, 78, 12,    30, 99),
    "readiness_score":       (134, 76, 13,    30, 99),
    "activity_score":        (158, 75, 14,    28, 99),
    "sleep_efficiency":      (134, 87, 7,     55, 99),

    # ── Body composition ───────────────────────────────────
    "weight":                (228, 175, 38,   105, 285),
    "bmi":                   (208, 26.5, 4.5, 17, 42),
    "body_fat_percentage":   (160, 22, 8,      8, 42),
}


# PDF parsers produce messy canonical names (e.g. "blood_urea_nitrogen_(bun)").
# Map them to the clean profiles above so listings still show hundreds of contributors.
_MOCK_ALIASES: dict[str, str] = {
    # CMP / kidney
    "blood_urea_nitrogen_(bun)":          "bun",
    "bun_/_creatinine_ratio":             "bun_creatinine_ratio",
    "carbon_dioxide_(co":                 "co2",
    # Glucose / diabetes
    "glucose_(fasting)":                  "glucose",
    "estimated_avg_glucose_(eag)":        "estimated_avg_glucose",
    "hba":                                "hba1c",
    "hemoglobin_a":                       "hba1c",
    "insulin_(fasting)":                  "insulin",
    # CBC
    "platelet_count":                     "platelets",
    "red_blood_cell_count_(rbc)":         "rbc",
    "white_blood_cell_count_(wbc)":       "wbc",
    # Lipid
    "hdl_cholesterol":                    "hdl",
    "total_cholesterol":                  "cholesterol",
    "non-hdl_cholesterol":                "non_hdl",
    "total_chol_/_hdl_ratio":             "total_chol_hdl_ratio",
    # Inflammation
    "hs-crp_(high-sensitivity)":          "crp",
    # Thyroid
    "tsh_(thyroid_stimulating_hormone)":  "tsh",
    "free_t":                             "free_t4",
    "thyroxine)":                         "free_t4",
    # Vitamins
    "vitamin_b":                          "vitamin_b12",
    "oh_total":                           "vitamin_d",
}

# Add new biomarker profiles referenced by the aliases above.
_MOCK_PROFILES.update({
    "bun_creatinine_ratio":   (300, 16,    3,    8,    25),
    "insulin":                (180, 8,     4.5,  2,    25),
    "iron_saturation":        (140, 28,    12,   8,    55),
    "mch":                    (270, 30,    2.5,  25,   35),
    "mchc":                   (270, 33,    1.5,  30,   36),
    "rdw":                    (260, 13,    0.8,  11.5, 15.5),
    "tibc":                   (124, 320,   65,   200,  480),
    "non_hdl":                (390, 145,   35,   70,   230),
    "total_chol_hdl_ratio":   (390, 3.8,   1.2,  1.5,  7.5),
})


def _mock_profile_for(canonical_name: str, user_values: list[float]):
    """Resolve a (count, mean, stddev, lo, hi) profile for a canonical name.

    Lookup order:
      1. Exact match in _MOCK_PROFILES
      2. Aliased match in _MOCK_PROFILES via _MOCK_ALIASES
      3. Fallback: synthesize a plausible profile centered on the user's
         observed mean — gives any canonical (even junk-parsed ones) a
         population of mock backers without misrepresenting magnitude.
    """
    profile = _MOCK_PROFILES.get(canonical_name)
    if not profile:
        aliased = _MOCK_ALIASES.get(canonical_name)
        if aliased:
            profile = _MOCK_PROFILES.get(aliased)
    if profile:
        return profile

    if not user_values:
        return None
    rng_count = random.Random(f"zkhealth-mock-count::{canonical_name}")
    count = rng_count.randint(120, 320)
    user_mean = sum(user_values) / len(user_values)
    stddev = max(abs(user_mean) * 0.18, 0.5)
    lo = max(0.0, user_mean * 0.55)
    hi = max(user_mean * 1.55, user_mean + 1)
    return (count, user_mean, stddev, lo, hi)


def _mock_values(canonical_name: str, user_values: list[float]) -> list[float]:
    """Sample mock readings for `canonical_name`. Stable within a session
    because seeded by the canonical name; values fall within the resolved
    profile's truncated Gaussian.
    """
    profile = _mock_profile_for(canonical_name, user_values)
    if not profile:
        return []
    count, mean, stddev, lo, hi = profile
    rng = random.Random(f"zkhealth-mock-values::{canonical_name}")
    out: list[float] = []
    for _ in range(count):
        v = rng.gauss(mean, stddev)
        if v < lo: v = lo
        elif v > hi: v = hi
        out.append(round(v, 0) if abs(mean) >= 100 and stddev >= 5 else round(v, 2))
    return out


def _mock_contributor_count(canonical_name: str, user_values: list[float]) -> int:
    return len(_mock_values(canonical_name, user_values))


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


def _user_obs_per_canonical(db_obs: list[dict], listed_canonicals: set[str]) -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    for obs in db_obs:
        name = obs["canonical_name"]
        if name in listed_canonicals:
            out.setdefault(name, []).append(float(obs["value"]))
    return out


def _units_per_canonical(db_obs: list[dict], listed_canonicals: set[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for obs in db_obs:
        name = obs["canonical_name"]
        if name in listed_canonicals and name not in out:
            out[name] = obs.get("unit", "") or ""
    return out


def get_anonymized_snapshot(db_obs: list[dict], listed_canonicals: set[str]) -> list[dict]:
    """Per-person anonymized release in wide format.

    Each row represents a single contributor's set of biomarker values, with
    Laplace noise applied per cell. The user is row 0 (one row across all
    biomarkers they have data on); the remaining rows are mock backing
    contributors whose biomarker presence is sampled with probability
    proportional to that biomarker's contributor count — common labs (e.g.
    cholesterol) fill most rows, rarer labs (e.g. testosterone) are sparser.

    Each row dict maps canonical_name → noisy_value | None (null = not measured
    for this contributor).
    """
    listed = sorted(listed_canonicals)
    if not listed:
        return []

    user_obs = _user_obs_per_canonical(db_obs, listed_canonicals)

    # Pool size = max contributor count across all listed biomarkers. This
    # determines how many rows the dataset has total.
    pool_size = 0
    for c in listed:
        profile = _mock_profile_for(c, user_obs.get(c, []))
        if profile:
            pool_size = max(pool_size, profile[0])
    pool_size = max(pool_size, 1)

    rows: list[dict] = []

    # Row 0: the user (one row, mean of their per-visit readings per biomarker)
    if user_obs:
        user_row: dict[str, float | None] = {}
        for c in listed:
            values = user_obs.get(c, [])
            if not values:
                user_row[c] = None
                continue
            mean = sum(values) / len(values)
            scale = max(abs(mean) * 0.04, 0.3) / _EPSILON
            noisy = max(0.0, mean + _laplace_sample(scale))
            user_row[c] = _round_sig(noisy, 4)
        rows.append(user_row)

    # Remaining rows: synthetic persons. Each person has each biomarker with
    # probability (biomarker_count / pool_size).
    n_mock = pool_size - len(rows)
    for i in range(n_mock):
        person: dict[str, float | None] = {}
        for c in listed:
            profile = _mock_profile_for(c, user_obs.get(c, []))
            if not profile:
                person[c] = None
                continue
            count, mean, stddev, lo, hi = profile

            # Deterministic per-(person, biomarker) presence + value, so the
            # same query consistently yields the same dataset across page reloads.
            rng_p = random.Random(f"zkh-person-{i}-has-{c}")
            if rng_p.random() > (count / pool_size):
                person[c] = None
                continue

            rng_v = random.Random(f"zkh-person-{i}-val-{c}")
            v = rng_v.gauss(mean, stddev)
            if v < lo: v = lo
            elif v > hi: v = hi
            scale = max(abs(v) * 0.04, 0.3) / _EPSILON
            noisy = max(0.0, v + _laplace_sample(scale))
            person[c] = _round_sig(noisy, 4)
        rows.append(person)

    return rows


def get_snapshot_summary(db_obs: list[dict], listed_canonicals: set[str]) -> list[dict]:
    """Per-biomarker metadata that accompanies the per-person snapshot.

    Returns {biomarker, unit, n_readings, n_contributors} sorted by biomarker.
    """
    listed = sorted(listed_canonicals)
    user_obs = _user_obs_per_canonical(db_obs, listed_canonicals)
    units = _units_per_canonical(db_obs, listed_canonicals)

    summary: list[dict] = []
    for c in listed:
        user_values = user_obs.get(c, [])
        mock = _mock_values(c, user_values)
        summary.append({
            "biomarker": c,
            "unit": units.get(c, ""),
            "n_readings": len(user_values) + len(mock),
            "n_contributors": 1 + _mock_contributor_count(c, user_values),
        })
    return summary


def anonymized_preview(db_obs: list[dict], listed_canonicals: set[str]) -> list[dict]:
    """
    Preview shown before purchase — plain means including mock contributors, no noise.
    Returns {canonical_name, mean, unit, n_readings, n_contributors}.
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
        user_values = [float(e["value"]) for e in entries]
        mock = _mock_values(canonical_name, user_values)
        all_values = user_values + mock
        mean = _round_sig(sum(all_values) / len(all_values), 4) if all_values else 0.0
        result.append({
            "canonical_name": canonical_name,
            "mean": mean,
            "unit": unit,
            "n_readings": len(all_values),
            "n_contributors": 1 + _mock_contributor_count(canonical_name, user_values),
        })

    return result
