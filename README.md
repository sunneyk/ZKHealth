# ZKHealth

> Prove a health claim. Reveal nothing else.

ZKHealth is a local-first web application for understanding and selectively sharing your medical and wearable data. Lab PDFs, wearable exports, and direct OAuth syncs from Fitbit / WHOOP / Oura flow into a single dashboard that lives on your device. When sharing matters, ZKHealth turns each fact about your data into a zero-knowledge proof — verifiable in any browser, anchored on Solana, and revealing nothing about the underlying value.

A research marketplace lets you opt biomarkers into queryable aggregates. Buyers pay through a per-query escrow program; payouts are split atomically across contributors. Every release is calibrated to a formal differential-privacy guarantee.

---

## Architecture

| Layer | Stack |
|---|---|
| Frontend | Next.js 16 (App Router, Turbopack) · React 19 · Tailwind CSS 4 · `@solana/wallet-adapter` |
| Backend | FastAPI · SQLite · Python 3.11+ |
| ZK | circom 2 · snarkjs · Groth16 over BN254 · Poseidon hash |
| On-chain | Solana devnet · Memo program (proof anchoring) · Anchor program for marketplace escrow |
| AI | Anthropic SDK with ephemeral prompt caching (CLI fallback when no key is set) |
| Privacy | Two-tier storage with regex-based PII scrubbing for outbound text · ε-differential privacy (Laplace mechanism) for marketplace queries |

---

## Quick start

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 18 | for the Next.js frontend and snarkjs |
| Python | ≥ 3.11 | for the FastAPI backend |
| `snarkjs` | latest | `npm install -g snarkjs` |
| Solana CLI | optional | only needed for on-chain anchoring and the marketplace treasury |

### Backend

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

### On-chain features (optional)

To enable proof anchoring and the marketplace treasury:

```bash
solana-keygen new --outfile ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2

# Generate a separate treasury keypair for the marketplace (one-time):
node -e "const {Keypair} = require('@solana/web3.js'); const fs = require('fs'); \
  const kp = Keypair.generate(); \
  fs.writeFileSync('backend/chain/treasury.json', JSON.stringify(Array.from(kp.secretKey))); \
  console.log('Treasury:', kp.publicKey.toBase58());"

# Fund the treasury:
solana transfer <TREASURY_PUBKEY> 0.1 --url devnet --allow-unfunded-recipient
```

Set `TREASURY_KEYPAIR_PATH=/path/to/backend/chain/treasury.json` in `.env`.

### AI chat

Set `ANTHROPIC_API_KEY` in `.env` to enable prompt-cached chat. Without a key, the backend falls back to the local Claude CLI binary if installed.

### Wearables

Connect a wearable from the **Wearable** page in the UI. Each provider requires a developer app at the provider's portal — credentials are pasted directly in the modal (no env edits required). Fallback env vars are documented in `.env.example` for headless deployments.

---

## How it works

```
                                  ┌──────────────────────────────┐
                                  │  Local SQLite (two tiers)     │
   PDF / CSV / Apple Health ZIP   │   tier 1 — raw ingested text  │
   Fitbit / WHOOP / Oura sync     │   tier 2 — PII-scrubbed copy  │
            │                     └──────────────────────────────┘
            ▼                                ▲
   ┌─────────────────┐                       │
   │  /api/upload    │ ──────────────────────┘
   │  pdfplumber +   │   tier 1 = raw         tier 2 = regex-scrubbed
   │  regex parsing  │                        (used for outbound chat
   └─────────────────┘                         and external API calls)
            │
            │   Each numeric observation gets a Poseidon commitment
            │   and a signed attestation on ingest.
            ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  /api/zk/prove  — generates a Groth16 proof:                │
   │    private inputs:  value, nonce, pseudonym_id, biomarker_id│
   │    public inputs:   threshold, date_int, commitment         │
   │    output:          1 if value < threshold, else 0          │
   │                                                             │
   │   Range and "above" claims are composed from this primitive.│
   └─────────────────────────────────────────────────────────────┘
            │
            │   Proof hash anchored as a Solana Memo transaction
            ▼   for tamper-evident timestamping (no PHI on chain).
   ┌─────────────────────────────────────────────────────────────┐
   │  /api/zk/export — emits a self-contained HTML verifier      │
   │  • Web Crypto API checks file integrity                     │
   │  • snarkjs (loaded from CDN) re-runs Groth16 verification   │
   │  • Solana Explorer link cross-checks the on-chain anchor    │
   └─────────────────────────────────────────────────────────────┘
```

