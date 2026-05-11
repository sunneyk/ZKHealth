"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { toast } from "sonner";
import { biomarkerLabel } from "../lib/biomarkerLabel";

const API = "http://127.0.0.1:8000";
// Researcher price scales with cohort size: total = unit × n_contributors,
// so each contributor's per-capita share stays constant regardless of N.
// The authoritative quote comes from GET /api/market/quote.
const FALLBACK_UNIT_PRICE = 1_000_000;

// ── Types ──────────────────────────────────────────────────────
type Listing = {
  listing_id: string;
  canonical_name: string;
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
  n_contributors: number;
};
/** A single contributor's set of biomarker values (wide format).
 *  Keys are canonical biomarker names; values are noisy releases or null
 *  when that biomarker wasn't measured for this contributor. */
type PersonRow = Record<string, number | null>;
type SnapshotSummary = {
  biomarker: string;
  unit: string;
  n_readings: number;
  n_contributors: number;
};
type PurchaseResult = {
  verified: boolean;
  grant_id?: string;
  lamports?: number;
  data?: PersonRow[];
  summary?: SnapshotSummary[];
  error?: string;
  treasury_pubkey?: string;
  release_tx?: string;
  release_lamports?: number;
  n_contributors?: number;
};
type Earnings = {
  total_lamports: number;
  grant_count: number;
  per_grant_share_lamports?: number;
  n_listings?: number;
};

// ── Helpers ────────────────────────────────────────────────────
const formatCanonical = biomarkerLabel;

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Resolve the column metadata for a snapshot. Prefers the API-provided
 *  summary; falls back to inspecting the rows themselves (sorted union of
 *  keys). Backwards-compatible with older long-format grants. */
function resolveSchema(rows: PersonRow[], summary?: SnapshotSummary[]): { biomarkers: string[]; units: Record<string, string> } {
  if (summary && summary.length > 0) {
    const biomarkers = summary.map((s) => s.biomarker);
    const units: Record<string, string> = {};
    for (const s of summary) units[s.biomarker] = s.unit;
    return { biomarkers, units };
  }
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return { biomarkers: Array.from(seen).sort(), units: {} };
}

/** Convert legacy long-format snapshot rows ({biomarker, value, unit}) into
 *  per-person wide rows by grouping by row index. Used only for grants stored
 *  before the wide refactor. */
function legacyLongToWide(legacyRows: Array<Record<string, unknown>>): { rows: PersonRow[]; summary: SnapshotSummary[] } {
  const grouped = new Map<string, { values: number[]; unit: string }>();
  for (const r of legacyRows) {
    const biomarker = String(r.biomarker ?? r.canonical_name ?? "");
    if (!biomarker) continue;
    if (!grouped.has(biomarker)) grouped.set(biomarker, { values: [], unit: String(r.unit ?? "") });
    grouped.get(biomarker)!.values.push(Number(r.value ?? r.noisy_value ?? 0));
  }
  const biomarkers = Array.from(grouped.keys()).sort();
  const maxLen = biomarkers.reduce((m, b) => Math.max(m, grouped.get(b)!.values.length), 0);
  const rows: PersonRow[] = [];
  for (let i = 0; i < maxLen; i++) {
    const row: PersonRow = {};
    for (const b of biomarkers) {
      const arr = grouped.get(b)!.values;
      row[b] = i < arr.length ? arr[i] : null;
    }
    rows.push(row);
  }
  const summary: SnapshotSummary[] = biomarkers.map((b) => ({
    biomarker: b,
    unit: grouped.get(b)!.unit,
    n_readings: grouped.get(b)!.values.length,
    n_contributors: grouped.get(b)!.values.length,
  }));
  return { rows, summary };
}

