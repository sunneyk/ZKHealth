// Verify a Solana devnet transaction for the data marketplace.
// Usage: node payment_verify.cjs <tx_signature> <expected_recipient_pubkey> <min_lamports>
// Output: JSON to stdout: {"verified":true,"lamports":1000000,"sender":"<pubkey>"}
//                      or {"verified":false,"error":"..."}
"use strict";
const https = require("https");

const txSignature = process.argv[2];
const expectedRecipient = process.argv[3];
const minLamports = parseInt(process.argv[4], 10);

if (!txSignature || !expectedRecipient || isNaN(minLamports)) {
  process.stdout.write(JSON.stringify({ verified: false, error: "Usage: node payment_verify.cjs <tx_signature> <expected_recipient_pubkey> <min_lamports>" }));
  process.exit(0);
}

function rpcPost(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.devnet.solana.com",
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(chunks));
          } catch (e) {
            reject(new Error("Failed to parse RPC response: " + chunks));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function getTransaction(sig) {
  const resp = await rpcPost({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [
      sig,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ],
  });
  return resp.result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let result = await getTransaction(txSignature);

  // Retry once after 2s if tx not yet propagated
  if (result === null) {
    await sleep(2000);
    result = await getTransaction(txSignature);
  }

  if (result === null) {
    process.stdout.write(JSON.stringify({ verified: false, error: "Transaction not found on devnet (propagation delay or invalid signature)" }));
    return;
  }

  if (result.meta && result.meta.err) {
    process.stdout.write(JSON.stringify({ verified: false, error: "Transaction failed on-chain" }));
    return;
  }

  const instructions = result.transaction.message.instructions;

  // Find SystemProgram transfer(s) to the expected recipient and sum them.
  // Using jsonParsed encoding so we read the declared instruction amount,
  // not a balance delta (which is unreliable when sender == recipient or with fees).
  let transferLamports = 0;
  let sender = "";

  for (const ix of instructions) {
    if (
      ix.program === "system" &&
      ix.parsed &&
      ix.parsed.type === "transfer" &&
      ix.parsed.info.destination === expectedRecipient
    ) {
      transferLamports += ix.parsed.info.lamports;
      if (!sender) sender = ix.parsed.info.source;
    }
  }

  if (transferLamports === 0) {
    process.stdout.write(JSON.stringify({ verified: false, error: "No SOL transfer to the data owner wallet found in this transaction" }));
    return;
  }

  if (transferLamports >= minLamports) {
    process.stdout.write(JSON.stringify({ verified: true, lamports: transferLamports, sender }));
  } else {
    process.stdout.write(JSON.stringify({ verified: false, error: `Payment too low: transferred ${transferLamports} lamports, required ${minLamports}` }));
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ verified: false, error: String(err) }));
});
