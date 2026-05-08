"use client";
import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import Link from "next/link";

const API = "http://127.0.0.1:8000";

type Observation = { obs_id: string; canonical_name: string; value: number; unit: string; date_effective: string };
type Proof = { proof_id: string; biomarker_name: string; claim_type: string; threshold_display: string; passes: number; solana_tx_id: string; created_at: string };
type VerifyResult = { proof_valid: boolean; signature_valid: boolean; fully_verified: boolean; passes: boolean; claim_type?: string };

function WalletBar() {
  const { publicKey, connected, connecting, connect, disconnect, select, wallets } = useWallet();
  const [savedKey, setSavedKey] = useState("");
  const [pendingConnect, setPendingConnect] = useState(false);
  const [airdropping, setAirdropping] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/zk/wallet`).then(r => r.json()).then(d => setSavedKey(d.pubkey || "")).catch(() => {});
  }, []);

  useEffect(() => {
    if (connected && publicKey) {
      const key = publicKey.toBase58();
      fetch(`${API}/api/zk/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: key }),
      }).then(() => setSavedKey(key)).catch(() => {});
    }
  }, [connected, publicKey]);

  useEffect(() => {
    if (pendingConnect && !connected && !connecting) {
      connect().catch(() => toast.error("Phantom not found — install from phantom.app"));
      setPendingConnect(false);
    }
  }, [pendingConnect, connected, connecting, connect]);

  async function handleAirdrop() {
    if (!publicKey) return;
    setAirdropping(true);
    try {
      const res = await fetch("https://api.devnet.solana.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "requestAirdrop",
          params: [publicKey.toBase58(), 1_000_000_000],
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      toast.success("1 SOL airdropped — may take a few seconds to confirm");
    } catch (err: unknown) {
      toast.error(`Airdrop failed: ${err instanceof Error ? err.message : "rate limited — try again later"}`);
    } finally {
      setAirdropping(false);
    }
  }

  function handleConnect() {
    if (connected) { disconnect(); return; }
    const phantom = wallets.find(w => w.adapter.name === "Phantom");
    if (!phantom) { toast.error("Phantom not found — install from phantom.app"); return; }
    select(phantom.adapter.name);
    setPendingConnect(true);
  }

  const displayKey = connected && publicKey ? publicKey.toBase58() : null;

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="wallet-icon"><span className="text-sm">◎</span></div>
          <div className="min-w-0">
            <p className="section-label">Solana Wallet</p>
            {displayKey ? (
              <div className="flex items-center gap-1.5 mt-0.5">
                <p className="wallet-key truncate">{displayKey.slice(0, 8)}…{displayKey.slice(-6)}</p>
                <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(displayKey); toast.success("Copied"); }} title="Copy">⧉</button>
              </div>
            ) : savedKey
              ? <p className="wallet-saved mt-0.5 truncate">Saved: {savedKey.slice(0, 8)}…</p>
              : <p className="wallet-none mt-0.5">Not connected</p>
            }
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {connected && (
            <button onClick={handleAirdrop} disabled={airdropping} className="btn-ghost">
              {airdropping ? "…" : "Airdrop 1 SOL"}
            </button>
          )}
          <button onClick={handleConnect} disabled={connecting} className={connected ? "btn-disconnect" : "btn-connect"}>
            {connecting ? "Connecting…" : connected ? "Disconnect" : "Connect Phantom"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProofRow({ proof }: { proof: Proof }) {
  const [vr, setVr] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const isRange = proof.claim_type === "range";
  const isAbove = proof.claim_type === "threshold_gt";

  async function handleVerify() {
    setVerifying(true);
    try {
      const res = await fetch(`${API}/api/zk/verify/${proof.proof_id}`);
      setVr(await res.json());
    } catch { toast.error("Verification failed"); }
    finally { setVerifying(false); }
  }

  async function handleExport() {
    setDownloading(true);
    try {
      const res = await fetch(`${API}/api/zk/export/${proof.proof_id}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `zkhealth_proof_${proof.proof_id.slice(0, 8)}.html`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { toast.error("Export failed"); }
    finally { setDownloading(false); }
  }

  const explorerUrl = proof.solana_tx_id
    ? `https://explorer.solana.com/tx/${proof.solana_tx_id}?cluster=devnet`
    : null;

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="proof-name truncate">
            {proof.biomarker_name}
            <span className="proof-threshold">
              {isRange ? `in ${proof.threshold_display}` : ` ${proof.threshold_display}`}
            </span>
            {isRange && <span className="proof-type-badge">range</span>}
          </p>
          <p className="proof-meta">{proof.created_at.slice(0, 10)} · #{proof.proof_id.slice(0, 8)}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          <span className={proof.passes ? "badge-passes" : "badge-fails"}>
            {isRange
              ? (proof.passes ? "✓ in range" : "✗ out of range")
              : isAbove
              ? (proof.passes ? "✓ above" : "✗ not above")
              : (proof.passes ? "✓ passes" : "✗ fails")}
          </span>
          {explorerUrl && (
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="solana-link">Solana ↗</a>
          )}
          <button onClick={() => { navigator.clipboard.writeText(proof.proof_id); toast.success("Proof ID copied"); }} className="btn-ghost">
            Copy ID
          </button>
          <Link href={`/zk/verify/${proof.proof_id}`} className="btn-ghost">
            Share
          </Link>
          {!isRange && !isAbove && (
            <button onClick={handleExport} disabled={downloading} className="btn-ghost">
              {downloading ? "…" : "Export"}
            </button>
          )}
          <button onClick={handleVerify} disabled={verifying} className="btn-verify">
            {verifying ? "…" : "Verify"}
          </button>
        </div>
      </div>

      {vr && (
        <div className="card-sunk space-y-1.5">
          <p className={vr.fully_verified ? "verify-ok" : "verify-fail"}>
            {vr.fully_verified ? "✓ Fully verified" : "✗ Verification failed"}
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className={vr.proof_valid ? "verify-check-ok" : "verify-check-fail"}>{vr.proof_valid ? "✓" : "✗"} Circuit proof</span>
            <span className={vr.signature_valid ? "verify-check-ok" : "verify-check-fail"}>{vr.signature_valid ? "✓" : "✗"} Attestation</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ZkPage() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [selectedObs, setSelectedObs] = useState("");
  const [proofMode, setProofMode] = useState<"below" | "above" | "range">("below");
  const [threshold, setThreshold] = useState("");
  const [thresholdLow, setThresholdLow] = useState("");
  const [thresholdHigh, setThresholdHigh] = useState("");
  const [biomarkerName, setBiomarkerName] = useState("");
  const [anchorOnChain, setAnchorOnChain] = useState(true);
  const [proving, setProving] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/observations`).then(r => r.json()).then(setObservations).catch(() => {});
    fetch(`${API}/api/zk/list`).then(r => r.json()).then(setProofs).catch(() => {});
  }, []);

  function handleObsChange(id: string) {
    setSelectedObs(id);
    const obs = observations.find(o => o.obs_id === id);
    if (obs) setBiomarkerName(obs.canonical_name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
  }

  async function handleProve(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedObs || !biomarkerName) return;
    setProving(true);
    try {
      let result;
      if (proofMode === "range") {
        const lo = parseFloat(thresholdLow), hi = parseFloat(thresholdHigh);
        if (isNaN(lo) || lo <= 0 || isNaN(hi) || hi <= 0) { toast.error("Both thresholds must be positive"); return; }
        if (lo >= hi) { toast.error("Low must be less than High"); return; }
        const res = await fetch(`${API}/api/zk/prove_range`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ obs_id: selectedObs, threshold_low: lo, threshold_high: hi, biomarker_name: biomarkerName, anchor_on_chain: anchorOnChain }),
        });
        if (!res.ok) throw new Error((await res.json()).detail);
        result = await res.json();
        toast.success(result.in_range ? "Range proof generated — value is in range ✓" : "Range proof generated — value is out of range");
        setThresholdLow(""); setThresholdHigh("");
      } else {
        const t = parseFloat(threshold);
        if (isNaN(t) || t <= 0) { toast.error("Threshold must be positive"); return; }
        const res = await fetch(`${API}/api/zk/prove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ obs_id: selectedObs, threshold: t, biomarker_name: biomarkerName, direction: proofMode, anchor_on_chain: anchorOnChain }),
        });
        if (!res.ok) throw new Error((await res.json()).detail);
        result = await res.json();
        const dir = proofMode === "above" ? "above" : "below";
        toast.success(result.passes ? `Proof generated — value is ${dir} threshold ✓` : `Proof generated — value is NOT ${dir} threshold`);
        setThreshold("");
      }
      const updated = await fetch(`${API}/api/zk/list`).then(r => r.json());
      setProofs(updated);
      setSelectedObs("");
    } catch (err: unknown) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setProving(false); }
  }

  return (
    <div className="space-y-8 cascade">
      <div>
        <h1 className="page-title">ZK Proofs</h1>
        <p className="page-subtitle">Prove a health claim without revealing your actual value.</p>
      </div>

      <section className="space-y-2">
        <p className="section-label">Solana wallet</p>
        <WalletBar />
      </section>

      <section className="space-y-2">
        <p className="section-label">Generate proof</p>
        {observations.length === 0 ? (
          <div className="card">
            <p className="empty-state">
              No lab results yet — upload a file on the Chat page first.
            </p>
          </div>
        ) : (
          <div className="card">
            <form onSubmit={handleProve} className="space-y-4">
              <div>
                <label className="form-label">Lab observation</label>
                <select value={selectedObs} onChange={e => handleObsChange(e.target.value)} required className="form-input">
                  <option value="">Select a result…</option>
                  {observations.map(o => (
                    <option key={o.obs_id} value={o.obs_id}>
                      {o.canonical_name.replace(/_/g, " ")} — {o.value} {o.unit} ({o.date_effective || "no date"})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label">Biomarker label</label>
                <input type="text" value={biomarkerName} onChange={e => setBiomarkerName(e.target.value)}
                  placeholder="e.g. Ferritin" required className="form-input" />
              </div>

              {/* 3-way proof mode toggle */}
              <div>
                <label className="form-label">Claim type</label>
                <div className="flex gap-2 flex-wrap">
                  <button type="button" className={proofMode === "below" ? "btn-mode-active" : "btn-mode"} onClick={() => setProofMode("below")}>
                    ↓ Below
                  </button>
                  <button type="button" className={proofMode === "above" ? "btn-mode-active" : "btn-mode"} onClick={() => setProofMode("above")}>
                    ↑ Above
                  </button>
                  <button type="button" className={proofMode === "range" ? "btn-mode-active" : "btn-mode"} onClick={() => setProofMode("range")}>
                    ↔ Range
                  </button>
                </div>
              </div>

              {proofMode !== "range" ? (
                <div>
                  <label className="form-label">
                    {proofMode === "below" ? "Prove value is below this threshold" : "Prove value is above this threshold"}
                  </label>
                  <input type="number" step="any" min="0.001" value={threshold}
                    onChange={e => setThreshold(e.target.value)}
                    placeholder={proofMode === "below" ? "e.g. 100" : "e.g. 30"}
                    required className="form-input" />
                </div>
              ) : (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="form-label">Low (inclusive)</label>
                    <input type="number" step="any" min="0.001" value={thresholdLow}
                      onChange={e => setThresholdLow(e.target.value)} placeholder="e.g. 70" required className="form-input" />
                  </div>
                  <div className="flex-1">
                    <label className="form-label">High (exclusive)</label>
                    <input type="number" step="any" min="0.001" value={thresholdHigh}
                      onChange={e => setThresholdHigh(e.target.value)} placeholder="e.g. 99" required className="form-input" />
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" checked={anchorOnChain} onChange={e => setAnchorOnChain(e.target.checked)}
                  className="anchor-checkbox" />
                <span className="anchor-label">Anchor on Solana devnet</span>
              </label>
              <button type="submit"
                disabled={proving || !selectedObs || (proofMode === "range" ? !thresholdLow || !thresholdHigh : !threshold)}
                className="btn-primary-md">
                {proving
                  ? `Generating ${proofMode === "range" ? "2 proofs" : "proof"}… (${proofMode === "range" ? "10–25s" : "5–15s"})`
                  : proofMode === "range" ? "Generate Range Proof" : `Generate ZK Proof (${proofMode})`}
              </button>
            </form>
          </div>
        )}
      </section>

      <section>
        <details className="proofs-details" open={proofs.length > 0}>
          <summary className="proofs-summary">
            <span className="how-arrow">▶</span>
            Your proofs
            {proofs.length > 0 && <span className="proofs-count">{proofs.length}</span>}
          </summary>
          <div className="proofs-body">
            {proofs.length === 0
              ? <p className="empty-proofs">No proofs yet.</p>
              : <div className="space-y-2 cascade">{proofs.map(p => <ProofRow key={p.proof_id} proof={p} />)}</div>
            }
          </div>
        </details>
      </section>

      <details className="how-details">
        <summary className="how-summary">
          <span className="how-arrow">▶</span> How does this work?
        </summary>
        <div className="how-body space-y-2">
          <p><strong className="how-strong">Step 1 — Attestation.</strong> Each numeric result is hashed with Poseidon and signed with a mock Ed25519 key, binding the value to a trusted source without revealing it.</p>
          <p><strong className="how-strong">Step 2 — Proof.</strong> A Groth16 circuit (circom + snarkjs) proves your value is below the threshold. Only the commitment, threshold, and pass/fail bit are public.</p>
          <p><strong className="how-strong">Step 3 — Anchor.</strong> A SHA-256 hash of the proof is posted as a Memo transaction to Solana devnet. PHI never touches the chain.</p>
          <p><strong className="how-strong">Export.</strong> Download a self-contained HTML file — no install required for your provider to verify.</p>
        </div>
      </details>
    </div>
  );
}