/** Detect storage format and normalize to per-person wide rows + summary. */
function normalizeSnapshot(rawData: unknown, rawSummary?: unknown): { rows: PersonRow[]; summary: SnapshotSummary[] } {
  if (!Array.isArray(rawData) || rawData.length === 0) {
    return { rows: [], summary: Array.isArray(rawSummary) ? (rawSummary as SnapshotSummary[]) : [] };
  }
  const first = rawData[0] as Record<string, unknown>;
  // Legacy long format: each row has a `biomarker` (or `canonical_name`) field.
  if ("biomarker" in first || "canonical_name" in first) {
    return legacyLongToWide(rawData as Array<Record<string, unknown>>);
  }
  // New wide format: row is already a person dict.
  return {
    rows: rawData as PersonRow[],
    summary: Array.isArray(rawSummary) ? (rawSummary as SnapshotSummary[]) : [],
  };
}

function snapshotToCSV(rows: PersonRow[], summary?: SnapshotSummary[]): string {
  const { biomarkers, units } = resolveSchema(rows, summary);
  const headerCells = biomarkers.map((b) =>
    units[b] ? `${formatCanonical(b)} (${units[b]})` : formatCanonical(b),
  );
  const lines = [
    headerCells.map(csvEscape).join(","),
    ...rows.map((rec) => biomarkers.map((b) => csvEscape(rec[b] ?? "")).join(",")),
  ];
  return lines.join("\n") + "\n";
}

function snapshotToJSON(rows: PersonRow[], summary: SnapshotSummary[] | undefined, grantId?: string): string {
  const { biomarkers, units } = resolveSchema(rows, summary);
  return JSON.stringify(
    {
      grant_id: grantId ?? null,
      released_at: new Date().toISOString(),
      privacy: { mechanism: "Laplace", epsilon: 1.0 },
      schema: {
        biomarkers: biomarkers.map((b) => ({ name: b, unit: units[b] || null })),
      },
      total_records: rows.length,
      records: rows,
    },
    null,
    2,
  );
}

