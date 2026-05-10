// Compute circomlibjs Poseidon hash(es) for one or more 5-element input vectors.
//
// Usage:
//   Single mode (legacy): node _poseidon_bridge.mjs '["n1","n2","n3","n4","n5"]'
//     → stdout: a single decimal-string hash
//   Batch mode:           node _poseidon_bridge.mjs '[["n1",...],["n1",...],...]'
//     → stdout: a JSON array of decimal-string hashes
//
// Inputs MUST be JSON strings (not numbers) — JSON.parse loses precision for
// integers > 2^53, but BigInt("large_string") is exact.
import { buildPoseidon } from "circomlibjs";

const arg = JSON.parse(process.argv[2]);
const poseidon = await buildPoseidon();
const F = poseidon.F;

// Detect batch mode: an array of arrays.
const isBatch = Array.isArray(arg) && arg.length > 0 && Array.isArray(arg[0]);

if (isBatch) {
  const hashes = arg.map(inputs => F.toString(poseidon(inputs.map(BigInt))));
  process.stdout.write(JSON.stringify(hashes));
} else {
  const hash = poseidon(arg.map(BigInt));
  process.stdout.write(F.toString(hash));
}
