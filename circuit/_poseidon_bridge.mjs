// Compute circomlibjs Poseidon hash for a fixed 5-element input vector.
// Usage: node _poseidon_bridge.mjs '["n1","n2","n3","n4","n5"]'
// Inputs MUST be JSON strings (not numbers) — JSON.parse loses precision for
// integers > 2^53, but BigInt("large_string") is exact.
// Output: decimal string of the field element result.
import { buildPoseidon } from "circomlibjs";
const inputs = JSON.parse(process.argv[2]);   // array of decimal strings
const poseidon = await buildPoseidon();
const F = poseidon.F;
const hash = poseidon(inputs.map(BigInt));    // BigInt("string") is always exact
process.stdout.write(F.toString(hash));
