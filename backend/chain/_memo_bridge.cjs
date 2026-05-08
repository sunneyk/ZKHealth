// Post a memo to Solana devnet using @solana/web3.js.
// Usage: node _memo_bridge.cjs <keypair_path> <memo_string>
// Output: tx signature string (base58)
"use strict";
const { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs = require("fs");

const keypairPath = process.argv[2];
const memo = process.argv[3];

if (!keypairPath || !memo) {
  process.stderr.write("Usage: node _memo_bridge.cjs <keypair_path> <memo>\n");
  process.exit(1);
}

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

async function main() {
  const keypairBytes = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
  const payer = Keypair.fromSecretKey(keypairBytes);

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  const tx = new Transaction().add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf8"),
    })
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  process.stdout.write(sig);
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
