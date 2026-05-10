"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

const API = "http://127.0.0.1:8000";

type VerifyResponse = {
  proof_id: string;
  claim_type: "threshold_lt" | "threshold_gt" | "range";
  biomarker_name: string;
  threshold_display: string;
  passes: boolean;
  proof_valid: boolean;
  signature_valid: boolean;
  fully_verified: boolean;
  date_int?: number;
  solana_tx_id: string;
  created_at: string;
};

export default function ProofVerifyPage({ params }: { params: Promise<{ proof_id: string }> }) {
  const { proof_id } = use(params);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/zk/verify/${proof_id}`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then(d => d && setResult(d))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [proof_id]);

  const dateStr = result?.date_int
    ? String(result.date_int).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
    : null;

  const explorerUrl = result?.solana_tx_id
    ? `https://explorer.solana.com/tx/${result.solana_tx_id}?cluster=devnet`
    : null;

  return (
    <div className="space-y-6 cascade">
      <div>
        <Link href="/zk" className="back-link">← ZK Proofs</Link>
        <h1 className="page-title mt-3">Proof Verification</h1>
        <p className="page-subtitle">Independent verification of a zero-knowledge health claim.</p>
      </div>

      {loading && (
        <div className="card">
          <p className="empty-state">Verifying…</p>
        </div>
      )}

      {!loading && notFound && (
        <div className="card">
          <p className="empty-state">Proof not found — it may only exist on this device.</p>
        </div>
      )}

      {result && (
        <>
          <div className="card space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="proof-name">
                  {result.biomarker_name}
                  <span className="proof-threshold">
                    {result.claim_type === "range"
                      ? ` in ${result.threshold_display}`
                      : ` ${result.threshold_display}`}
                  </span>
                </p>
                <p className="proof-meta">
                  {dateStr ? `${dateStr} · ` : ""}#{result.proof_id.slice(0, 8)}
                </p>
              </div>
              <span className={result.passes ? "badge-passes" : "badge-fails"}>
                {result.claim_type === "range"
                  ? (result.passes ? "✓ in range" : "✗ out of range")
                  : result.claim_type === "threshold_gt"
                  ? (result.passes ? "✓ above" : "✗ not above")
                  : (result.passes ? "✓ passes" : "✗ fails")}
              </span>
            </div>

            <div className="card-sunk space-y-1.5">
              <p className={result.fully_verified ? "verify-ok" : "verify-fail"}>
                {result.fully_verified ? "✓ Fully verified" : "✗ Verification failed"}
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className={result.proof_valid ? "verify-check-ok" : "verify-check-fail"}>
                  {result.proof_valid ? "✓" : "✗"} {result.claim_type === "range" ? "Two Groth16 circuit proofs" : "Groth16 circuit proof"}
                </span>
                <span className={result.signature_valid ? "verify-check-ok" : "verify-check-fail"}>
                  {result.signature_valid ? "✓" : "✗"} Attestation signature
                </span>
              </div>
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              {explorerUrl && (
                <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="solana-link">
                  View anchor on Solana Explorer ↗
                </a>
              )}
              <button
                className="copy-btn"
                onClick={() => { navigator.clipboard.writeText(result.proof_id); toast.success("Proof ID copied"); }}
              >
                Copy proof ID ⧉
              </button>
            </div>
          </div>

          <p className="page-subtitle">
            Verification runs against this device&apos;s proof store.
            For a portable file your provider can verify offline, use the <Link href="/zk" className="solana-link">Export</Link> button.
          </p>
        </>
      )}
    </div>
  );
}
