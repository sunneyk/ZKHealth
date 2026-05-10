"""Solana on-chain operations for ZKHealth.

Two responsibilities:
  1. Anchor proof hashes as Memo transactions for tamper-evident timestamping.
     The memo contains only hb-zk:<32-hex-chars> — a SHA-256 prefix over the
     proof data, irreversible to the underlying health claim.
  2. Run the marketplace treasury: hold escrowed buyer payments and sign
     atomic release transfers to contributor wallets.

Authority keypairs are loaded from disk paths configured via env vars
(SOLANA_KEYPAIR_PATH, TREASURY_KEYPAIR_PATH). Hosted deployments back these
with a KMS/HSM signer rather than a local file.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import subprocess
from pathlib import Path

logger = logging.getLogger("healthbot")

import os

_KEYPAIR_PATH = Path(os.environ.get("SOLANA_KEYPAIR_PATH", "")) or Path.home() / ".config" / "solana" / "id.json"
_TREASURY_KEYPAIR_PATH = Path(os.environ.get("TREASURY_KEYPAIR_PATH", "")) or _KEYPAIR_PATH
_BRIDGE = Path(__file__).parent / "_memo_bridge.cjs"
_TREASURY_BRIDGE = Path(__file__).parent / "_treasury_bridge.cjs"
_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58decode(s: str) -> bytes:
    n = 0
    for char in s:
        n = n * 58 + _BASE58_ALPHABET.index(char)
    pad = sum(1 for c in s if c == "1")
    result: list[int] = []
    while n > 0:
        n, rem = divmod(n, 256)
        result.append(rem)
    return bytes([0] * pad + result[::-1])


def _compact_u16(n: int) -> bytes:
    """Solana wire-format compact-u16 encoding."""
    if n < 0x80:
        return bytes([n])
    if n < 0x4000:
        return bytes([(n & 0x7F) | 0x80, n >> 7])
    return bytes([(n & 0x7F) | 0x80, ((n >> 7) & 0x7F) | 0x80, n >> 14])


def proof_memo(proof: dict, public_signals: list[str]) -> str:
    """Derive a non-reversible 40-char memo string from proof content."""
    digest = hashlib.sha256(
        json.dumps(
            {"proof": proof, "public_signals": public_signals},
            sort_keys=True,
        ).encode()
    ).hexdigest()[:32]
    return f"hb-zk:{digest}"


def _run_bridge(memo: str) -> str:
    """Call the Node.js memo bridge synchronously; return tx signature."""
    result = subprocess.run(
        ["node", str(_BRIDGE), str(_KEYPAIR_PATH), memo],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"memo bridge: {result.stderr.strip()}")
    return result.stdout.strip()


async def anchor_proof(proof: dict, public_signals: list[str]) -> str:
    """Post a proof hash memo to Solana devnet. Returns the tx signature string."""
    memo = proof_memo(proof, public_signals)
    tx_sig = await asyncio.to_thread(_run_bridge, memo)
    logger.info("ZK proof anchored on Solana devnet tx=%s memo=%s", tx_sig, memo)
    return tx_sig


# ── Treasury operations (production payment-split architecture) ──────────────


_treasury_pubkey_cache: str | None = None


def get_treasury_pubkey() -> str:
    """Return the treasury wallet's base58 pubkey. Cached after first call."""
    global _treasury_pubkey_cache
    if _treasury_pubkey_cache:
        return _treasury_pubkey_cache
    if not _TREASURY_KEYPAIR_PATH.exists():
        raise RuntimeError(f"Treasury keypair not found at {_TREASURY_KEYPAIR_PATH}. Run `solana-keygen new -o {_TREASURY_KEYPAIR_PATH}` and fund it.")
    result = subprocess.run(
        ["node", str(_TREASURY_BRIDGE), "pubkey", str(_TREASURY_KEYPAIR_PATH)],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError(f"treasury bridge: {result.stderr.strip()}")
    _treasury_pubkey_cache = result.stdout.strip()
    return _treasury_pubkey_cache


def _run_release(recipient_pubkey: str, lamports: int) -> str:
    result = subprocess.run(
        ["node", str(_TREASURY_BRIDGE), "release", str(_TREASURY_KEYPAIR_PATH), recipient_pubkey, str(lamports)],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"treasury release: {result.stderr.strip()}")
    return result.stdout.strip()


async def release_to(recipient_pubkey: str, lamports: int) -> str:
    """Sign a SOL transfer from the treasury keypair to `recipient_pubkey`.
    Returns the on-chain tx signature.
    """
    return await asyncio.to_thread(_run_release, recipient_pubkey, lamports)
