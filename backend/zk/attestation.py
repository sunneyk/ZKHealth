"""Per-observation attestation: Poseidon commitment + signature.

Each numeric observation is bound to a commitment via Poseidon over
(pseudonym_id, biomarker_id, value, date_int, nonce). The commitment is then
signed so a downstream verifier can confirm the value-threshold proof refers
to a real ingested observation, not a value invented by the prover.

Production would issue Ed25519 keypairs to trusted sources (lab partners,
wearable providers); the local pipeline uses a fixed HMAC key to keep the
verification path self-contained.
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

# Shared HMAC key — symmetric with verifier.py's _MOCK_SIGNING_KEY.
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


def _poseidon_hash_many(inputs_list: list[list[int]]) -> list[str]:
    """Compute many Poseidon hashes in a SINGLE Node subprocess call.

    Node startup costs ~200ms; calling it once for N hashes instead of N
    times turns an O(N) subprocess overhead into O(1).
    """
    if not inputs_list:
        return []
    arg = json.dumps([[str(x) for x in inputs] for inputs in inputs_list])
    result = subprocess.run(
        ["node", str(_POSEIDON_BRIDGE), arg],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"poseidon batch hash failed: {result.stderr.strip()}")
    return json.loads(result.stdout.strip())


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


def attest_observations_batch(obs_list: list[dict]) -> list[dict]:
    """Attest many observations using ONE Node subprocess for all Poseidon hashes.

    Each item in `obs_list` must have keys: obs_id, canonical_name, value, date_effective.
    Returns attestation payloads in the same order.
    """
    if not obs_list:
        return []

    pseudonym_id = int(hashlib.sha256(b"zkhealth-demo-user").hexdigest()[:8], 16)

    prepped: list[dict] = []
    poseidon_inputs: list[list[int]] = []
    for o in obs_list:
        value_int = round(o["value"] * _VALUE_SCALE)
        nonce = random.randint(1, 2**31 - 1)
        biomarker_id = int(hashlib.sha256(o["canonical_name"].encode()).hexdigest()[:4], 16) % 10000
        date_int = int(o["date_effective"].replace("-", "")) if o["date_effective"] else 20260101
        prepped.append({
            "obs_id": o["obs_id"],
            "value_int": value_int,
            "nonce": nonce,
            "pseudonym_id": pseudonym_id,
            "biomarker_id": biomarker_id,
            "date_int": date_int,
        })
        poseidon_inputs.append([pseudonym_id, biomarker_id, value_int, date_int, nonce])

    commitments = _poseidon_hash_many(poseidon_inputs)
    if len(commitments) != len(prepped):
        raise RuntimeError(f"poseidon batch returned {len(commitments)} hashes, expected {len(prepped)}")

    payloads = []
    for p, commitment in zip(prepped, commitments):
        payloads.append({**p, "commitment": commitment, "signature": _mock_sign(commitment)})
    return payloads
