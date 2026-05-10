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
    return c.cred_required(PROVIDER, "client_id", "Oura client ID")


def _client_secret() -> str:
    return c.cred_required(PROVIDER, "client_secret", "Oura client secret")


def _redirect_uri() -> str:
    return c.cred_get(PROVIDER, "redirect_uri") or "http://localhost:8000/api/wearable/oura/callback"


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
    specs: list[dict] = []

    def _add(date_str, canonical, value, unit):
        spec = c.save_obs_pending(doc_id, canonical, value, unit, date_str)
        if spec:
            specs.append(spec)

    with httpx.Client(base_url=_API_BASE, timeout=15.0) as client:
        r = client.get("/v2/usercollection/daily_sleep", headers=headers, params=params)
        if r.is_success:
            for d in r.json().get("data", []):
                _add(d.get("day"), "sleep_score", d.get("score"), "score")

        r = client.get("/v2/usercollection/daily_readiness", headers=headers, params=params)
        if r.is_success:
            for d in r.json().get("data", []):
                _add(d.get("day"), "readiness_score", d.get("score"), "score")

        r = client.get("/v2/usercollection/daily_activity", headers=headers, params=params)
        if r.is_success:
            for d in r.json().get("data", []):
                day = d.get("day")
                _add(day, "activity_score", d.get("score"), "score")
                _add(day, "steps", d.get("steps"), "steps")
                _add(day, "active_minutes", d.get("high_activity_time"), "min")

        r = client.get("/v2/usercollection/sleep", headers=headers, params=params)
        if r.is_success:
            for sleep in r.json().get("data", []):
                day = sleep.get("day")
                rhr = sleep.get("lowest_heart_rate") or sleep.get("average_heart_rate")
                _add(day, "resting_heart_rate", rhr, "bpm")
                _add(day, "hrv", sleep.get("average_hrv"), "ms")
                total = sleep.get("total_sleep_duration") or 0
                _add(day, "sleep_hours", round(total / 3600, 2) if total else None, "h")
                spo2 = (sleep.get("spo2_percentage") or {}).get("average")
                _add(day, "spo2", spo2, "%")

    return c.finalize_sync(PROVIDER, e, doc_id, specs, s)
