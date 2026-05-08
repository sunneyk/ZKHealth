"""AI chat wrapper — uses Anthropic SDK with prompt caching when ANTHROPIC_API_KEY is set,
falls back to the local AI CLI otherwise."""
from __future__ import annotations

import os
import subprocess


_SYSTEM_PREFIX = (
    "You are a personal health assistant. The user has uploaded their health data below. "
    "Answer questions about their data helpfully and accurately. "
    "Never diagnose or prescribe — always recommend consulting a licensed healthcare provider "
    "for medical decisions. Cite patterns and observations, not diagnoses.\n\n"
    "=== USER HEALTH DATA ===\n"
)


def chat(user_message: str, health_context: str) -> str:
    """Send a message to the AI with health data as context. Returns the response text."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if api_key:
        return _chat_sdk(user_message, health_context)
    return _chat_cli(user_message, health_context)


def _chat_sdk(user_message: str, health_context: str) -> str:
    """Anthropic SDK path — uses ephemeral cache on the health context block."""
    import anthropic

    client = anthropic.Anthropic()
    system_text = _SYSTEM_PREFIX + (health_context.strip() if health_context.strip() else "No health data uploaded yet.")

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": system_text,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )
    return response.content[0].text


def _chat_cli(user_message: str, health_context: str) -> str:
    """Fallback: call the local AI CLI via subprocess."""
    import shutil

    claude_bin = shutil.which("claude")
    if not claude_bin:
        raise FileNotFoundError("AI CLI not found — set ANTHROPIC_API_KEY to use the SDK instead")

    system_text = _SYSTEM_PREFIX + (health_context.strip() if health_context.strip() else "No health data uploaded yet.")
    full_prompt = f"{system_text}\n\n=== USER QUESTION ===\n{user_message}"

    result = subprocess.run(
        [claude_bin, "--print", full_prompt],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Claude CLI returned non-zero exit")
    return result.stdout.strip()
