"""Post a ZK proof hash to Solana devnet as a Memo transaction.

Creates a tamper-evident on-chain timestamp without putting any PHI on-chain.
The memo contains only hb-zk:<32-hex-chars>, which is a SHA-256 prefix over
the proof data — irreversible to the underlying health claim.

HACKATHON DEMO — uses a local keypair from ~/.config/solana/id.json.
A production deployment would use a hardware wallet or custodial signer.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import subprocess
from pathlib import Path

logger = logging.getLogger("healthbot")

_KEYPAIR_PATH = Path.home() / ".config" / "solana" / "id.json"
_BRIDGE = Path(__file__).parent / "_memo_bridge.cjs"
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
