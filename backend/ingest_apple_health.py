"""Apple Health export.zip parser.

Reads `export.xml` from the user's Apple Health export, aggregates per-record
samples to daily values, and returns observations in the same shape as the
PDF and CSV ingestors.
"""
from __future__ import annotations

import io
import zipfile
from collections import defaultdict
from datetime import datetime

import defusedxml.ElementTree as ET

# HealthKit quantity types → (canonical_name, unit, aggregation)
# aggregation: "sum" for cumulative metrics, "mean" for rate/level metrics
_QUANTITY_TYPES: dict[str, tuple[str, str, str]] = {
    "HKQuantityTypeIdentifierHeartRate":                    ("heart_rate",         "bpm",       "mean"),
    "HKQuantityTypeIdentifierRestingHeartRate":             ("resting_heart_rate", "bpm",       "mean"),
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN":     ("hrv",                "ms",        "mean"),
    "HKQuantityTypeIdentifierBloodPressureSystolic":        ("bp_systolic",        "mmHg",      "mean"),
    "HKQuantityTypeIdentifierBloodPressureDiastolic":       ("bp_diastolic",       "mmHg",      "mean"),
    "HKQuantityTypeIdentifierBodyMass":                     ("weight",             "kg",        "mean"),
    "HKQuantityTypeIdentifierStepCount":                    ("steps",              "steps",     "sum"),
    "HKQuantityTypeIdentifierActiveEnergyBurned":           ("active_calories",    "kcal",      "sum"),
    "HKQuantityTypeIdentifierOxygenSaturation":             ("spo2",               "%",         "mean"),
    "HKQuantityTypeIdentifierBodyTemperature":              ("body_temperature",   "°C",        "mean"),
    "HKQuantityTypeIdentifierBloodGlucose":                 ("blood_glucose",      "mg/dL",     "mean"),
    "HKQuantityTypeIdentifierVO2Max":                       ("vo2_max",            "mL/min/kg", "mean"),
    "HKQuantityTypeIdentifierBodyFatPercentage":            ("body_fat_pct",       "%",         "mean"),
    "HKQuantityTypeIdentifierBodyMassIndex":                ("bmi",                "",          "mean"),
    "HKQuantityTypeIdentifierAppleExerciseTime":            ("exercise_minutes",   "min",       "sum"),
    "HKQuantityTypeIdentifierFlightsClimbed":               ("flights_climbed",    "floors",    "sum"),
    "HKQuantityTypeIdentifierDistanceWalkingRunning":       ("distance",           "km",        "sum"),
    "HKQuantityTypeIdentifierBasalEnergyBurned":            ("basal_calories",     "kcal",      "sum"),
    "HKQuantityTypeIdentifierRespiratoryRate":              ("respiratory_rate",   "bpm",       "mean"),
    "HKQuantityTypeIdentifierWalkingHeartRateAverage":      ("walking_hr_avg",     "bpm",       "mean"),
}

# Sleep stage values that count as actual sleep (not "InBed" or "Awake")
_SLEEP_ASLEEP_VALUES = {"1", "3", "4", "5"}  # Asleep, AsleepCore, AsleepDeep, AsleepREM


def _parse_date(date_str: str) -> datetime | None:
    if not date_str:
        return None
    normalized = date_str.strip()
    if len(normalized) > 19 and normalized[10] == " ":
        normalized = normalized[:10] + "T" + normalized[11:]
        if len(normalized) > 19 and normalized[19] == " ":
            normalized = normalized[:19] + normalized[20:]
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


