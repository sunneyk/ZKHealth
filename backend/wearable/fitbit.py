"""Fitbit OAuth2 integration and data sync."""
from __future__ import annotations

from datetime import date, timedelta

import httpx

from . import _common as c

PROVIDER = "fitbit"
LABEL = "Fitbit"
_AUTH_BASE = "https://www.fitbit.com/oauth2/authorize"
_TOKEN_URL = "https://api.fitbit.com/oauth2/token"
_API_BASE = "https://api.fitbit.com"
_SCOPES = "activity heartrate sleep profile"


def _client_id() -> str:
    return c.env_required("FITBIT_CLIENT_ID", "Fitbit client ID")


def _client_secret() -> str:
    return c.env_required("FITBIT_CLIENT_SECRET", "Fitbit client secret")


def _redirect_uri() -> str:
    return c.env_optional("FITBIT_REDIRECT_URI", "http://localhost:8000/api/wearable/fitbit/callback")


def is_configured() -> bool:
    return bool(c.env_optional("FITBIT_CLIENT_ID"))


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
        c.store_token(PROVIDER, r.json(), default_expires=28800)


def _access_token() -> str:
    return c.refresh_if_needed(PROVIDER, _TOKEN_URL, _client_id(), _client_secret())


def sync_data(days: int = 7) -> dict:
    token = _access_token()
    headers = {"Authorization": f"Bearer {token}"}

    today = date.today()
    start = today - timedelta(days=days - 1)
    s, e = start.isoformat(), today.isoformat()

    doc_id = c.begin_sync_doc(PROVIDER, LABEL, s, e)
    count = 0

    with httpx.Client(base_url=_API_BASE) as client:
        # Steps
        r = client.get(f"/1/user/-/activities/steps/date/{s}/{e}.json", headers=headers)
        if r.is_success:
            for item in r.json().get("activities-steps", []):
                count += c.save_synced_observation(doc_id, "steps", float(item["value"]), "steps", item["dateTime"])

        # Calories
        r = client.get(f"/1/user/-/activities/calories/date/{s}/{e}.json", headers=headers)
        if r.is_success:
            for item in r.json().get("activities-calories", []):
                count += c.save_synced_observation(doc_id, "calories_burned", float(item["value"]), "kcal", item["dateTime"])

        # Active minutes (fairly + very)
        r_fair = client.get(f"/1/user/-/activities/minutesFairlyActive/date/{s}/{e}.json", headers=headers)
        r_very = client.get(f"/1/user/-/activities/minutesVeryActive/date/{s}/{e}.json", headers=headers)
        if r_fair.is_success and r_very.is_success:
            fair_map = {x["dateTime"]: float(x["value"]) for x in r_fair.json().get("activities-minutesFairlyActive", [])}
            for item in r_very.json().get("activities-minutesVeryActive", []):
                dt = item["dateTime"]
                count += c.save_synced_observation(doc_id, "active_minutes", float(item["value"]) + fair_map.get(dt, 0.0), "min", dt)

        # Resting heart rate
        r = client.get(f"/1/user/-/activities/heart/date/{s}/{e}.json", headers=headers)
        if r.is_success:
            for item in r.json().get("activities-heart", []):
                rhr = item.get("value", {}).get("restingHeartRate")
                if rhr:
                    count += c.save_synced_observation(doc_id, "resting_heart_rate", float(rhr), "bpm", item["dateTime"])

        # Sleep (main only)
        r = client.get(f"/1.2/user/-/sleep/date/{s}/{e}.json", headers=headers)
        if r.is_success:
            for entry in r.json().get("sleep", []):
                if entry.get("isMainSleep"):
                    minutes = entry.get("minutesAsleep", 0)
                    count += c.save_synced_observation(doc_id, "sleep_hours", round(minutes / 60, 2), "h", entry["dateOfSleep"])

    return c.finalize_sync(PROVIDER, e, doc_id, count, s)