### The circuit

`circuit/threshold_attestation.circom` proves a single relation: `value < threshold`. The Poseidon commitment binds the proof to the original signed attestation, preventing substitution. Range proofs (`low ≤ value < high`) and above-threshold proofs are composed at the application layer from this primitive.

### Two-tier data isolation

`backend/anonymize.py` defines six deterministic regex patterns (SSN, phone, email, DOB, labeled identifier, address). Every uploaded document is stored twice:

- `documents` (Tier 1) — raw text, used for ZK proof generation and on-screen rendering. Never crosses the network.
- `documents_tier2` — anonymized copy, used as LLM context and any other outbound payload.

`get_all_content_tier2()` is the only path used by the chat endpoint and the AI insights generator.

### Marketplace privacy & payments

Per-biomarker aggregates use the Laplace mechanism with ε = 1.0 — sensitivity is computed from each query's observed range divided by contributor count. Payments route through a per-query escrow PDA defined by the `zkhealth_split` Anchor program (`program/zkhealth_split/src/lib.rs`); the backend authority signs a single `release` instruction that atomically distributes shares across contributor wallets.

---

## Project layout

```
.
├── backend/
│   ├── main.py                 FastAPI application
│   ├── db.py                   SQLite schema + helpers (two-tier)
│   ├── anonymize.py            Regex-based PII scrubber for outbound text
│   ├── ingest.py               PDF + CSV parsers
│   ├── ingest_apple_health.py  Apple Health export.zip parser
│   ├── llm.py                  Anthropic SDK wrapper (CLI fallback)
│   ├── market.py               ε-DP anonymization + mock contributor profiles
│   ├── chain/                  Solana operations
│   │   ├── solana_anchor.py    Memo anchoring + treasury operations
│   │   ├── _memo_bridge.cjs    Memo program transaction signer
│   │   ├── _treasury_bridge.cjs Treasury keypair operations
│   │   └── payment_verify.cjs  Payment-verification RPC client
│   ├── wearable/               OAuth2 + sync per provider
│   │   ├── _common.py          Shared OAuth + token refresh + DB-backed credentials
│   │   ├── fitbit.py
│   │   ├── whoop.py
│   │   └── oura.py
│   └── zk/
│       ├── attestation.py      Poseidon commitment + signed attestation
│       ├── prover.py           Groth16 proof generation
│       ├── verifier.py         Proof + signature verification
│       └── html_export.py      Self-contained HTML verifier templates
│
├── circuit/
│   ├── threshold_attestation.circom
│   ├── threshold_attestation_final.zkey
│   ├── verification_key.json
│   └── threshold_attestation_js/
│
├── program/
│   └── zkhealth_split/         Anchor program for atomic payment splits
│
├── frontend/                   Next.js 16 app
│   └── app/
│       ├── page.tsx            Chat
│       ├── dashboard/          Lab + wearable dashboard
│       ├── zk/                 Proof generation, verification, public share
│       ├── market/             Biomarker marketplace
│       ├── wearable/           Provider connections
│       └── components/         NavHeader, Modal, UploadContext, ThemeToggle
│
└── sample_data/
    └── sample_wearables.csv
```

---

## Development

The backend hot-reloads via `uvicorn --reload`. The frontend uses Next.js Turbopack for fast refresh. Run the linter with:

```bash
cd frontend && npx eslint .
```

---

## License

MIT — see [LICENSE](LICENSE).