function downloadSnapshot(
  rows: PersonRow[],
  summary: SnapshotSummary[] | undefined,
  grantId: string | undefined,
  format: "csv" | "json",
) {
  const id = (grantId ?? "snapshot").slice(0, 8);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `zkhealth-${id}-${stamp}.${format}`;
  const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
  const content = format === "csv" ? snapshotToCSV(rows, summary) : snapshotToJSON(rows, summary, grantId);
  downloadBlob(content, mime, filename);
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
  const [quote, setQuote] = useState<{ n_contributors: number; total_price_lamports: number; unit_price_lamports: number }>({
    n_contributors: 0,
    total_price_lamports: 0,
    unit_price_lamports: FALLBACK_UNIT_PRICE,
  });
  const [recipientPubkey, setRecipientPubkey] = useState("");
  const [treasuryPubkey, setTreasuryPubkey] = useState("");
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseResult, setPurchaseResult] = useState<PurchaseResult | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [currency, setCurrency] = useState<"SOL" | "USDC">("SOL");
  const [solPrice, setSolPrice] = useState<number>(140); // fallback if CoinGecko is unreachable
  // Role tab. URL query (?tab=buy|sell) wins; otherwise default chosen once
  // after first fetch lands — sell if the user has uploads, buy if not.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const urlTab = searchParams.get("tab");
  const initialTab: "sell" | "buy" = urlTab === "buy" || urlTab === "sell" ? urlTab : "sell";
  const [tab, setTabState] = useState<"sell" | "buy">(initialTab);
  const tabInitializedRef = useRef(urlTab === "buy" || urlTab === "sell");

  function setTab(next: "sell" | "buy") {
    setTabState(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  // React to back/forward navigation that swaps ?tab=
  useEffect(() => {
    if (urlTab === "buy" || urlTab === "sell") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTabState(urlTab);
      tabInitializedRef.current = true;
    }
  }, [urlTab]);

  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")
      .then(r => r.json())
      .then(d => { if (d?.solana?.usd) setSolPrice(d.solana.usd); })
      .catch(() => {});
  }, []);

  function formatAmount(lamports: number, opts?: { precise?: boolean }): string {
    const sol = lamports / LAMPORTS_PER_SOL;
    if (currency === "SOL") {
      return `${sol.toFixed(opts?.precise ? 4 : 3)} SOL`;
    }
    const usd = sol * solPrice;
    return `$${usd.toFixed(2)} USDC`;
  }

  const fetchAll = useCallback(async (isActive: () => boolean = () => true) => {
    try {
      const [obsRes, listRes, grantsRes, previewRes, earningsRes, walletRes, treasuryRes, quoteRes] = await Promise.all([
        fetch(`${API}/api/observations`),
        fetch(`${API}/api/market/listings`),
        fetch(`${API}/api/market/grants`),
        fetch(`${API}/api/market/preview`),
        fetch(`${API}/api/market/earnings`),
        fetch(`${API}/api/zk/wallet`),
        fetch(`${API}/api/market/treasury`),
        fetch(`${API}/api/market/quote`),
      ]);
      if (!isActive()) return;

      const obs: Observation[] = await obsRes.json();
      const listData: Listing[] = await listRes.json();
      const grantsData: Grant[] = await grantsRes.json();
      const previewData: PreviewRow[] = await previewRes.json();
      const earningsData: Earnings = await earningsRes.json();
      const walletData = await walletRes.json();
      const treasuryData = treasuryRes.ok ? await treasuryRes.json() : { pubkey: "" };
      const quoteData = quoteRes.ok ? await quoteRes.json() : { n_contributors: 0, total_price_lamports: 0, unit_price_lamports: FALLBACK_UNIT_PRICE };
      if (!isActive()) return;

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
      setTreasuryPubkey(treasuryData.pubkey || "");
      setQuote(quoteData);
      // First load: pick the tab that matches the user's likely role, without
      // dirtying the URL. Skip if the URL already specified ?tab=.
      if (!tabInitializedRef.current) {
        tabInitializedRef.current = true;
        setTabState(canonicals.length > 0 ? "sell" : "buy");
      }
    } catch {
      // silently handle — backend may be starting
    }
  }, []);

  useEffect(() => {
    // Initial data fetch on mount. setState calls inside fetchAll are guarded
    // by the isActive() check, so they're skipped if the component unmounts
    // before the network round-trip completes — no cascading-render risk.
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll(() => active);
    return () => { active = false; };
  }, [fetchAll]);

  const listedSet = new Set(listings.map((l) => l.canonical_name));

  async function handleToggleAll() {
    if (allCanonicals.length === 0) return;
    setBulkToggling(true);
    try {
      const everythingListed = listings.length === allCanonicals.length;
      if (everythingListed) {
        await Promise.all(listings.map((l) =>
          fetch(`${API}/api/market/listings/${l.listing_id}`, { method: "DELETE" })
        ));
        toast.success(`Removed all ${listings.length} listings`);
      } else {
        const toAdd = allCanonicals.filter((c) => !listedSet.has(c));
        await Promise.all(toAdd.map((canonical) =>
          fetch(`${API}/api/market/listings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ canonical_name: canonical }),
          })
        ));
        toast.success(`Listed ${toAdd.length} biomarkers`);
      }
      await fetchAll();
    } catch {
      toast.error("Bulk update failed");
    } finally {
      setBulkToggling(false);
    }
  }

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
          body: JSON.stringify({ canonical_name: canonical }),
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
    if (!treasuryPubkey) {
      toast.error("Treasury unavailable — backend keypair not configured.");
      return;
    }
    if (!recipientPubkey) {
      toast.error("No data owner wallet saved. Save your wallet on the ZK Proofs page first.");
      return;
    }
    if (listings.length === 0) {
      toast.error("No biomarkers listed for sale");
      return;
    }
    if (quote.total_price_lamports <= 0) {
      toast.error("No price available — wait a moment and retry");
      return;
    }

    setPurchasing(true);
    setPurchaseResult(null);

    try {
      const treasury = new PublicKey(treasuryPubkey);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: treasury,
          lamports: quote.total_price_lamports,
        })
      );

      const signature = await sendTransaction(tx, connection);
      toast.success("Payment sent to treasury — verifying…");

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
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="page-eyebrow">Data Marketplace</p>
          <h1 className="page-title">{tab === "sell" ? "Sell my data" : "Buy data"}</h1>
          <p className="page-subtitle">
            {tab === "sell"
              ? `List biomarkers from your uploads. Each contributor's per-capita share stays fixed at ${formatAmount(quote.unit_price_lamports, { precise: true })} regardless of cohort size.`
              : `Browse anonymized aggregate snapshots. Price scales with cohort size; payment routes through treasury escrow.`}
          </p>
        </div>
        <div className="currency-toggle" role="group" aria-label="Currency display" suppressHydrationWarning>
          {(["SOL", "USDC"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              data-active={currency === c}
              suppressHydrationWarning
            >
              {c}
            </button>
          ))}
        </div>
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

      {/* Section 1 — Earnings strip (sell only) — your share scales with biomarkers listed */}
      {tab === "sell" && grants.length > 0 && (
        <div className="earnings-strip">
          <span className="earnings-label">Your share</span>
          <span className="earnings-value">
            {formatAmount(earnings.total_lamports, { precise: true })}
          </span>
          <span className="earnings-sep">·</span>
          <span className="earnings-count">{earnings.grant_count} {earnings.grant_count === 1 ? "buy" : "buys"}</span>
          <span className="earnings-sep">·</span>
          <span className="earnings-count">
            {formatAmount(earnings.per_grant_share_lamports ?? quote.unit_price_lamports, { precise: true })} per buy
            {earnings.n_listings ? ` (${earnings.n_listings} biomarker${earnings.n_listings === 1 ? "" : "s"} listed)` : ""}
          </span>
        </div>
      )}

      {/* Section 2 — My Listings (collapsible, sell only) */}
      {tab === "sell" && (
      <section>
        <details className="how-details" open>
          <summary className="how-summary listings-summary">
            <span className="how-arrow">▶</span>
            <span>My listings</span>
            {listings.length > 0 && (
              <span className="proofs-count">{listings.length} of {allCanonicals.length}</span>
            )}
            {allCanonicals.length > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleToggleAll();
                }}
                disabled={bulkToggling}
                className="btn-mode listings-summary-action"
              >
                {bulkToggling
                  ? "…"
                  : listings.length === allCanonicals.length
                  ? "Deselect all"
                  : "Select all"}
              </button>
            )}
          </summary>
          <div className="how-body listings-body">
            {allCanonicals.length === 0 ? (
              <p className="empty-state">
                No lab results yet — upload a file on the Chat page first.
              </p>
            ) : (
              <>
                {listings.length > 0 && (
                  <p className="listings-price-line">
                    Dataset priced at <strong>{formatAmount(quote.unit_price_lamports, { precise: true })}</strong> per contributor · {quote.n_contributors.toLocaleString()} contributors · total <strong>{formatAmount(quote.total_price_lamports, { precise: true })}</strong>
                  </p>
                )}
                <div className="listings-grid">
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
              </>
            )}
          </div>
        </details>
      </section>

      )}

      {/* Researcher Buy flow (buy tab only) */}
      {tab === "buy" && (
      <section className="space-y-4">
          {/* Available dataset preview (collapsible to match the rest of the platform) */}
          {preview.length === 0 ? (
              <div className="card">
                <p className="empty-state">
                  No datasets are currently listed. Sellers list biomarkers under <button type="button" onClick={() => setTab("sell")} className="solana-link" suppressHydrationWarning>Sell my data</button>. Once they do, you&apos;ll see an anonymized preview here.
                </p>
              </div>
            ) : (
              <>
                <section>
                  <details className="how-details" open>
                    <summary className="how-summary">
                      <span className="how-arrow">▶</span>
                      <span>Available biomarkers</span>
                      <span className="proofs-count">{preview.length}</span>
                    </summary>
                    <div className="how-body">
                      <p className="study-section-hint">
                        Anonymized preview — Laplace noise applied at ε = 1.0 differential privacy.
                      </p>
                      <table className="preview-table">
                        <thead>
                          <tr>
                            <th className="preview-th">Biomarker</th>
                            <th className="preview-th">Mean value</th>
                            <th className="preview-th">Unit</th>
                            <th className="preview-th">Readings</th>
                            <th className="preview-th">Contributors</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.map((row) => (
                            <tr key={row.canonical_name}>
                              <td className="preview-td">{formatCanonical(row.canonical_name)}</td>
                              <td className="preview-td">{row.mean}</td>
                              <td className="preview-td">{row.unit || "—"}</td>
                              <td className="preview-td">{row.n_readings}</td>
                              <td className="preview-td">{row.n_contributors}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>

                <div className="space-y-2">
                  <div className="card-sunk flex items-center justify-between gap-3">
                    <div>
                      <p className="stat-label">
                        Paying ZKHealth Treasury <span className="info-badge">
                          <span className="info-trigger">escrow ⓘ</span>
                          <span className="info-tooltip">
                            <strong>Treasury escrow → atomic split.</strong>{" "}
                            Researchers pay one address; the backend then signs a <code className="inline-code">release</code> that distributes shares to every contributor. Buyer never sees individual contributor addresses; cost stays flat regardless of contributor count. Both the payment and the release land on Solana — links on the receipt.
                          </span>
                        </span>
                      </p>
                      <p className="wallet-key mt-0.5">
                        {treasuryPubkey
                          ? `${treasuryPubkey.slice(0, 8)}…${treasuryPubkey.slice(-6)}`
                          : <span className="wallet-none">Treasury unavailable</span>
                        }
                      </p>
                    </div>
                    {treasuryPubkey && (
                      <button
                        className="copy-btn"
                        onClick={() => { navigator.clipboard.writeText(treasuryPubkey); toast.success("Treasury address copied"); }}
                        title="Copy full treasury address"
                      >⧉</button>
                    )}
                  </div>
                  <p className="stat-label">
                    Price: {formatAmount(quote.total_price_lamports, { precise: true })} {currency === "SOL" && (
                      <span className="wallet-saved">≈ ${((quote.total_price_lamports / LAMPORTS_PER_SOL) * solPrice).toFixed(2)} USDC</span>
                    )} · {quote.n_contributors.toLocaleString()} contributors × {formatAmount(quote.unit_price_lamports, { precise: true })} · <span className="info-badge">
                      <span className="info-trigger">Private ⓘ</span>
                      <span className="info-tooltip">
                        <strong>Differential privacy, ε = 1.0.</strong>{" "}
                        Laplace noise is added to every aggregate, calibrated so any single contributor&apos;s data can shift the released value by at most a bounded amount. The same standard used by the US Census.
                      </span>
                    </span>
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
                    {purchasing ? "Processing payment…" : `Request full dataset (${formatAmount(quote.total_price_lamports, { precise: true })})`}
                  </button>
                </div>
              </>
            )}

            {/* Purchase result */}
            {purchaseResult && purchaseResult.verified && purchaseResult.data && (() => {
              const { rows, summary } = normalizeSnapshot(purchaseResult.data, purchaseResult.summary);
              const { biomarkers, units } = resolveSchema(rows, summary);
              const PREVIEW_LIMIT = 15;
              const previewRecords = rows.slice(0, PREVIEW_LIMIT);
              const truncated = Math.max(0, rows.length - PREVIEW_LIMIT);
              return (
                <div className="purchase-result">
                  <div className="purchase-result-header">
                    <div>
                      <p className="purchase-result-title">
                        ✓ Dataset released — grant #{purchaseResult.grant_id?.slice(0, 8)}
                      </p>
                      <p className="purchase-result-meta">
                        {rows.length.toLocaleString()} contributors × {biomarkers.length.toLocaleString()} biomarker{biomarkers.length === 1 ? "" : "s"} · ε-DP (ε = 1.0)
                      </p>
                    </div>
                    <div className="purchase-download-group">
                      <button
                        type="button"
                        onClick={() => downloadSnapshot(rows, summary, purchaseResult.grant_id, "csv")}
                        className="btn-ghost"
                      >↓ CSV</button>
                      <button
                        type="button"
                        onClick={() => downloadSnapshot(rows, summary, purchaseResult.grant_id, "json")}
                        className="btn-ghost"
                      >↓ JSON</button>
                    </div>
                  </div>
                  <div className="wide-table-scroll">
                    <table className="preview-table wide-preview-table">
                      <thead>
                        <tr>
                          <th className="preview-th wide-row-num">#</th>
                          {biomarkers.map((b) => (
                            <th key={b} className="preview-th">
                              <div className="wide-col-name">{formatCanonical(b)}</div>
                              {units[b] && <div className="wide-col-unit">{units[b]}</div>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRecords.map((rec, i) => (
                          <tr key={i}>
                            <td className="preview-td wide-row-num">{i + 1}</td>
                            {biomarkers.map((b) => (
                              <td key={b} className="preview-td">
                                {rec[b] === null || rec[b] === undefined
                                  ? <span className="wide-cell-empty">—</span>
                                  : rec[b]}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="purchase-truncation-note">
                    {truncated > 0
                      ? `Showing 15 of ${rows.length.toLocaleString()} contributors — download for the full dataset.`
                      : `${rows.length} contributor${rows.length === 1 ? "" : "s"} shown · ε = 1.0 Laplace noise per cell.`}
                  </p>

                  {(() => {
                    const summaryRows: SnapshotSummary[] = purchaseResult.summary ?? [];
                    const totalContributors = purchaseResult.n_contributors ?? Math.max(
                      1, ...summaryRows.map((s) => s.n_contributors),
                    );
                  const lamportsPerContributor = purchaseResult.release_lamports ?? Math.floor(
                    (purchaseResult.lamports ?? quote.total_price_lamports) / Math.max(totalContributors, 1)
                  );
                  const payTxUrl = grants[0]?.solana_tx_id
                    ? `https://explorer.solana.com/tx/${grants[0].solana_tx_id}?cluster=devnet`
                    : null;
                  const releaseTxUrl = purchaseResult.release_tx
                    ? `https://explorer.solana.com/tx/${purchaseResult.release_tx}?cluster=devnet`
                    : null;
                  return (
                    <div className="distribution-card">
                      <p className="how-strong">Payment distribution</p>
                      <p className="distribution-line">
                        Treasury escrow received{" "}
                        <strong>
                          {formatAmount(purchaseResult.lamports ?? quote.total_price_lamports, { precise: true })}
                        </strong>{" "}
                        → split across <strong>{totalContributors.toLocaleString()}</strong> contributors at <strong>{formatAmount(lamportsPerContributor, { precise: true })}</strong> each. Data owner&apos;s share released to their wallet; remaining shares allocated against the contributor pool.
                      </p>
                      <div className="distribution-meta" style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                        {payTxUrl && (
                          <span>
                            ① Payment to treasury — <a href={payTxUrl} target="_blank" rel="noopener noreferrer" className="proof-chain-link">⛓ View on Solana Explorer ↗</a>
                          </span>
                        )}
                        {releaseTxUrl ? (
                          <span>
                            ② Release to data owner ({lamportsPerContributor.toLocaleString()} lamports) — <a href={releaseTxUrl} target="_blank" rel="noopener noreferrer" className="proof-chain-link">⛓ View on Solana Explorer ↗</a>
                          </span>
                        ) : (
                          <span style={{ color: "var(--terra-ink)" }}>② Release skipped — treasury unfunded. Run <code className="inline-code">solana transfer {treasuryPubkey?.slice(0,6)}… 0.1 --url devnet --allow-unfunded-recipient</code></span>
                        )}
                      </div>
                    </div>
                  );
                })()}
                </div>
              );
            })()}

            {purchaseResult && !purchaseResult.verified && (
              <div className="market-warning">
                <span className="market-warning-icon">✗</span>
                {purchaseResult.error}
              </div>
            )}
      </section>
      )}

      {/* Buyer's purchase history (buy tab only) — re-download datasets, see past purchases */}
      {tab === "buy" && (
      <section>
        <details className="how-details" open={grants.length > 0}>
          <summary className="how-summary">
            <span className="how-arrow">▶</span>
            Your purchases
            {grants.length > 0 && <span className="proofs-count">{grants.length}</span>}
          </summary>
          <div className="how-body">
            {grants.length === 0 ? (
              <p className="empty-proofs">No purchases yet. Buy the dataset above to start your history.</p>
            ) : (
              <table className="preview-table">
                <thead>
                  <tr>
                    <th className="preview-th">Date</th>
                    <th className="preview-th">Price</th>
                    <th className="preview-th">Tx</th>
                    <th className="preview-th">Dataset</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map((g) => {
                    let storedRows: PersonRow[] = [];
                    let storedSummary: SnapshotSummary[] = [];
                    try {
                      const parsed = JSON.parse(g.anonymized_data);
                      const norm = normalizeSnapshot(parsed);
                      storedRows = norm.rows;
                      storedSummary = norm.summary;
                    } catch {
                      /* malformed cell — download buttons stay hidden */
                    }
                    return (
                      <tr key={g.grant_id}>
                        <td className="preview-td">{g.created_at.slice(0, 10)}</td>
                        <td className="preview-td">
                          {formatAmount(g.lamports_received, { precise: true })}
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
                        <td className="preview-td">
                          {storedRows.length > 0 ? (
                            <span className="grant-download-group">
                              <button
                                type="button"
                                onClick={() => downloadSnapshot(storedRows, storedSummary, g.grant_id, "csv")}
                                className="grant-download-btn"
                                title="Download as CSV"
                              >↓ CSV</button>
                              <button
                                type="button"
                                onClick={() => downloadSnapshot(storedRows, storedSummary, g.grant_id, "json")}
                                className="grant-download-btn"
                                title="Download as JSON"
                              >↓ JSON</button>
                            </span>
                          ) : (
                            <span className="wallet-none">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </details>
      </section>
      )}

      {/* How it works */}
      <details className="how-details">
        <summary className="how-summary">
          <span className="how-arrow">▶</span> How does this work?
        </summary>
        <div className="how-body space-y-2">
          <p>
            <strong className="how-strong">Step 1 — List.</strong> Toggle biomarkers you want to sell. The dataset is priced at <strong>0.001 SOL per contributor</strong>, so your per-capita share stays constant as the cohort grows.
          </p>
          <p>
            <strong className="how-strong">Step 2 — Pay.</strong> A researcher connects their Phantom wallet and sends devnet SOL to your wallet address via a standard transfer.
          </p>
          <p>
            <strong className="how-strong">Step 3 — Verify.</strong> The backend calls Solana devnet RPC to confirm the on-chain transfer before releasing any data. Payment verification is atomic — no data is released unless the transaction is confirmed.
          </p>
          <p>
            <strong className="how-strong">Step 4 — Anonymize. </strong> Values are aggregated across all readings — yours plus six mock backing contributors who&apos;ve opted in to the same biomarker — and Laplace noise calibrated to ε = 1.0 differential privacy is added before release. No dates, IDs, or raw values are shared.
          </p>
          <p>
            <strong className="how-strong">Step 5 — Pay everyone.</strong> Sending one transaction per contributor leaks every recipient address to the buyer and balloons gas costs. ZKHealth uses the <code className="inline-code">zkhealth_split</code> Anchor program (<code className="inline-code">program/zkhealth_split/src/lib.rs</code>) instead: a per-query escrow account holds the SOL, and the backend signs a single <code className="inline-code">release</code> instruction that atomically distributes shares across every contributor wallet. Buyer never sees individual addresses; cost stays flat regardless of contributor count.
          </p>
        </div>
      </details>
    </div>
  );
}
