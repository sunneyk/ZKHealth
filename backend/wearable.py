"""Fitbit OAuth2 integration and data sync for ZKHealth."""
from __future__ import annotations

import base64
import os
import secrets
import time
from datetime import date, timedelta
from urllib.parse import urlencode

import httpx

import db as database

_AUTH_BASE = "https://www.fitbit.com/oauth2/authorize"
_TOKEN_URL = "https://api.fitbit.com/oauth2/token"
_API_BASE = "https://api.fitbit.com"
_SCOPES = "activity heartrate sleep profile"


def _client_id() -> str:
    v = os.environ.get("FITBIT_CLIENT_ID", "")
    if not v:
        raise RuntimeError("FITBIT_CLIENT_ID not configured")
    return v


def _client_secret() -> str:
    v = os.environ.get("FITBIT_CLIENT_SECRET", "")
    if not v:
        raise RuntimeError("FITBIT_CLIENT_SECRET not configured")
    return v


def _redirect_uri() -> str:
    return os.environ.get("FITBIT_REDIRECT_URI", "http://localhost:8000/api/wearable/fitbit/callback")


def _basic_auth() -> str:
    return base64.b64encode(f"{_client_id()}:{_client_secret()}".encode()).decode()


def get_auth_url() -> str:
    state = secrets.token_urlsafe(16)
    database.set_setting("fitbit_oauth_state", state)
    params = urlencode({
        "response_type": "code",
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "scope": _SCOPES,
        "state": state,
    })
    return f"{_AUTH_BASE}?{params}"


def exchange_code(code: str, state: str) -> None:
    stored = database.get_setting("fitbit_oauth_state")
    if not stored or state != stored:
        raise ValueError("OAuth state mismatch — possible CSRF")

    with httpx.Client() as client:
        r = client.post(
            _TOKEN_URL,
            headers={
                "Authorization": f"Basic {_basic_auth()}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": _redirect_uri(),
            },
        )
        r.raise_for_status()
        tok = r.json()

    database.set_setting("fitbit_access_token", tok["access_token"])
    database.set_setting("fitbit_refresh_token", tok.get("refresh_token", ""))
    database.set_setting("fitbit_user_id", tok.get("user_id", ""))
    database.set_setting("fitbit_token_expires_at", str(int(time.time()) + tok.get("expires_in", 28800)))
    database.set_setting("fitbit_oauth_state", "")


def get_status() -> dict:
    access_token = database.get_setting("fitbit_access_token")
    connected = bool(access_token)
    return {
        "connected": connected,
        "user_id": database.get_setting("fitbit_user_id") if connected else "",
        "last_sync": database.get_setting("fitbit_last_sync") or "",
        "configured": bool(os.environ.get("FITBIT_CLIENT_ID")),
    }


def _get_valid_token() -> str:
    token = database.get_setting("fitbit_access_token")
    if not token:
        raise RuntimeError("Not connected to Fitbit")

    expires_at = database.get_setting("fitbit_token_expires_at")
    if expires_at and int(time.time()) >= int(expires_at) - 300:
        refresh = database.get_setting("fitbit_refresh_token")
        with httpx.Client() as client:
            r = client.post(
                _TOKEN_URL,
                headers={
                    "Authorization": f"Basic {_basic_auth()}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "refresh_token", "refresh_token": refresh},
            )
            r.raise_for_status()
            tok = r.json()
        token = tok["access_token"]
        database.set_setting("fitbit_access_token", token)
        database.set_setting("fitbit_refresh_token", tok.get("refresh_token", ""))
        database.set_setting("fitbit_token_expires_at", str(int(time.time()) + tok.get("expires_in", 28800)))

    return token


def sync_data(days: int = 7) -> dict:
    """Fetch the last `days` of Fitbit data and save as wearable observations."""
    from zk.attestation import attest_observation

    token = _get_valid_token()
    headers = {"Authorization": f"Bearer {token}"}

    today = date.today()
    start = today - timedelta(days=days - 1)
    start_str, today_str = start.isoformat(), today.isoformat()

    # Create a document entry for this sync
    doc_id = database.save_document(
        f"fitbit_{today_str}.sync",
        "wearable_csv",
        f"Fitbit sync: {start_str} to {today_str}",
    )

    obs_count = 0

    def _save(date_str: str, canonical: str, value: float, unit: str) -> None:
        nonlocal obs_count
        if value <= 0:
            return
        obs_id = database.save_observation(doc_id, canonical, value, unit, date_str)
        payload = attest_observation(obs_id, canonical, value, date_str)
        database.save_attestation(obs_id, payload)
        obs_count += 1

    with httpx.Client(base_url=_API_BASE) as client:
        # Steps
        r = client.get(f"/1/user/-/activities/steps/date/{start_str}/{today_str}.json", headers=headers)
        if r.is_success:
            for item in r.json().get("activities-steps", []):
                _save(item["dateTime"], "steps", float(item["value"]), "steps")

        # Calories burned
        r = client.get(f"/1/user/-/activities/calories/date/{start_str}/{today_str}.json", headers=headers)
        if r.is_success:
            for item in r.json().get("activities-calories", []):
                _save(item["dateTime"], "calories_burned", float(item["value"]), "kcal")

        # Active minutes (fairly + very active)
        r_fair = client.get(f"/1/user/-/activities/minutesFairlyActive/date/{start_str}/{today_str}.json", headers=headers)
        r_very = client.get(f"/1/user/-/activities/minutesVeryActive/date/{start_str}/{today_str}.json", headers=headers)
        if r_fair.is_success and r_very.is_success:
            fair_map = {x["dateTime"]: float(x["value"]) for x in r_fair.json().get("activities-minutesFairlyActive", [])}
            for item in r_very.json().get("activities-minutesVeryActive", []):
                dt = item["dateTime"]
                total = float(item["value"]) + fair_map.get(dt, 0.0)
                _save(dt, "active_minutes", total, "min")

        # Resting heart rate
        r = client.get(f"/1/user/-/activities/heart/date/{start_str}/{today_str}.json", headers=headers)
        if r.is_success:
            for item in r.json().get("activities-heart", []):
                rhr = item.get("value", {}).get("restingHeartRate")
                if rhr:
                    _save(item["dateTime"], "resting_heart_rate", float(rhr), "bpm")

        # Sleep (main sleep only)
        r = client.get(f"/1.2/user/-/sleep/date/{start_str}/{today_str}.json", headers=headers)
        if r.is_success:
            for entry in r.json().get("sleep", []):
                if entry.get("isMainSleep"):
                    minutes = entry.get("minutesAsleep", 0)
                    _save(entry["dateOfSleep"], "sleep_hours", round(minutes / 60, 2), "h")

    database.set_setting("fitbit_last_sync", today_str)
    return {
        "doc_id": doc_id,
        "synced_observations": obs_count,
        "date_range": f"{start_str} to {today_str}",
    }
