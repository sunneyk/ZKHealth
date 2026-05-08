"use client";
import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { toast } from "sonner";

const API = "http://127.0.0.1:8000";
const LAMPORTS_PER_QUERY = 1_000_000; // 0.001 SOL

// ── Types ──────────────────────────────────────────────────────
type Listing = {
  listing_id: string;
  canonical_name: string;
  price_lamports: number;
  active: number;
  created_at: string;
};
type Observation = {
  obs_id: string;
  canonical_name: string;
  value: number;
  unit: string;
  date_effective: string;
};
type Grant = {
  grant_id: string;
  solana_tx_id: string;
  lamports_received: number;
  researcher_pubkey: string;
  anonymized_data: string;
  created_at: string;
};
type PreviewRow = {
  canonical_name: string;
  mean: number;
  unit: string;
  n_readings: number;
};
type SnapshotRow = {
  canonical_name: string;
  noisy_value: number;
  unit: string;
  n_readings: number;
};
type PurchaseResult = {
  verified: boolean;
  grant_id?: string;
  lamports?: number;
  data?: SnapshotRow[];
  error?: string;
};
type Earnings = { total_lamports: number; grant_count: number };

// ── Helpers ────────────────────────────────────────────────────
function formatCanonical(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncatePubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

// ── Page ───────────────────────────────────────────────────────
export default function MarketPage() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const [listings, setListings] = useState<Listing[]>([]);
  const [allCanonicals, setAllCanonicals] = useState<string[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [earnings, setEarnings] = useState<Earnings>({ total_lamports: 0, grant_count: 0 });
  const [recipientPubkey, setRecipientPubkey] = useState("");
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseResult, setPurchaseResult] = useState<PurchaseResult | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [obsRes, listRes, grantsRes, previewRes, earningsRes, walletRes] = await Promise.all([
        fetch(`${API}/api/observations`),
        fetch(`${API}/api/market/listings`),
        fetch(`${API}/api/market/grants`),
        fetch(`${API}/api/market/preview`),
        fetch(`${API}/api/market/earnings`),
        fetch(`${API}/api/zk/wallet`),
      ]);

      const obs: Observation[] = await obsRes.json();
      const listData: Listing[] = await listRes.json();
      const grantsData: Grant[] = await grantsRes.json();
      const previewData: PreviewRow[] = await previewRes.json();
      const earningsData: Earnings = await earningsRes.json();
      const walletData = await walletRes.json();

      // Deduplicate canonical names from observations
      const seen = new Set<string>();
      const canonicals: string[] = [];
      for (const o of obs) {
        if (!seen.has(o.canonical_name)) {
          seen.add(o.canonical_name);
          canonicals.push(o.canonical_name);
        }
      }
      canonicals.sort();

      setAllCanonicals(canonicals);
      setListings(listData);
      setGrants(grantsData);
      setPreview(previewData);
      setEarnings(earningsData);
      setRecipientPubkey(walletData.pubkey || "");
    } catch {
      // silently handle — backend may be starting
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const listedSet = new Set(listings.map((l) => l.canonical_name));

  async function handleToggle(canonical: string) {
    setToggling(canonical);
    try {
      if (listedSet.has(canonical)) {
        const listing = listings.find((l) => l.canonical_name === canonical);
        if (!listing) return;
        await fetch(`${API}/api/market/listings/${listing.listing_id}`, { method: "DELETE" });
        toast.success(`Removed ${formatCanonical(canonical)} from marketplace`);
      } else {
        await fetch(`${API}/api/market/listings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canonical_name: canonical, price_lamports: LAMPORTS_PER_QUERY }),
        });
        toast.success(`Listed ${formatCanonical(canonical)} on marketplace`);
      }
      await fetchAll();
    } catch {
      toast.error("Failed to update listing");
    } finally {
      setToggling(null);
    }
  }

  async function handlePurchase() {
    if (!connected || !publicKey) {
      toast.error("Connect your Phantom wallet first");
      return;
    }
    if (!recipientPubkey) {
      toast.error("No recipient wallet saved. Ask the data owner to save their wallet on the ZK Proofs page.");
      return;
    }
    if (listings.length === 0) {
      toast.error("No biomarkers listed for sale");
      return;
    }

    setPurchasing(true);
    setPurchaseResult(null);

    try {
      const recipient = new PublicKey(recipientPubkey);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: recipient,
          lamports: LAMPORTS_PER_QUERY,
        })
      );

      const signature = await sendTransaction(tx, connection);
      toast.success("Transaction sent — verifying payment…");

      const res = await fetch(`${API}/api/market/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tx_signature: signature,
          researcher_pubkey: publicKey.toBase58(),
        }),
      });
      const result: PurchaseResult = await res.json();
      setPurchaseResult(result);

      if (result.verified) {
        toast.success("Payment verified — data released");
        await fetchAll();
      } else {
        toast.error(`Verification failed: ${result.error}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Purchase failed: ${msg}`);
      setPurchaseResult({ verified: false, error: msg });
    } finally {
      setPurchasing(false);
    }
  }

  const noWalletSaved = !recipientPubkey;

  return (
    <div className="space-y-8 cascade">
      {/* Page header */}
      <div>
        <h1 className="page-title">Data Marketplace</h1>
        <p className="page-subtitle">
          Opt in biomarkers for purchase. Researchers pay 0.001 SOL to receive an anonymized snapshot.
        </p>
      </div>

      {/* No-wallet warning */}
      {noWalletSaved && (
        <div className="market-warning">
          <span className="market-warning-icon">⚠</span>
          <span>
            No Solana wallet saved. Connect and save your wallet on the{" "}
            <a href="/zk" className="solana-link">ZK Proofs</a> page first.
          </span>
        </div>
      )}

      {/* Section 1 — Earnings strip */}
      {grants.length > 0 && (
        <div className="earnings-strip">
          <span className="earnings-label">Total earned</span>
          <span className="earnings-value">
            {(earnings.total_lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL
          </span>
          <span className="earnings-sep">·</span>
          <span className="earnings-count">{earnings.grant_count} {earnings.grant_count === 1 ? "query" : "queries"}</span>
        </div>
      )}

      {/* Section 2 — My Listings */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="section-label">My listings</p>
          {listings.length > 0 && (
            <span className="wallet-saved">0.001 SOL · all {listings.length} listed</span>
          )}
        </div>
        <div className="card">
          {allCanonicals.length === 0 ? (
            <p className="empty-state">
              No lab results yet — upload a file on the Chat page first.
            </p>
          ) : (
            <div>
              {allCanonicals.map((canonical) => {
                const active = listedSet.has(canonical);
                const isToggling = toggling === canonical;
                return (
                  <div key={canonical} className="listing-row">
                    <span className="listing-name">{formatCanonical(canonical)}</span>
                    <button
                      className={`listing-toggle${active ? " listing-toggle-active" : ""}`}
                      onClick={() => handleToggle(canonical)}
                      disabled={isToggling}
                      aria-pressed={active}
                    >
                      {isToggling ? "…" : active ? "Listed" : "List"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Section 3 — Transaction History (collapsible) */}
      <section>
        <details className="how-details" open={grants.length > 0}>
          <summary className="how-summary">
            <span className="how-arrow">▶</span>
            Transaction history
            {grants.length > 0 && <span className="proofs-count">{grants.length}</span>}
          </summary>
          <div className="how-body">
            {grants.length === 0 ? (
              <p className="empty-proofs">No purchases yet.</p>
            ) : (
              <table className="preview-table">
                <thead>
                  <tr>
                    <th className="preview-th">Date</th>
                    <th className="preview-th">Researcher</th>
                    <th className="preview-th">SOL</th>
                    <th className="preview-th">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.grant_id}>
                      <td className="preview-td">{g.created_at.slice(0, 10)}</td>
                      <td className="preview-td">
                        <span className="wallet-saved">{truncatePubkey(g.researcher_pubkey)}</span>
                      </td>
                      <td className="preview-td">
                        {(g.lamports_received / LAMPORTS_PER_SOL).toFixed(4)}
                      </td>
                      <td className="preview-td">
                        {g.solana_tx_id ? (
                          <a
                            href={`https://explorer.solana.com/tx/${g.solana_tx_id}?cluster=devnet`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="solana-link"
                          >
                            {g.solana_tx_id.slice(0, 8)}… ↗
                          </a>
                        ) : (
                          <span className="wallet-none">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>
      </section>

      {/* Section 4 — Researcher Panel (collapsible) */}
      <section>
        <details className="how-details">
          <summary className="how-summary">
            <span className="how-arrow">▶</span>
            Researcher panel — buy anonymized data
          </summary>
          <div className="how-body space-y-4">
            {/* Preview table */}
            {preview.length === 0 ? (
              <p className="empty-proofs">No biomarkers listed for sale yet.</p>
            ) : (
              <>
                <p className="how-strong">Available biomarkers (anonymized preview):</p>
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th className="preview-th">Biomarker</th>
                      <th className="preview-th">Mean value</th>
                      <th className="preview-th">Unit</th>
                      <th className="preview-th">Readings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row) => (
                      <tr key={row.canonical_name}>
                        <td className="preview-td">{formatCanonical(row.canonical_name)}</td>
                        <td className="preview-td">{row.mean}</td>
                        <td className="preview-td">{row.unit || "—"}</td>
                        <td className="preview-td">{row.n_readings}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="space-y-2">
                  <div className="card-sunk flex items-center justify-between gap-3">
                    <div>
                      <p className="stat-label">Paying to</p>
                      <p className="wallet-key mt-0.5">
                        {recipientPubkey
                          ? `${recipientPubkey.slice(0, 8)}…${recipientPubkey.slice(-6)}`
                          : <span className="wallet-none">No wallet saved by data owner</span>
                        }
                      </p>
                    </div>
                    {recipientPubkey && (
                      <button
                        className="copy-btn"
                        onClick={() => { navigator.clipboard.writeText(recipientPubkey); toast.success("Address copied"); }}
                        title="Copy full address"
                      >⧉</button>
                    )}
                  </div>
                  <p className="stat-label">
                    Price: 0.001 SOL · <span className="wallet-saved">≈ $0.14 (devnet demo)</span>
                  </p>
                  {!connected && (
                    <p className="market-warning">
                      <span className="market-warning-icon">⚠</span>
                      Connect your Phantom wallet to purchase data.
                    </p>
                  )}
                  <button
                    className="btn-primary"
                    onClick={handlePurchase}
                    disabled={purchasing || !connected || listings.length === 0 || !recipientPubkey}
                  >
                    {purchasing ? "Processing payment…" : "Request full dataset (0.001 SOL)"}
                  </button>
                </div>
              </>
            )}

            {/* Purchase result */}
            {purchaseResult && purchaseResult.verified && purchaseResult.data && (
              <div className="purchase-result">
                <p className="purchase-result-title">
                  ✓ Dataset released — grant #{purchaseResult.grant_id?.slice(0, 8)}
                </p>
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th className="preview-th">Biomarker</th>
                      <th className="preview-th">Value (±5% noise)</th>
                      <th className="preview-th">Unit</th>
                      <th className="preview-th">Readings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseResult.data.map((row) => (
                      <tr key={row.canonical_name}>
                        <td className="preview-td">{formatCanonical(row.canonical_name)}</td>
                        <td className="preview-td">{row.noisy_value}</td>
                        <td className="preview-td">{row.unit || "—"}</td>
                        <td className="preview-td">{row.n_readings}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {purchaseResult && !purchaseResult.verified && (
              <div className="market-warning">
                <span className="market-warning-icon">✗</span>
                {purchaseResult.error}
              </div>
            )}
          </div>
        </details>
      </section>

      {/* How it works */}
      <details className="how-details">
        <summary className="how-summary">
          <span className="how-arrow">▶</span> How does this work?
        </summary>
        <div className="how-body space-y-2">
          <p>
            <strong className="how-strong">Step 1 — List.</strong> Toggle biomarkers you want to sell. Each listing sets a price of 0.001 SOL per query.
          </p>
          <p>
            <strong className="how-strong">Step 2 — Pay.</strong> A researcher connects their Phantom wallet and sends devnet SOL to your wallet address via a standard transfer.
          </p>
          <p>
            <strong className="how-strong">Step 3 — Verify.</strong> The backend calls Solana devnet RPC to confirm the on-chain transfer before releasing any data. Payment verification is atomic — no data is released unless the transaction is confirmed.
          </p>
          <p>
            <strong className="how-strong">Step 4 — Anonymize.</strong> Values are aggregated across all readings and ±5% uniform noise is added before release. No dates, IDs, or raw values are shared.
          </p>
        </div>
      </details>
    </div>
  );
}
