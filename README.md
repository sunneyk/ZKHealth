# ZKHealth

**Prove health claims without revealing your data.**

ZKHealth lets you upload lab results, wearable exports, or Apple Health data, chat with an AI about your health, and generate zero-knowledge proofs that verify a health claim (e.g. "my ferritin is below 100") without exposing the underlying value. Proofs are anchored on Solana devnet for tamper-evident timestamping.

## Stack

- **Frontend**: Next.js 16, Tailwind CSS 4, `@solana/wallet-adapter-react` (Phantom)
- **Backend**: FastAPI + Python, [snarkjs](https://github.com/iden3/snarkjs) (Groth16), [circom](https://github.com/iden3/circom) circuit
- **Chain**: Solana devnet, Memo program (no PHI on-chain — only a SHA-256 hash prefix)
- **AI**: Anthropic API (prompt-cached health chat, falls back to local CLI)

---

## Quick Start

### Prerequisites

| Tool | Install |
|------|---------|
| Node.js ≥ 18 | https://nodejs.org |
| Python ≥ 3.11 | https://python.org |
| snarkjs | `npm install -g snarkjs` |
| Solana CLI (optional) | https://docs.solana.com/cli/install-solana-cli-tools |

Set `ANTHROPIC_API_KEY` in your environment for AI chat (see `.env.example`).

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

```bash
solana-keygen new --outfile ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2
```

---

## Features

- **Health chat** — upload lab PDFs, wearable CSVs, or Apple Health ZIPs and ask questions about your data
- **ZK threshold proofs** — prove a value is below, above, or within a range without revealing it (Groth16/BN254)
- **Solana anchoring** — SHA-256 hash of each proof posted as a Memo tx; no PHI on-chain
- **Proof export** — self-contained HTML verifier, works in any browser with no installs
- **Dashboard** — panel-grouped lab results with reference ranges, flags, and trend charts
- **Data marketplace** — opt-in biomarkers for sale; researchers pay SOL, receive ε-DP anonymized snapshots (Laplace mechanism, ε = 1.0)
- **Fitbit integration** — OAuth2 direct sync of steps, sleep, and heart rate

---

## How it works

```
Lab PDF / Wearable CSV / Apple Health ZIP
        │
        ▼
  FastAPI /api/upload
  pdfplumber + regex → observations saved to SQLite
        │
        ▼
  /api/zk/prove
  1. Poseidon commitment over (value, nonce, pseudonym_id, biomarker_id, date)
  2. HMAC-SHA256 mock attestation (simulates trusted lab signature)
  3. Groth16 circuit (circom) proves value < threshold (or > threshold, or in range)
     — only commitment + threshold + pass/fail bit are public
  4. SHA-256 hash of proof anchored as Solana Memo tx
        │
        ▼
  Export → self-contained HTML
  Verifier opens HTML in any browser — no installs needed
  Web Crypto API checks hash integrity
  snarkjs loaded from CDN for full Groth16 verification
```

### Circuit

`circuit/threshold_attestation.circom` — Groth16 on BN254 curve.

Public inputs: `commitment`, `threshold`, `date_int`  
Private inputs: `value`, `nonce`, `pseudonym_id`, `biomarker_id`  
Constraint: `value < threshold` (range and above-threshold claims composed from this)

---

## Demo walkthrough

1. Open http://localhost:3000
2. Upload `sample_data/sample_wearables.csv` (or any lab PDF)
3. Chat: *"What was my average HRV last week?"*
4. Go to **ZK Proofs** tab
5. Select a biomarker, choose a claim type (below / above / range), click **Generate ZK Proof**
6. Click **Export** → download the self-contained HTML verifier
7. Open the HTML in any browser — hit **Verify** to confirm the proof

---

## Project structure

```
ZKHealth/
├── backend/
│   ├── main.py          # FastAPI app
│   ├── db.py            # SQLite
│   ├── ingest.py        # PDF + CSV parsing
│   ├── llm.py           # AI chat (Anthropic API + local CLI fallback)
│   ├── market.py        # ε-DP anonymization (Laplace mechanism)
│   ├── wearable.py      # Fitbit OAuth2 + sync
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
│       ├── page.tsx          # Chat page
│       ├── dashboard/        # Lab dashboard with trend charts
│       ├── zk/               # ZK proof generation and verification
│       ├── market/           # Data marketplace
│       └── wearable/         # Fitbit connect
└── sample_data/
    └── sample_wearables.csv
```
