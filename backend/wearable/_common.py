"""Shared OAuth2 + observation-saving helpers for wearable providers."""
from __future__ import annotations

import base64
import os
import secrets
import time
from urllib.parse import urlencode

import httpx

import db as database


def basic_auth(client_id: str, client_secret: str) -> str:
    return base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()


def env_required(key: str, label: str) -> str:
    v = os.environ.get(key, "")
    if not v:
        raise RuntimeError(f"{label} not configured ({key})")
    return v


def env_optional(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def make_state(provider: str) -> str:
    """Generate and persist an OAuth state for the given provider."""
    state = secrets.token_urlsafe(16)
    database.set_setting(f"{provider}_oauth_state", state)
    return state


def check_state(provider: str, state: str) -> None:
    stored = database.get_setting(f"{provider}_oauth_state")
    if not stored or state != stored:
        raise ValueError("OAuth state mismatch — possible CSRF")
    database.set_setting(f"{provider}_oauth_state", "")


def store_token(provider: str, token_data: dict, default_expires: int = 3600) -> None:
    database.set_setting(f"{provider}_access_token", token_data["access_token"])
    database.set_setting(f"{provider}_refresh_token", token_data.get("refresh_token", ""))
    expires_in = int(token_data.get("expires_in", default_expires))
    database.set_setting(f"{provider}_token_expires_at", str(int(time.time()) + expires_in))
    if token_data.get("user_id"):
        database.set_setting(f"{provider}_user_id", str(token_data["user_id"]))


def get_status_dict(provider: str, configured: bool) -> dict:
    access_token = database.get_setting(f"{provider}_access_token")
    connected = bool(access_token)
    return {
        "provider": provider,
        "configured": configured,
        "connected": connected,
        "user_id": database.get_setting(f"{provider}_user_id") if connected else "",
        "last_sync": database.get_setting(f"{provider}_last_sync") or "",
    }


def refresh_if_needed(
    provider: str,
    token_url: str,
    client_id: str,
    client_secret: str,
    grace_seconds: int = 300,
) -> str:
    """Return a valid access token, refreshing it via the standard OAuth2 refresh flow if expired."""
    token = database.get_setting(f"{provider}_access_token")
    if not token:
        raise RuntimeError(f"Not connected to {provider}")

    expires_at = database.get_setting(f"{provider}_token_expires_at")
    if expires_at and int(time.time()) >= int(expires_at) - grace_seconds:
        refresh = database.get_setting(f"{provider}_refresh_token")
        if not refresh:
            raise RuntimeError(f"{provider} access token expired and no refresh token available")
        with httpx.Client() as client:
            r = client.post(
                token_url,
                headers={
                    "Authorization": f"Basic {basic_auth(client_id, client_secret)}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "refresh_token", "refresh_token": refresh},
            )
            r.raise_for_status()
            tok = r.json()
        store_token(provider, tok)
        token = tok["access_token"]

    return token


def build_auth_url(base_url: str, params: dict) -> str:
    return f"{base_url}?{urlencode(params)}"


def save_synced_observation(doc_id: str, canonical: str, value: float, unit: str, date_str: str) -> int:
    """Save a single observation + auto-attestation. Returns 1 on success, 0 if value is non-positive."""
    if value is None or value <= 0:
        return 0
    from zk.attestation import attest_observation

    obs_id = database.save_observation(doc_id, canonical, float(value), unit, date_str)
    payload = attest_observation(obs_id, canonical, float(value), date_str)
    database.save_attestation(obs_id, payload)
    return 1


def begin_sync_doc(provider: str, label: str, start_str: str, end_str: str) -> str:
    """Create a document row to anchor the sync's observations."""
    return database.save_document(
        f"{provider}_{end_str}.sync",
        "wearable_csv",
        f"{label} sync: {start_str} to {end_str}",
    )


def finalize_sync(provider: str, end_str: str, doc_id: str, count: int, start_str: str) -> dict:
    database.set_setting(f"{provider}_last_sync", end_str)
    return {
        "provider": provider,
        "doc_id": doc_id,
        "synced_observations": count,
        "date_range": f"{start_str} to {end_str}",
    }
