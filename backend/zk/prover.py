"""Simplified ZK prover for ZKHealth demo."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from zk.attestation import _VALUE_SCALE

_CIRCUIT_DIR = Path(__file__).parent.parent.parent / "circuit"
_ZKEY = _CIRCUIT_DIR / "threshold_attestation_final.zkey"
_WITNESS_GEN = _CIRCUIT_DIR / "threshold_attestation_js" / "generate_witness.js"
_WASM = _CIRCUIT_DIR / "threshold_attestation_js" / "threshold_attestation.wasm"


def _snarkjs_bin() -> str:
    found = shutil.which("snarkjs")
    if found:
        return found
    fallback = Path.home() / ".npm-global" / "bin" / "snarkjs"
    if fallback.exists():
        return str(fallback)
    raise FileNotFoundError("snarkjs not found — run: npm install -g snarkjs")


def generate_proof(att: dict, threshold: float, biomarker_display: str) -> dict:
    """Generate a Groth16 proof that att's value is below threshold."""
    threshold_int = round(threshold * _VALUE_SCALE)

    witness_input = {
        "value": str(att["value_int"]),
        "nonce": str(att["nonce"]),
        "pseudonym_id": str(att["pseudonym_id"]),
        "biomarker_id": str(att["biomarker_id"]),
        "threshold": str(threshold_int),
        "date_int": str(att["date_int"]),
        "commitment": att["commitment"],
    }

    proof_id = uuid.uuid4().hex

    with tempfile.TemporaryDirectory(prefix="zkh_") as tmp:
        tmp_path = Path(tmp)
        input_file = tmp_path / "input.json"
        witness_file = tmp_path / "witness.wtns"
        proof_file = tmp_path / "proof.json"
        public_file = tmp_path / "public.json"

        input_file.write_text(json.dumps(witness_input))

        r = subprocess.run(
            ["node", str(_WITNESS_GEN), str(_WASM), str(input_file), str(witness_file)],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            raise RuntimeError(f"witness generation failed: {r.stderr.strip()}")

        r = subprocess.run(
            [_snarkjs_bin(), "groth16", "prove",
             str(_ZKEY), str(witness_file), str(proof_file), str(public_file)],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            raise RuntimeError(f"proof generation failed: {r.stderr.strip()}")

        proof = json.loads(proof_file.read_text())
        public_signals = json.loads(public_file.read_text())

    passes = public_signals[0] == "1"

    return {
        "proof_id": proof_id,
        "proof": proof,
        "public_signals": public_signals,
        "passes": passes,
        "threshold_int": threshold_int,
        "date_int": att["date_int"],
        "biomarker_name": biomarker_display,
        "threshold_display": f"{threshold} {biomarker_display}",
        "signature": att["signature"],
        "commitment": att["commitment"],
    }
