"""Simplified ZK verifier for ZKHealth demo."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

_CIRCUIT_DIR = Path(__file__).parent.parent.parent / "circuit"
_VKEY = _CIRCUIT_DIR / "verification_key.json"
_MOCK_SIGNING_KEY = b"zkhealth-demo-mock-signing-key-01"


def _snarkjs_bin() -> str:
    found = shutil.which("snarkjs")
    if found:
        return found
    fallback = Path.home() / ".npm-global" / "bin" / "snarkjs"
    if fallback.exists():
        return str(fallback)
    raise FileNotFoundError("snarkjs not found — run: npm install -g snarkjs")


def verify_proof(proof: dict, public_signals: list[str]) -> bool:
    vkey = json.loads(_VKEY.read_text())
    with tempfile.TemporaryDirectory(prefix="zkh_verify_") as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "vkey.json").write_text(json.dumps(vkey))
        (tmp_path / "proof.json").write_text(json.dumps(proof))
        (tmp_path / "public.json").write_text(json.dumps(public_signals))
        r = subprocess.run(
            [_snarkjs_bin(), "groth16", "verify",
             str(tmp_path / "vkey.json"),
             str(tmp_path / "public.json"),
             str(tmp_path / "proof.json")],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode == 0 and "OK" in r.stdout


def verify_signature(commitment: str, signature: str) -> bool:
    expected = hashlib.sha256(_MOCK_SIGNING_KEY + commitment.encode()).hexdigest()
    return signature == expected
