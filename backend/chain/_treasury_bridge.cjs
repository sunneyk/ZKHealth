// Treasury wallet bridge for the ZKHealth marketplace.
//
// The treasury keypair receives buyer payments and signs release transfers
// to data-owner / contributor wallets. Mirrors the on-chain `pay` + `release`
// flow defined by the `zkhealth_split` Anchor program.
//
// Usage:
//   node _treasury_bridge.cjs pubkey <keypair_path>
//     → stdout: base58 pubkey of the keypair
//   node _treasury_bridge.cjs release <keypair_path> <recipient_pubkey> <lamports>
//     → stdout: base58 tx signature
"use strict";
const {
  Connection, Keypair, Transaction, SystemProgram, PublicKey, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const fs = require("fs");

const command = process.argv[2];
const keypairPath = process.argv[3];

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

if (!command || !keypairPath) {
  die("Usage: node _treasury_bridge.cjs <pubkey|release> <keypair_path> [<recipient> <lamports>]");
}

let kp;
try {
  const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
  kp = Keypair.fromSecretKey(bytes);
} catch (err) {
  die("Failed to load keypair: " + String(err));
}

if (command === "pubkey") {
  process.stdout.write(kp.publicKey.toBase58());
  process.exit(0);
}

if (command === "release") {
  const recipient = process.argv[4];
  const lamports = parseInt(process.argv[5], 10);
  if (!recipient || isNaN(lamports) || lamports <= 0) {
    die("Usage: node _treasury_bridge.cjs release <keypair_path> <recipient_pubkey> <lamports>");
  }

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: new PublicKey(recipient),
      lamports,
    })
  );

  sendAndConfirmTransaction(connection, tx, [kp])
    .then((sig) => { process.stdout.write(sig); })
    .catch((err) => die(String(err)));
} else {
  die("Unknown command: " + command);
}
