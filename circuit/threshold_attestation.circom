pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";

/*
 * Proves that a lab value satisfies a threshold, given a Poseidon commitment
 * over the value and its attestation context.
 *
 * Private inputs (never revealed):
 *   value        — the actual lab measurement (e.g. 43 for ferritin 43 ng/mL)
 *   nonce        — random nonce used when the mock lab signed the attestation
 *   pseudonym_id — integer pseudonym for the user (from Tier-2 user_id hash)
 *   biomarker_id — canonical integer ID for the biomarker
 *
 * Public inputs (verifier sees these):
 *   threshold    — the threshold to check against (e.g. 50)
 *   date_int     — collection date as YYYYMMDD integer (e.g. 20260506)
 *   commitment   — Poseidon(pseudonym_id, biomarker_id, value, date_int, nonce)
 *
 * Output:
 *   passes       — 1 if value < threshold, 0 otherwise
 *
 * Trust model: the verifier additionally checks (outside this circuit) that
 * the commitment was signed by the mock lab keypair, binding the commitment
 * to a real ingested observation.
 */
template ThresholdAttestation() {
    signal input value;
    signal input nonce;
    signal input pseudonym_id;
    signal input biomarker_id;

    signal input threshold;
    signal input date_int;
    signal input commitment;

    signal output passes;

    // Recompute the commitment and assert it matches the public input.
    // This is the binding: the value in the proof is the same value
    // the lab signed over.
    component hasher = Poseidon(5);
    hasher.inputs[0] <== pseudonym_id;
    hasher.inputs[1] <== biomarker_id;
    hasher.inputs[2] <== value;
    hasher.inputs[3] <== date_int;
    hasher.inputs[4] <== nonce;
    hasher.out === commitment;

    // Prove value < threshold. LessThan(n) works on n-bit integers.
    // 32 bits supports lab values up to 4,294,967,295 — sufficient for
    // any value stored as an integer with 3 decimal places of precision
    // (e.g. ferritin 43.2 ng/mL stored as 43200).
    component lt = LessThan(32);
    lt.in[0] <== value;
    lt.in[1] <== threshold;
    passes <== lt.out;
}

component main {public [threshold, date_int, commitment]} = ThresholdAttestation();