def parse_apple_health_zip(zip_bytes: bytes) -> tuple[str, list[dict]]:
    """Parse Apple Health export ZIP. Returns (summary_text, daily_observations).

    Aggregates all records to daily values. Each observation dict has:
        canonical_name, value (float), unit, date_effective (YYYY-MM-DD)
    """
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        xml_name = next((n for n in zf.namelist() if n.endswith("export.xml")), None)
        if not xml_name:
            raise ValueError("No export.xml found in ZIP — export from Health app and try again.")
        xml_bytes = zf.read(xml_name)

    # daily_values[canonical_name][date] = list of floats
    daily_values: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    daily_agg: dict[str, str] = {}  # canonical_name → "sum"|"mean"
    daily_units: dict[str, str] = {}

    # daily_sleep[date] = total asleep seconds
    daily_sleep: dict[str, float] = defaultdict(float)

    context = ET.iterparse(io.BytesIO(xml_bytes), events=("end",))
    for _, elem in context:
        if elem.tag == "Record":
            rtype = elem.get("type", "")

            if rtype in _QUANTITY_TYPES:
                canonical, unit, agg = _QUANTITY_TYPES[rtype]
                val_str = elem.get("value", "")
                start_date = elem.get("startDate", "")
                if not val_str or not start_date:
                    elem.clear()
                    continue
                ts = _parse_date(start_date)
                if not ts:
                    elem.clear()
                    continue
                try:
                    val = float(val_str)
                except ValueError:
                    elem.clear()
                    continue
                date_key = ts.strftime("%Y-%m-%d")
                daily_values[canonical][date_key].append(val)
                daily_agg[canonical] = agg
                daily_units[canonical] = unit

            elif rtype == "HKCategoryTypeIdentifierSleepAnalysis":
                value_str = elem.get("value", "")
                if value_str not in _SLEEP_ASLEEP_VALUES:
                    elem.clear()
                    continue
                start_str = elem.get("startDate", "")
                end_str = elem.get("endDate", "")
                ts_start = _parse_date(start_str)
                ts_end = _parse_date(end_str)
                if ts_start and ts_end:
                    dur_secs = (ts_end - ts_start).total_seconds()
                    if dur_secs > 0:
                        date_key = ts_start.strftime("%Y-%m-%d")
                        daily_sleep[date_key] += dur_secs

        elem.clear()

    # Add sleep_hours from sleep analysis
    for date_key, total_secs in daily_sleep.items():
        hours = round(total_secs / 3600, 2)
        daily_values["sleep_hours"][date_key].append(hours)
        daily_agg["sleep_hours"] = "sum"
        daily_units["sleep_hours"] = "h"

    # Flatten to per-day observations
    observations: list[dict] = []
    for canonical, by_date in daily_values.items():
        agg = daily_agg.get(canonical, "mean")
        unit = daily_units.get(canonical, "")
        for date_key, values in sorted(by_date.items()):
            if not values:
                continue
            if agg == "sum":
                agg_val = sum(values)
            else:
                agg_val = sum(values) / len(values)
            observations.append({
                "canonical_name": canonical,
                "value": round(agg_val, 3),
                "unit": unit,
                "date_effective": date_key,
            })

    # Build summary for LLM context
    type_counts: dict[str, int] = defaultdict(int)
    for obs in observations:
        type_counts[obs["canonical_name"]] += 1
    date_range = ""
    all_dates = [o["date_effective"] for o in observations]
    if all_dates:
        date_range = f"{min(all_dates)} to {max(all_dates)}"

    lines = [f"Apple Health data ({len(observations)} daily observations, {date_range})"]
    for name, count in sorted(type_counts.items()):
        lines.append(f"  {name}: {count} days")
    # Sample recent values for key metrics
    key_metrics = ["hrv", "resting_heart_rate", "steps", "sleep_hours", "spo2"]
    recent: list[dict] = sorted(
        [o for o in observations if o["canonical_name"] in key_metrics],
        key=lambda x: x["date_effective"],
        reverse=True,
    )[:15]
    if recent:
        lines.append("Recent values (newest first):")
        for o in recent:
            lines.append(f"  {o['date_effective']} {o['canonical_name']}: {o['value']} {o['unit']}")

    return "\n".join(lines), observations
