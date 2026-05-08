"""Wearable provider integrations for ZKHealth.

Each provider module exposes:
    is_configured() -> bool
    get_status() -> dict
    get_auth_url() -> str
    exchange_code(code: str, state: str) -> None
    sync_data(days: int = 7) -> dict
"""
from . import fitbit, oura, whoop

PROVIDERS = {
    fitbit.PROVIDER: fitbit,
    whoop.PROVIDER: whoop,
    oura.PROVIDER: oura,
}


def get(provider: str):
    if provider not in PROVIDERS:
        raise KeyError(f"Unknown wearable provider: {provider}")
    return PROVIDERS[provider]


def list_status() -> list[dict]:
    return [
        {**mod.get_status(), "label": mod.LABEL}
        for mod in PROVIDERS.values()
    ]
