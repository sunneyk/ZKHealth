"""Shared OAuth2 + observation-saving helpers for wearable providers."""
from __future__ import annotations

import base64
import os
import secrets
import time
from datetime import datetime, timezone
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


# ── Provider credentials: DB-first, env-fallback ─────────────────────────────
# Users paste credentials in the UI (saved to SQLite settings); env vars remain
# as a fallback for headless/server deployments.

def cred_get(provider: str, key: str, default: str = "") -> str:
    """Resolve a credential. Reads `{provider}_cred_{key}` from settings first,
    then falls back to the matching env var (`PROVIDER_KEY` upper-cased)."""
    db_value = database.get_setting(f"{provider}_cred_{key}")
    if db_value:
        return db_value
    return os.environ.get(f"{provider.upper()}_{key.upper()}", default)


def cred_required(provider: str, key: str, label: str) -> str:
    v = cred_get(provider, key)
    if not v:
        raise RuntimeError(f"{label} not configured")
    return v


def cred_set(provider: str, key: str, value: str) -> None:
    database.set_setting(f"{provider}_cred_{key}", value.strip())


def cred_clear(provider: str) -> None:
    """Wipe all credentials + tokens for a provider."""
    for key in ("client_id", "client_secret", "redirect_uri"):
        database.set_setting(f"{provider}_cred_{key}", "")
    for key in ("access_token", "refresh_token", "user_id", "token_expires_at", "last_sync"):
        database.set_setting(f"{provider}_{key}", "")


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


def save_obs_pending(doc_id: str, canonical: str, value, unit: str, date_str: str) -> dict | None:
    """Save observation row but defer attestation. Returns spec for batch finalize, or None if value is invalid."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    obs_id = database.save_observation(doc_id, canonical, v, unit, date_str)
    return {"obs_id": obs_id, "canonical_name": canonical, "value": v, "date_effective": date_str}


def begin_sync_doc(provider: str, label: str, start_str: str, end_str: str) -> str:
    """Create a document row to anchor the sync's observations."""
    return database.save_document(
        f"{provider}_{end_str}.sync",
        "wearable_csv",
        f"{label} sync: {start_str} to {end_str}",
    )


def finalize_sync(provider: str, end_str: str, doc_id: str, specs: list, start_str: str) -> dict:
    """Batch-attest all collected specs in ONE Node call, then return the sync summary."""
    from zk.attestation import attest_observations_batch
    valid = [s for s in specs if s]
    if valid:
        payloads = attest_observations_batch(valid)
        for p in payloads:
            database.save_attestation(p["obs_id"], p)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    database.set_setting(f"{provider}_last_sync", now_iso)
    return {
        "provider": provider,
        "doc_id": doc_id,
        "synced_observations": len(valid),
        "date_range": f"{start_str} to {end_str}",
        "last_sync": now_iso,
    }
