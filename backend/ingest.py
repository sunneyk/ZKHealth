"""Document ingestion: PDF lab reports and wearable CSV files."""
from __future__ import annotations

import csv
import io
import re


def extract_pdf_text(file_bytes: bytes) -> str:
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            return "\n".join(page.extract_text() or "" for page in pdf.pages)
    except Exception as e:
        raise RuntimeError(f"PDF extraction failed: {e}") from e


# Name and value must be separated by at least one whitespace or a colon. This
# prevents the non-greedy quantifier from truncating "HbA1c" → "HbA" with
# value=1, or "Vitamin B12" → "Vitamin B" with value=12.
_BIOMARKER_PATTERN = re.compile(
    r"([A-Za-z][A-Za-z0-9 \-/()]{2,40}?)[:\s]\s*([0-9]+\.?[0-9]*)\s*([a-zA-Z/%µ][a-zA-Z0-9/%µ·]*)?",
    re.MULTILINE,
)

# Visit-marker patterns: anything that delimits a new lab visit's section.
_VISIT_MARKER = re.compile(
    r"(?:Specimen\s+Collected|Collection\s+Date|Visit\s+Date|Date\s+of\s+Service|Collected|Drawn)\s*[:#]?\s*"
    r"((?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}/\d{1,2}/\d{4})|(?:[A-Z][a-z]+\s+\d{1,2},\s*\d{4}))",
    re.IGNORECASE,
)
_GENERIC_DATE = re.compile(r"(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4})")
_MONTH_NAMES = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}


def _normalize_date(raw: str) -> str:
    """Coerce a date string in any of the supported formats to YYYY-MM-DD."""
    raw = raw.strip()
    # ISO already
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return raw
    # MM/DD/YYYY or DD/MM/YYYY — assume US (MM/DD)
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", raw)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    # "Month DD, YYYY"
    m = re.match(r"^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$", raw)
    if m and m.group(1).lower() in _MONTH_NAMES:
        return f"{m.group(3)}-{_MONTH_NAMES[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    return raw


def _split_visits(text: str) -> list[tuple[str, str]]:
    """Split the document into (visit_date, section_text) pairs.

    If two or more visit markers are found, the document is sliced into
    per-visit sections. Otherwise the whole document becomes a single section
    dated by the first standalone date match (legacy single-visit behavior).
    """
    matches = list(_VISIT_MARKER.finditer(text))
    if len(matches) >= 2:
        sections: list[tuple[str, str]] = []
        for i, m in enumerate(matches):
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            sections.append((_normalize_date(m.group(1)), text[start:end]))
        return sections

    # Single-visit fallback: try a marker first, otherwise any date in the text
    if matches:
        return [(_normalize_date(matches[0].group(1)), text)]
    fallback = _GENERIC_DATE.search(text)
    if fallback:
        return [(_normalize_date(fallback.group(1)), text)]
    return [("", text)]


def parse_lab_observations(text: str) -> list[dict]:
    """Extract numeric lab results from PDF text.

    Multi-visit aware: detects "Specimen Collected", "Collection Date", etc.
    and emits one observation per (biomarker, visit) pair. Within a single
    visit's section, repeated biomarker names are deduplicated.
    """
    observations: list[dict] = []
    for visit_date, section in _split_visits(text):
        seen: set[str] = set()
        for m in _BIOMARKER_PATTERN.finditer(section):
            name = m.group(1).strip().lower().replace(" ", "_")
            value_str = m.group(2)
            unit = (m.group(3) or "").strip()

            if len(name) < 3 or name in seen:
                continue
            # Reject patient-header fields and other non-biomarker labels that
            # happen to have a number after them.
            if any(skip in name for skip in (
                "page", "date", "time", "name", "address", "phone",
                "account", "mrn", "dob", "patient", "provider", "sex",
                "email", "ordering", "specimen", "collected", "collection",
                "ref", "range", "flag", "drawn", "visit",
            )):
                continue
            # Reject obvious unit strings that got captured as names
            # (e.g. "ng/dL", "pg/mL", "mg/dL") — biomarkers never contain "/".
            if "/" in name:
                continue
            try:
                value = float(value_str)
            except ValueError:
                continue

            seen.add(name)
            observations.append({
                "canonical_name": name,
                "value": value,
                "unit": unit,
                "date_effective": visit_date,
            })
    return observations


def parse_wearable_csv(file_bytes: bytes) -> tuple[str, list[dict]]:
    """Parse a wearable CSV. Returns (plain text summary, list of row dicts)."""
    text = file_bytes.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return "Empty CSV file.", []

    # Build a plain text summary for the LLM
    lines = [f"Wearable data ({len(rows)} rows), columns: {', '.join(rows[0].keys())}"]
    for row in rows[:5]:
        lines.append("  " + ", ".join(f"{k}={v}" for k, v in row.items()))
    if len(rows) > 5:
        lines.append(f"  ... and {len(rows) - 5} more rows")

    return "\n".join(lines), rows
