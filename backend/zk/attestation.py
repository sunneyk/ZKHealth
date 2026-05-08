"""Simplified ZK attestation for ZKHealth demo.

Creates a mock Ed25519 attestation over a Poseidon commitment for each observation.
No encryption — plain SQLite storage.
"""
from __future__ import annotations

import hashlib
import json
import random
import subprocess
from pathlib import Path

_VALUE_SCALE = 1000
_CIRCUIT_DIR = Path(__file__).parent.parent.parent / "circuit"
_POSEIDON_BRIDGE = _CIRCUIT_DIR / "_poseidon_bridge.mjs"

# Deterministic mock signing key (demo only — not a real Ed25519 key)
_MOCK_SIGNING_KEY = b"zkhealth-demo-mock-signing-key-01"


def _poseidon_hash(inputs: list[int]) -> str:
    # Bridge takes a JSON array of decimal strings on argv[2]
    arg = json.dumps([str(x) for x in inputs])
    result = subprocess.run(
        ["node", str(_POSEIDON_BRIDGE), arg],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"poseidon hash failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _mock_sign(commitment: str) -> str:
    mac = hashlib.sha256(_MOCK_SIGNING_KEY + commitment.encode()).hexdigest()
    return mac


def attest_observation(obs_id: str, canonical_name: str, value: float, date_effective: str) -> dict:
    """Create a ZK attestation payload for an observation."""
    value_int = round(value * _VALUE_SCALE)
    nonce = random.randint(1, 2**31 - 1)
    pseudonym_id = int(hashlib.sha256(b"zkhealth-demo-user").hexdigest()[:8], 16)
    biomarker_id = int(hashlib.sha256(canonical_name.encode()).hexdigest()[:4], 16) % 10000

    # date_int: YYYYMMDD integer
    date_int = int(date_effective.replace("-", "")) if date_effective else 20260101

    # Order must match circuit: Poseidon(pseudonym_id, biomarker_id, value, date_int, nonce)
    commitment = _poseidon_hash([pseudonym_id, biomarker_id, value_int, date_int, nonce])
    signature = _mock_sign(commitment)

    return {
        "obs_id": obs_id,
        "value_int": value_int,
        "nonce": nonce,
        "pseudonym_id": pseudonym_id,
        "biomarker_id": biomarker_id,
        "date_int": date_int,
        "commitment": commitment,
        "signature": signature,
    }
