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


def parse_lab_observations(text: str) -> list[dict]:
    """Extract numeric lab results from PDF text. Returns list of {name, value, unit, date}."""
    observations = []

    # Pattern: "Ferritin 43.2 ng/mL" or "Ferritin: 43.2 ng/mL"
    pattern = re.compile(
        r"([A-Za-z][A-Za-z0-9 \-/()]{2,40}?)\s*:?\s*([0-9]+\.?[0-9]*)\s*([a-zA-Z/%µ][a-zA-Z0-9/%µ·]*)?",
        re.MULTILINE,
    )

    # Try to find a date in the document
    date_match = re.search(r"(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4})", text)
    doc_date = ""
    if date_match:
        raw = date_match.group(1).replace("/", "-")
        parts = raw.split("-")
        if len(parts[0]) == 4:
            doc_date = raw
        else:
            doc_date = f"{parts[2]}-{parts[1]}-{parts[0]}"

    seen = set()
    for m in pattern.finditer(text):
        name = m.group(1).strip().lower().replace(" ", "_")
        value_str = m.group(2)
        unit = (m.group(3) or "").strip()

        # Skip obviously non-lab lines
        if len(name) < 3 or name in seen:
            continue
        if any(skip in name for skip in ["page", "date", "time", "name", "address", "phone"]):
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
            "date_effective": doc_date,
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
