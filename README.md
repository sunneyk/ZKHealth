# ZKHealth

**Prove health claims without revealing your data.**

ZKHealth lets you upload lab results or wearable CSVs, chat with an AI about your data, and generate zero-knowledge proofs that verify a health claim (e.g. "my ferritin is below 100") without exposing the underlying value. Proofs are anchored on Solana devnet for tamper-evident timestamping.

## Stack

- **Frontend**: Next.js 15, Tailwind CSS, `@solana/wallet-adapter-react` (Phantom)
- **Backend**: FastAPI + Python, [snarkjs](https://github.com/iden3/snarkjs) (Groth16), [circom](https://github.com/iden3/circom) circuit
- **Chain**: Solana devnet, Memo program (no PHI on-chain — only a SHA-256 hash prefix)
- **AI**: Claude CLI (no API key needed)

---

## Quick Start (judges)

### Prerequisites

| Tool | Install |
|------|---------|
| Node.js ≥ 18 | https://nodejs.org |
| Python ≥ 3.11 | https://python.org |
| Claude CLI | `npm install -g @anthropic-ai/claude-code` then `claude` to log in |
| snarkjs | `npm install -g snarkjs` |
| Solana CLI (optional, for on-chain anchoring) | https://docs.solana.com/cli/install-solana-cli-tools |

### 1 — Backend

```bash
cd ZKHealth
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
```

### 2 — Frontend

```bash
cd ZKHealth/frontend
npm install
npm run dev
# → http://localhost:3000
```

### 3 — (Optional) Solana devnet keypair

If you want on-chain anchoring, generate a free devnet keypair and airdrop SOL:

```bash
solana-keygen new --outfile ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2
```

If you skip this step, proof generation still works — the "Anchor on Solana devnet" checkbox will be unchecked by default and the proof anchoring step is skipped.

---

## How it works

```
Lab PDF / Wearable CSV
        │
        ▼
  FastAPI /api/upload
  pdfplumber + regex → observations saved to SQLite
        │
        ▼
  /api/zk/prove
  1. Poseidon commitment over (value, salt)
  2. HMAC-SHA256 mock attestation (simulates trusted lab signature)
  3. Groth16 circuit (circom) proves value < threshold
     — only commitment + threshold + pass/fail bit are public
  4. SHA-256 hash of proof anchored as Solana Memo tx
        │
        ▼
  Export → self-contained HTML
  Verifier (provider/judge) opens HTML in any browser — no installs
  Web Crypto API checks hash integrity
  Optional: snarkjs loaded from CDN for full Groth16 verification
```

### Circuit

`circuit/threshold_attestation.circom` — Groth16 on BN254 curve.

Public inputs: `commitment`, `threshold`, `date_int`  
Private inputs: `value`, `salt`  
Constraint: `value < threshold`

---

## Demo walkthrough

1. Open http://localhost:3000
2. Upload `sample_data/sample_wearables.csv` (or any lab PDF)
3. Chat: *"What was my average HRV last week?"*
4. Go to **ZK Proofs** tab
5. Select a lab result, set a threshold (e.g. ferritin < 100), click **Generate ZK Proof**
6. Click **Export** → download the self-contained HTML verifier
7. Open the HTML in any browser — hit **Verify** to confirm the proof

---

## Project structure

```
ZKHealth/
├── backend/
│   ├── main.py          # FastAPI app
│   ├── db.py            # SQLite (plain, no encryption — demo only)
│   ├── ingest.py        # PDF + CSV parsing
│   ├── llm.py           # Claude CLI wrapper
│   ├── chain/
│   │   ├── solana_anchor.py   # Solana devnet Memo anchoring
│   │   └── _memo_bridge.cjs   # Node.js Solana web3 bridge
│   └── zk/
│       ├── attestation.py     # Poseidon commitment + mock signing
│       ├── prover.py          # Groth16 proof generation
│       ├── verifier.py        # snarkjs verification
│       └── html_export.py     # Self-contained HTML builder
├── circuit/
│   ├── threshold_attestation.circom
│   ├── threshold_attestation_final.zkey
│   ├── verification_key.json
│   └── threshold_attestation_js/   # .wasm + witness calculator
├── frontend/            # Next.js app
│   └── app/
│       ├── page.tsx     # Chat page
│       └── zk/page.tsx  # ZK Proofs page
└── sample_data/
    └── sample_wearables.csv
```
