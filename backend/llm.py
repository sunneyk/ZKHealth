"""Claude CLI wrapper for ZKHealth demo."""
from __future__ import annotations

import subprocess


def _claude_bin() -> str:
    import shutil
    found = shutil.which("claude")
    if found:
        return found
    raise FileNotFoundError("claude CLI not found — install from https://claude.ai/code")


def chat(user_message: str, health_context: str) -> str:
    """Send a message to Claude with health data as context. Returns the response."""
    system = (
        "You are a personal health assistant. The user has uploaded their health data below. "
        "Answer questions about their data helpfully and accurately. "
        "Never diagnose or prescribe — always recommend consulting a licensed healthcare provider "
        "for medical decisions. Cite patterns and observations, not diagnoses.\n\n"
        "=== USER HEALTH DATA ===\n"
        + (health_context if health_context.strip() else "No health data uploaded yet.")
    )

    full_prompt = f"{system}\n\n=== USER QUESTION ===\n{user_message}"

    result = subprocess.run(
        [_claude_bin(), "--print", full_prompt],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Claude CLI returned non-zero exit")
    return result.stdout.strip()
