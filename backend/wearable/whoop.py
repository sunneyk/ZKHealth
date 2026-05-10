"""WHOOP OAuth2 integration and data sync.

Pulls daily recovery, strain, HRV, resting heart rate, and sleep metrics.
WHOOP's `offline` scope is required to receive a refresh token.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx

from . import _common as c

PROVIDER = "whoop"
LABEL = "WHOOP"
_AUTH_BASE = "https://api.prod.whoop.com/oauth/oauth2/auth"
_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
_API_BASE = "https://api.prod.whoop.com/developer"
_SCOPES = "read:recovery read:cycles read:sleep read:profile offline"


def _client_id() -> str:
    return c.cred_required(PROVIDER, "client_id", "WHOOP client ID")


def _client_secret() -> str:
    return c.cred_required(PROVIDER, "client_secret", "WHOOP client secret")


def _redirect_uri() -> str:
    return c.cred_get(PROVIDER, "redirect_uri") or "http://localhost:8000/api/wearable/whoop/callback"


def is_configured() -> bool:
    return bool(c.cred_get(PROVIDER, "client_id"))


def get_status() -> dict:
    return c.get_status_dict(PROVIDER, is_configured())


def get_auth_url() -> str:
    state = c.make_state(PROVIDER)
    return c.build_auth_url(_AUTH_BASE, {
        "response_type": "code",
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "scope": _SCOPES,
        "state": state,
    })


def exchange_code(code: str, state: str) -> None:
    c.check_state(PROVIDER, state)
    with httpx.Client() as client:
        r = client.post(
            _TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "code": code,
                "grant_type": "authorization_code",
                "client_id": _client_id(),
                "client_secret": _client_secret(),
                "redirect_uri": _redirect_uri(),
            },
        )
        r.raise_for_status()
        c.store_token(PROVIDER, r.json(), default_expires=3600)


def _access_token() -> str:
    return c.refresh_if_needed(PROVIDER, _TOKEN_URL, _client_id(), _client_secret())


def _date_only(iso: str) -> str:
    """Convert an ISO 8601 timestamp like 2026-05-07T08:13:24.000Z to 2026-05-07."""
    return iso[:10] if iso else ""


def sync_data(days: int = 7) -> dict:
    token = _access_token()
    headers = {"Authorization": f"Bearer {token}"}

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    s, e = start.date().isoformat(), end.date().isoformat()
    range_params = {
        "start": start.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "end": end.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "limit": 25,
    }

    doc_id = c.begin_sync_doc(PROVIDER, LABEL, s, e)
    specs: list[dict] = []

    def _add(date_str, canonical, value, unit):
        spec = c.save_obs_pending(doc_id, canonical, value, unit, date_str)
        if spec:
            specs.append(spec)

    with httpx.Client(base_url=_API_BASE, timeout=15.0) as client:
        r = client.get("/v1/recovery", headers=headers, params=range_params)
        if r.is_success:
            for rec in r.json().get("records", []):
                d = _date_only(rec.get("created_at", ""))
                score = rec.get("score") or {}
                _add(d, "recovery_score", score.get("recovery_score"), "%")
                _add(d, "hrv", score.get("hrv_rmssd_milli"), "ms")
                _add(d, "resting_heart_rate", score.get("resting_heart_rate"), "bpm")

        r = client.get("/v1/cycle", headers=headers, params=range_params)
        if r.is_success:
            for cyc in r.json().get("records", []):
                d = _date_only(cyc.get("start", ""))
                score = cyc.get("score") or {}
                _add(d, "strain_score", score.get("strain"), "score")

        r = client.get("/v1/activity/sleep", headers=headers, params=range_params)
        if r.is_success:
            for sleep in r.json().get("records", []):
                if sleep.get("nap"):
                    continue
                d = _date_only(sleep.get("end", ""))
                score = sleep.get("score") or {}
                stage = score.get("stage_summary") or {}
                total_ms = stage.get("total_in_bed_time_milli") or 0
                awake_ms = stage.get("total_awake_time_milli") or 0
                asleep_hours = max(0.0, (total_ms - awake_ms) / 3_600_000)
                _add(d, "sleep_hours", round(asleep_hours, 2), "h")
                _add(d, "sleep_efficiency", score.get("sleep_efficiency_percentage"), "%")

    return c.finalize_sync(PROVIDER, e, doc_id, specs, s)
