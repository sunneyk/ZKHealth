"""Oura Ring OAuth2 integration and data sync.

Pulls daily sleep score, readiness, activity score, resting heart rate,
HRV (from sleep), and SpO2.
"""
from __future__ import annotations

from datetime import date, timedelta

import httpx

from . import _common as c

PROVIDER = "oura"
LABEL = "Oura"
_AUTH_BASE = "https://cloud.ouraring.com/oauth/authorize"
_TOKEN_URL = "https://api.ouraring.com/oauth/token"
_API_BASE = "https://api.ouraring.com"
_SCOPES = "personal email daily heartrate spo2"


def _client_id() -> str:
    return c.env_required("OURA_CLIENT_ID", "Oura client ID")


def _client_secret() -> str:
    return c.env_required("OURA_CLIENT_SECRET", "Oura client secret")


def _redirect_uri() -> str:
    return c.env_optional("OURA_REDIRECT_URI", "http://localhost:8000/api/wearable/oura/callback")


def is_configured() -> bool:
    return bool(c.env_optional("OURA_CLIENT_ID"))


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
            headers={
                "Authorization": f"Basic {c.basic_auth(_client_id(), _client_secret())}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": _redirect_uri(),
            },
        )
        r.raise_for_status()
        c.store_token(PROVIDER, r.json(), default_expires=86400)


def _access_token() -> str:
    return c.refresh_if_needed(PROVIDER, _TOKEN_URL, _client_id(), _client_secret())


def sync_data(days: int = 7) -> dict:
    token = _access_token()
    headers = {"Authorization": f"Bearer {token}"}

    today = date.today()
    start = today - timedelta(days=days - 1)
    s, e = start.isoformat(), today.isoformat()
    params = {"start_date": s, "end_date": e}

    doc_id = c.begin_sync_doc(PROVIDER, LABEL, s, e)
    count = 0

    with httpx.Client(base_url=_API_BASE, timeout=15.0) as client:
        # Daily sleep — score
        r = client.get("/v2/usercollection/daily_sleep", headers=headers, params=params)
        if r.is_success:
            for d in r.json().get("data", []):
                count += c.save_synced_observation(doc_id, "sleep_score", d.get("score"), "score", d.get("day"))

        # Daily readiness
        r = client.get("/v2/usercollection/daily_readiness", headers=headers, params=params)
        if r.is_success:
            for d in r.json().get("data", []):
                count += c.save_synced_observation(doc_id, "readiness_score", d.get("score"), "score", d.get("day"))

        # Daily activity — score + steps
        r = client.get("/v2/usercollection/daily_activity", headers=headers, params=params)
        if r.is_success:
            for d in r.json().get("data", []):
                day = d.get("day")
                count += c.save_synced_observation(doc_id, "activity_score", d.get("score"), "score", day)
                count += c.save_synced_observation(doc_id, "steps", d.get("steps"), "steps", day)
                count += c.save_synced_observation(doc_id, "active_minutes", d.get("high_activity_time"), "min", day)

        # Detailed sleep — RHR, HRV, total sleep, SpO2 (if available)
        r = client.get("/v2/usercollection/sleep", headers=headers, params=params)
        if r.is_success:
            for sleep in r.json().get("data", []):
                day = sleep.get("day")
                rhr = sleep.get("lowest_heart_rate") or sleep.get("average_heart_rate")
                count += c.save_synced_observation(doc_id, "resting_heart_rate", rhr, "bpm", day)
                count += c.save_synced_observation(doc_id, "hrv", sleep.get("average_hrv"), "ms", day)
                total = sleep.get("total_sleep_duration") or 0
                count += c.save_synced_observation(doc_id, "sleep_hours", round(total / 3600, 2) if total else None, "h", day)
                spo2 = (sleep.get("spo2_percentage") or {}).get("average")
                count += c.save_synced_observation(doc_id, "spo2", spo2, "%", day)

    return c.finalize_sync(PROVIDER, e, doc_id, count, s)
