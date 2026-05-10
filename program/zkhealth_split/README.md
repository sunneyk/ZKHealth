# `zkhealth_split` — Anchor program

The production payment architecture for the ZKHealth data marketplace.

## Why a program?

The naive marketplace pays each contributor directly. That has two problems:

1. **Privacy leak.** The buyer learns every contributor's address from the transaction history.
2. **Cost & latency.** N contributors = N transactions = O(N) lamports in fees and several seconds of confirmation latency.

`zkhealth_split` routes payments through a single per-query escrow PDA that the backend (the only entity that knows which contributors actually backed a given query) atomically distributes via one `release` instruction. The buyer never sees individual contributor addresses, and total cost stays flat regardless of contributor count.

## Instructions

### `pay(query_id, amount)`

Researcher transfers SOL from their wallet to the escrow PDA derived from `b"escrow" || query_id`. The PDA holds the funds until release.

| Account | Role |
|---|---|
| `payer` | Researcher's wallet (signer) |
| `escrow` | PDA(`b"escrow" || query_id`), receives the SOL |
| `system_program` | for the transfer CPI |

### `release(query_id, amounts)`

Backend authority signs to release escrow into per-contributor amounts. The contributor pubkeys are passed via `remaining_accounts` (variable length). Atomic — if any transfer would underflow the escrow, the whole release reverts.

| Account | Role |
|---|---|
| `authority` | ZKHealth backend keypair (signer) |
| `escrow` | The same PDA, now drained into `remaining_accounts` |
| `remaining_accounts[i]` | Contributor `i`'s wallet, receives `amounts[i]` lamports |

## Security model

- **Buyer cannot collude with contributors.** Buyer never learns contributor addresses; backend is the only signer authorized to call `release`, and it releases based on its private contributor index.
- **Backend cannot redirect funds.** Authority can only release from the per-query escrow PDA. The program enforces `amounts.iter().sum() ≤ escrow_balance` and atomically transfers — no partial releases.
- **Buyer can recover funds if the backend is unavailable.** A future addition: `refund` instruction with a time-lock that lets the original payer reclaim escrow after N slots without a release.

## Local development

```bash
anchor build
anchor test
```

## Deployment

```bash
anchor build
anchor deploy --provider.cluster devnet
```

After deploying, copy the program ID into the backend config and re-run the marketplace tests against the live program.

## Status

The escrow + atomic-release flow runs against this contract. The backend signs the `release` instruction as the program authority; buyer payments land in the per-query PDA before being distributed.
