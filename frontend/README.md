# ZKHealth — Frontend

Next.js 16 (App Router, Turbopack) UI for the ZKHealth backend.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
```

The frontend assumes the FastAPI backend is running at `http://127.0.0.1:8000`. To change this, update the `API` constant at the top of each page module.

## Pages

| Route | Purpose |
|---|---|
| `/` | Health chat with PDF / CSV / Apple Health upload |
| `/dashboard` | Lab + wearable dashboard with reference ranges and trend charts |
| `/zk` | ZK proof generation and verification |
| `/zk/verify/[id]` | Public verification page for a single proof |
| `/market` | Biomarker marketplace (list, sell, purchase) |
| `/wearable` | Connect and sync Fitbit / WHOOP / Oura |

## Project conventions

- Shared design tokens live in `app/globals.css` as CSS custom properties (`--ink`, `--brand`, `--paper-card`, etc.) — used in both light and dark themes.
- All PII-bearing data sent to external services flows through the backend's two-tier anonymization layer; the frontend never bypasses it.
- Wallet state is managed by `@solana/wallet-adapter-react` and exposed globally via the nav-bar wallet button.
