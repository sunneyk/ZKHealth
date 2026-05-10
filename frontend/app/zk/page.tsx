"use client";
import { useState, useEffect } from "react";
import { toast } from "sonner";

const API = "http://127.0.0.1:8000";

type Observation = { obs_id: string; canonical_name: string; value: number; unit: string; date_effective: string };
type Proof = { proof_id: string; biomarker_name: string; claim_type: string; threshold_display: string; passes: number; solana_tx_id: string; created_at: string };
type VerifyResult = { proof_valid: boolean; signature_valid: boolean; fully_verified: boolean; passes: boolean; claim_type?: string };

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
          <p className="proof-meta">
            {proof.created_at.slice(0, 10)} · #{proof.proof_id.slice(0, 8)}
            {explorerUrl && (
              <>
                {" · "}
                <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="proof-chain-link">
                  ⛓ View on-chain ↗
                </a>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          <span className={proof.passes ? "badge-passes" : "badge-fails"}>
            {isRange
              ? (proof.passes ? "✓ in range" : "✗ out of range")
              : isAbove
              ? (proof.passes ? "✓ above" : "✗ not above")
              : (proof.passes ? "✓ passes" : "✗ fails")}
          </span>
          <button onClick={() => { navigator.clipboard.writeText(proof.proof_id); toast.success("Proof ID copied"); }} className="btn-ghost">
            Copy ID
          </button>
          <button onClick={handleExport} disabled={downloading} className="btn-ghost">
            {downloading ? "…" : "Export"}
          </button>
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
          {explorerUrl && (
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="proof-chain-link block pt-1">
              ⛓ View on-chain anchor on Solana Explorer ↗
            </a>
          )}
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
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/observations`).then(r => r.json()).then(setObservations).catch(() => {});
    fetch(`${API}/api/zk/list`).then(r => r.json()).then(setProofs).catch(() => {});
  }, []);

  function handleObsChange(id: string) {
    setSelectedObs(id);
    const obs = observations.find(o => o.obs_id === id);
    if (obs) setBiomarkerName(obs.canonical_name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
  }

  // Smart-suggest claims. Each suggestion lists every canonical name a parser
  // might produce for the same biomarker; first matching observation wins.
  type Suggestion = { canonicals: string[]; label: string; mode: "below" | "above"; threshold: number };
  const SUGGESTIONS: Suggestion[] = [
    // Lipid panel
    { canonicals: ["cholesterol", "total_cholesterol"],          label: "Cholesterol below 200", mode: "below", threshold: 200 },
    { canonicals: ["ldl"],                                       label: "LDL below 130",         mode: "below", threshold: 130 },
    { canonicals: ["hdl", "hdl_cholesterol"],                    label: "HDL above 40",          mode: "above", threshold: 40  },
    { canonicals: ["non_hdl", "non-hdl_cholesterol"],            label: "Non-HDL below 130",     mode: "below", threshold: 130 },
    { canonicals: ["triglycerides"],                             label: "Triglycerides below 150", mode: "below", threshold: 150 },
    // Glucose / diabetes
    { canonicals: ["glucose", "glucose_(fasting)"],              label: "Glucose below 100",     mode: "below", threshold: 100 },
    { canonicals: ["hba1c", "hba", "hemoglobin_a"],              label: "HbA1c below 5.7",       mode: "below", threshold: 5.7 },
    { canonicals: ["estimated_avg_glucose", "estimated_avg_glucose_(eag)"], label: "Avg glucose below 117", mode: "below", threshold: 117 },
    // Inflammation
    { canonicals: ["crp", "hs-crp_(high-sensitivity)"],          label: "CRP below 1.0",         mode: "below", threshold: 1.0 },
    // Thyroid
    { canonicals: ["tsh", "tsh_(thyroid_stimulating_hormone)"],  label: "TSH below 4.0",         mode: "below", threshold: 4.0 },
    // Iron / anemia
    { canonicals: ["ferritin"],                                  label: "Ferritin above 30",     mode: "above", threshold: 30  },
    { canonicals: ["iron_saturation"],                           label: "Iron saturation above 20", mode: "above", threshold: 20 },
    // Vitamins
    { canonicals: ["vitamin_d", "oh_total"],                     label: "Vitamin D above 30",    mode: "above", threshold: 30  },
    { canonicals: ["vitamin_b12", "vitamin_b"],                  label: "B12 above 200",         mode: "above", threshold: 200 },
    { canonicals: ["folate"],                                    label: "Folate above 4",        mode: "above", threshold: 4   },
    // Metabolic / kidney
    { canonicals: ["creatinine"],                                label: "Creatinine below 1.3",  mode: "below", threshold: 1.3 },
    { canonicals: ["egfr"],                                      label: "eGFR above 60",         mode: "above", threshold: 60  },
    { canonicals: ["bun", "blood_urea_nitrogen_(bun)"],          label: "BUN below 20",          mode: "below", threshold: 20  },
    // Liver
    { canonicals: ["alt"],                                       label: "ALT below 56",          mode: "below", threshold: 56  },
    { canonicals: ["ast"],                                       label: "AST below 40",          mode: "below", threshold: 40  },
    // Minerals
    { canonicals: ["calcium"],                                   label: "Calcium above 8.5",     mode: "above", threshold: 8.5 },
    { canonicals: ["magnesium"],                                 label: "Magnesium above 1.7",   mode: "above", threshold: 1.7 },
    { canonicals: ["potassium"],                                 label: "Potassium above 3.5",   mode: "above", threshold: 3.5 },
    { canonicals: ["sodium"],                                    label: "Sodium above 135",      mode: "above", threshold: 135 },
    { canonicals: ["zinc"],                                      label: "Zinc above 60",         mode: "above", threshold: 60  },
    // CBC
    { canonicals: ["hemoglobin"],                                label: "Hemoglobin above 12",   mode: "above", threshold: 12  },
    { canonicals: ["platelets", "platelet_count"],               label: "Platelets above 150",   mode: "above", threshold: 150 },
    { canonicals: ["wbc", "white_blood_cell_count_(wbc)"],       label: "WBC above 4",           mode: "above", threshold: 4   },
  ];
  const availableSuggestions = SUGGESTIONS.filter(s =>
    observations.some(o => s.canonicals.includes(o.canonical_name))
  );

  function applySuggestion(s: Suggestion) {
    const obs = observations.find(o => s.canonicals.includes(o.canonical_name));
    if (!obs) return;
    setSelectedObs(obs.obs_id);
    setBiomarkerName(obs.canonical_name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
    setProofMode(s.mode);
    setThreshold(String(s.threshold));
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
        <p className="section-label">Generate proof</p>
        {observations.length === 0 ? (
          <div className="card">
            <p className="empty-state">
              No lab results yet — upload a file on the Chat page first.
            </p>
          </div>
        ) : (
          <div className="card space-y-4">
            {availableSuggestions.length > 0 && (() => {
              const COLLAPSED_COUNT = 5;
              const visible = showAllSuggestions
                ? availableSuggestions
                : availableSuggestions.slice(0, COLLAPSED_COUNT);
              const hiddenCount = availableSuggestions.length - COLLAPSED_COUNT;
              return (
                <div>
                  <p className="form-label">Quick claims</p>
                  <div className="flex gap-2 flex-wrap">
                    {visible.map(s => (
                      <button key={s.label} type="button"
                        className="btn-mode" onClick={() => applySuggestion(s)}>
                        {s.mode === "above" ? "↑" : "↓"} {s.label}
                      </button>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        className="btn-mode-ghost"
                        onClick={() => setShowAllSuggestions(s => !s)}
                      >
                        {showAllSuggestions ? "Show less" : `+${hiddenCount} more`} {showAllSuggestions ? "↑" : "↓"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
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
