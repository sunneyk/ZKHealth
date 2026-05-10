"""Two-tier anonymization for ZKHealth.

Tier 1 (`documents` table)        — raw content as ingested. Never sent to any
                                    external service. Used only for local
                                    proof generation and direct user view.
Tier 2 (`documents_tier2` table)  — regex-scrubbed copy. This is what gets
                                    handed to Claude as chat context.

Six deterministic patterns. No NER, no LLM, no whitelists. If a pattern matches,
the span is replaced with `[REDACTED-<tag>]`.
"""
from __future__ import annotations

import re

_PATTERNS: dict[str, re.Pattern[str]] = {
    # 3-2-4 SSN. Pure shape match — does not enforce SSA area-code validity.
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    # US phone numbers in any common format.
    "phone": re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"),
    # Email addresses.
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    # Dates of birth in MM/DD/YYYY or MM-DD-YYYY format.
    "dob": re.compile(r"\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b"),
    # Labeled identifiers — anything after "Patient:", "MRN:", "Provider:", etc.
    # Greedy until newline; bounded to 60 chars to avoid swallowing whole rows.
    "labeled_id": re.compile(
        r"\b(?:Patient(?:\s+Name)?|Name|Pt|Provider|Referring|Ordering|Physician|PCP|MRN|MR\#|Account|Acct|Member\s*ID)"
        r"\s*[:#]\s*[^\n]{2,60}",
        re.IGNORECASE,
    ),
    # Street addresses (best-effort). Matches a number followed by a Title-Case
    # street name and a common suffix (St, Ave, Blvd, etc.).
    "address": re.compile(
        r"\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+"
        r"(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Pkwy|Parkway)\b",
    ),
}


def anonymize(text: str) -> tuple[str, dict[str, int]]:
    """Apply each pattern in order, replacing matches with `[REDACTED-<tag>]`.

    Returns (cleaned_text, counts) where counts maps tag → number of redactions.
    Empty input returns the empty input unchanged.
    """
    if not text:
        return text, {}
    counts: dict[str, int] = {}
    cleaned = text
    for tag, pattern in _PATTERNS.items():
        cleaned, n = pattern.subn(f"[REDACTED-{tag}]", cleaned)
        if n:
            counts[tag] = n
    return cleaned, counts


def total_redactions(counts: dict[str, int]) -> int:
    return sum(counts.values())
