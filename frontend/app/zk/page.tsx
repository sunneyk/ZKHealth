"use client";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Modal } from "../components/Modal";
import { biomarkerLabel } from "../lib/biomarkerLabel";

const API = "http://127.0.0.1:8000";

// ── Research studies catalog ──────────────────────────────────────────────────
type StudyEligibility =
  | { biomarker: string; mode: "below" | "above"; threshold: number; unit: string; description: string }
  | { biomarker: string; mode: "range"; threshold_low: number; threshold_high: number; unit: string; description: string };

type Study = {
  id: string;
  title: string;
  institution: string;
  description: string;
  eligibility: StudyEligibility;
  compensation: string;
  duration: string;
  enrollment: "Recruiting" | "Closing soon" | "Open";
};

const STUDIES: Study[] = [
  {
    id: "stillwater-iron-recovery",
    title: "Iron Deficiency Recovery Trial",
    institution: "Stillwater Iron Studies Group",
    description: "Eight-week trial comparing alternate-day vs. daily oral iron supplementation in adults with low ferritin. Bi-weekly check-ins with the research team plus a final repeat panel.",
    eligibility: { biomarker: "ferritin", mode: "below", threshold: 30, unit: "ng/mL",
      description: "Ferritin below 30 ng/mL" },
    compensation: "$200 + free supplements",
    duration: "8 weeks",
    enrollment: "Recruiting",
  },
  {
    id: "fairhaven-vitamin-d",
    title: "Vitamin D and Subjective Energy",
    institution: "Fairhaven Nutrition Sciences",
    description: "Crossover study on whether 2,000 IU/day vitamin D3 improves self-reported energy in adults with insufficient levels. Daily symptom journal via the study app.",
    eligibility: { biomarker: "vitamin_d", mode: "below", threshold: 30, unit: "ng/mL",
      description: "Vitamin D below 30 ng/mL" },
    compensation: "$150 + supplements",
    duration: "12 weeks",
    enrollment: "Recruiting",
  },
  {
    id: "helix-hrv-recovery",
    title: "HRV-Based Recovery Cohort",
    institution: "Helix Longevity Labs",
    description: "Observational study of adults with sustained low HRV (<40 ms) to characterize recovery patterns and identify reversible drivers. Wearable data shared weekly.",
    eligibility: { biomarker: "hrv", mode: "below", threshold: 40, unit: "ms",
      description: "Recent HRV below 40 ms" },
    compensation: "$75 + wearable credit",
    duration: "6 weeks",
    enrollment: "Recruiting",
  },
  {
    id: "concord-glucose-baseline",
    title: "Healthy Glucose Baseline Cohort",
    institution: "Concord Health Research",
    description: "Prospective cohort enrolling adults with normal HbA1c to characterize day-to-day glucose patterns via CGM. Free continuous glucose monitor for the duration.",
    eligibility: { biomarker: "hba1c", mode: "below", threshold: 5.7, unit: "%",
      description: "HbA1c below 5.7%" },
    compensation: "$300 + free CGM",
    duration: "4 weeks",
    enrollment: "Recruiting",
  },
  {
    id: "pioneer-borderline-anemia",
    title: "Borderline Anemia Outreach",
    institution: "Pioneer Hematology Network",
    description: "Screening + counseling program for women with hemoglobin in the low-normal range. One nutrition consult, no investigational treatment.",
    eligibility: { biomarker: "hemoglobin", mode: "below", threshold: 13.0, unit: "g/dL",
      description: "Hemoglobin below 13.0 g/dL" },
    compensation: "$50 gift card",
    duration: "Single visit",
    enrollment: "Open",
  },
  {
    id: "solstice-active-heart",
    title: "Active Adults Heart Study",
    institution: "Solstice Cardio Research",
    description: "Long-term passive observation cohort tracking resting heart rate and rhythm in adults with healthy cardiovascular baselines. Wearable required (provided).",
    eligibility: { biomarker: "heart_rate_resting", mode: "below", threshold: 75, unit: "bpm",
      description: "Resting HR below 75 bpm" },
    compensation: "Free wearable device",
    duration: "12 months",
    enrollment: "Open",
  },
  {
    id: "lighthouse-lipid-cohort",
    title: "Heart-Healthy Lipid Cohort",
    institution: "Lighthouse Cardiometabolic Lab",
    description: "Reference cohort of adults with total cholesterol below 200 mg/dL — used as the control arm in upcoming statin-deprescribing trials. One annual lipid panel.",
    eligibility: { biomarker: "cholesterol", mode: "below", threshold: 200, unit: "mg/dL",
      description: "Total cholesterol below 200 mg/dL" },
    compensation: "$100/year",
    duration: "5 years",
    enrollment: "Open",
  },
  {
    id: "cedarhill-thyroid-baseline",
    title: "Optimal Thyroid Function Study",
    institution: "Cedar Hill Endocrine Research",
    description: "Reference baseline cohort for adults with TSH in the optimal range (0.5-3.0). Used for future biomarker-correlation studies.",
    eligibility: { biomarker: "tsh", mode: "range", threshold_low: 0.5, threshold_high: 3.0, unit: "uIU/mL",
      description: "TSH between 0.5 and 3.0 uIU/mL" },
    compensation: "$80",
    duration: "Single visit",
    enrollment: "Open",
  },
  {
    id: "atlas-tibc-study",
    title: "Iron Transport Capacity Study",
    institution: "Atlas Biomarker Foundation",
    description: "Mechanistic study of iron transport in adults with elevated TIBC (a sign the body is upregulating iron uptake). Includes a tracer study with stable-isotope iron.",
    eligibility: { biomarker: "tibc", mode: "above", threshold: 350, unit: "ug/dL",
      description: "TIBC above 350 ug/dL" },
    compensation: "$250",
    duration: "3 visits over 4 weeks",
    enrollment: "Recruiting",
  },
  {
    id: "civic-diabetes-risk",
    title: "Type 2 Diabetes Risk Screening",
    institution: "Civic Health Research Institute",
    description: "Recruiting adults with elevated HbA1c for an early-intervention lifestyle program — diabetes prevention curriculum, group sessions, coach check-ins.",
    eligibility: { biomarker: "hba1c", mode: "above", threshold: 6.5, unit: "%",
      description: "HbA1c above 6.5%" },
    compensation: "Free 16-week prevention program",
    duration: "16 weeks",
    enrollment: "Recruiting",
  },
  {
    id: "beacon-high-hdl",
    title: "High-HDL Longitudinal Cohort",
    institution: "Beacon Cardiometabolic Group",
    description: "Long-term cohort of adults with HDL above 60 mg/dL — investigating cardiovascular outcomes in this naturally protected group.",
    eligibility: { biomarker: "hdl", mode: "above", threshold: 60, unit: "mg/dL",
      description: "HDL above 60 mg/dL" },
    compensation: "$120/year",
    duration: "10 years (annual visit)",
    enrollment: "Open",
  },
  {
    id: "northbridge-long-sleep",
    title: "Long Sleep Pattern Study",
    institution: "Northbridge Sleep Institute",
    description: "Observational cohort for adults averaging more than 8 hours of sleep per night. Examining metabolic and cognitive effects of long-sleep phenotypes.",
    eligibility: { biomarker: "sleep_hours", mode: "above", threshold: 8.0, unit: "h",
      description: "Average sleep above 8 hours" },
    compensation: "$60",
    duration: "4 weeks",
    enrollment: "Open",
  },
  {
    id: "meridian-endurance",
    title: "Endurance Athlete Baseline",
    institution: "Meridian Sports Science Lab",
    description: "Reference population for elite endurance athletes — resting HR below 55 bpm. Used to calibrate training-load algorithms.",
    eligibility: { biomarker: "heart_rate_resting", mode: "below", threshold: 55, unit: "bpm",
      description: "Resting HR below 55 bpm" },
    compensation: "$200 + VO2 max test",
    duration: "Single visit",
    enrollment: "Closing soon",
  },
  {
    id: "westgate-hydration",
    title: "Hydration Marker Validation",
    institution: "Westgate Renal Group",
    description: "Methods study correlating BUN with hydration biomarkers (urine specific gravity, copeptin). One blood draw plus a 7-day fluid log.",
    eligibility: { biomarker: "bun", mode: "below", threshold: 20, unit: "mg/dL",
      description: "BUN below 20 mg/dL" },
    compensation: "$90",
    duration: "1 week",
    enrollment: "Open",
  },
];

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
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // 1) Trigger the download
      const a = document.createElement("a");
      a.href = url;
      a.download = `zkhealth_proof_${proof.proof_id.slice(0, 8)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 2) Open the same blob in a new tab so the verifier can be reviewed instantly
      window.open(url, "_blank", "noopener,noreferrer");
      // Revoke after a delay so the new tab has time to load the resource
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("Verifier downloaded — preview opened in a new tab");
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

function StudyCard({ study, qualifies, onOpen }: {
  study: Study;
  qualifies: boolean | null;
  onOpen: () => void;
}) {
  const status = qualifies === true ? "qualifies" : qualifies === false ? "no-match" : "unknown";
  return (
    <button type="button" onClick={onOpen} className={`study-card study-card-${status}`}>
      <div className="study-card-top">
        <span className="study-card-institution">{study.institution}</span>
        {qualifies === true && <span className="study-card-pill">✓ qualifies</span>}
        {qualifies === false && <span className="study-card-pill study-card-pill-muted">no match</span>}
      </div>
      <h3 className="study-card-title">{study.title}</h3>
      <p className="study-card-criteria">{study.eligibility.description}</p>
      <div className="study-card-footer">
        <span className="study-card-comp">{study.compensation}</span>
        <span className="study-card-meta">{study.duration}</span>
      </div>
    </button>
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
  const [openStudy, setOpenStudy] = useState<Study | null>(null);
  const [submittingStudy, setSubmittingStudy] = useState(false);

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

  // Find the user's most-recent observation matching the study's biomarker.
  // Observations are ordered by date descending in the API response.
  function userMatchForStudy(study: Study): { obs: Observation | undefined; qualifies: boolean | null } {
    const obs = observations.find(o => o.canonical_name === study.eligibility.biomarker);
    if (!obs) return { obs: undefined, qualifies: null };
    const v = obs.value;
    let qualifies = false;
    if (study.eligibility.mode === "below") qualifies = v < study.eligibility.threshold;
    else if (study.eligibility.mode === "above") qualifies = v > study.eligibility.threshold;
    else qualifies = v >= study.eligibility.threshold_low && v < study.eligibility.threshold_high;
    return { obs, qualifies };
  }

  async function handleStudySubmit(study: Study) {
    const { obs, qualifies } = userMatchForStudy(study);
    if (!obs || !qualifies) return;
    setSubmittingStudy(true);
    try {
      const proofBiomarkerName = `${biomarkerLabel(study.eligibility.biomarker)} → ${study.institution}`;
      let res: Response;
      if (study.eligibility.mode === "range") {
        res = await fetch(`${API}/api/zk/prove_range`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            obs_id: obs.obs_id,
            threshold_low: study.eligibility.threshold_low,
            threshold_high: study.eligibility.threshold_high,
            biomarker_name: proofBiomarkerName,
            anchor_on_chain: true,
          }),
        });
      } else {
        res = await fetch(`${API}/api/zk/prove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            obs_id: obs.obs_id,
            threshold: study.eligibility.threshold,
            direction: study.eligibility.mode,
            biomarker_name: proofBiomarkerName,
            anchor_on_chain: true,
          }),
        });
      }
      if (!res.ok) throw new Error((await res.json()).detail);
      toast.success(`Eligibility proof sent to ${study.institution}`);
      const updated = await fetch(`${API}/api/zk/list`).then(r => r.json());
      setProofs(updated);
      setOpenStudy(null);
    } catch (err: unknown) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmittingStudy(false);
    }
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

  // Pre-rank studies: ones the user qualifies for first, then unknown, then no-match.
  const rankedStudies = STUDIES.map((s) => ({ study: s, ...userMatchForStudy(s) }))
    .sort((a, b) => {
      const order = (q: boolean | null) => (q === true ? 0 : q === null ? 1 : 2);
      return order(a.qualifies) - order(b.qualifies);
    });

  return (
    <div className="space-y-8 cascade">
      <div>
        <h1 className="page-title">ZK Proofs</h1>
        <p className="page-subtitle">Prove a health claim without revealing your actual value.</p>
      </div>

      <section>
        <details className="how-details" open>
          <summary className="how-summary">
            <span className="how-arrow">▶</span>
            <span>Research studies</span>
            <span className="proofs-count">
              {rankedStudies.filter(r => r.qualifies === true).length}/{STUDIES.length}
            </span>
          </summary>
          <div className="how-body study-section-body">
            <p className="study-section-hint">
              Apply via ZK proof — your value stays private. Scroll to browse all {STUDIES.length} studies; ones that match your data are first.
            </p>
            <div className="study-scroll">
              {rankedStudies.map(({ study, qualifies }) => (
                <StudyCard
                  key={study.id}
                  study={study}
                  qualifies={qualifies}
                  onOpen={() => setOpenStudy(study)}
                />
              ))}
            </div>
          </div>
        </details>
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

      {/* Study apply modal */}
      {(() => {
        if (!openStudy) {
          return (
            <Modal open={false} onClose={() => setOpenStudy(null)} title="">
              <></>
            </Modal>
          );
        }
        const { obs, qualifies } = userMatchForStudy(openStudy);
        const elig = openStudy.eligibility;
        const claimText = elig.mode === "range"
          ? `${biomarkerLabel(elig.biomarker)} between ${elig.threshold_low} and ${elig.threshold_high} ${elig.unit}`
          : `${biomarkerLabel(elig.biomarker)} ${elig.mode} ${elig.threshold} ${elig.unit}`;
        return (
          <Modal
            open
            onClose={() => setOpenStudy(null)}
            title={openStudy.title}
            subtitle={openStudy.institution}
            footer={
              <>
                <button type="button" onClick={() => setOpenStudy(null)} className="btn-ghost">Cancel</button>
                <button
                  type="button"
                  onClick={() => handleStudySubmit(openStudy)}
                  disabled={submittingStudy || !obs || !qualifies}
                  className="btn-connect"
                >
                  {submittingStudy
                    ? "Sending proof…"
                    : !obs
                    ? "No matching data"
                    : !qualifies
                    ? "Doesn't match your data"
                    : `Confirm & send proof to ${openStudy.institution}`}
                </button>
              </>
            }
          >
            <div className="study-modal-body">
              <p className="study-modal-description">{openStudy.description}</p>

              <div className="study-modal-grid">
                <div className="study-modal-cell">
                  <span className="study-modal-label">Compensation</span>
                  <span className="study-modal-value">{openStudy.compensation}</span>
                </div>
                <div className="study-modal-cell">
                  <span className="study-modal-label">Duration</span>
                  <span className="study-modal-value">{openStudy.duration}</span>
                </div>
                <div className="study-modal-cell">
                  <span className="study-modal-label">Status</span>
                  <span className="study-modal-value">{openStudy.enrollment}</span>
                </div>
              </div>

              <div className="study-modal-section">
                <p className="study-modal-section-label">Eligibility</p>
                <p className="study-modal-eligibility">{elig.description}</p>
              </div>

              <div className={`study-modal-match study-modal-match-${qualifies === true ? "pass" : qualifies === false ? "fail" : "missing"}`}>
                {!obs ? (
                  <span>You don&apos;t have data for <strong>{biomarkerLabel(elig.biomarker)}</strong> yet — upload more data on the Chat page first.</span>
                ) : qualifies ? (
                  <span>✓ Your <strong>{biomarkerLabel(elig.biomarker)}</strong> data matches. Sending will generate a ZK proof of <strong>{claimText}</strong> — your actual value is never revealed.</span>
                ) : (
                  <span>✗ Your most recent <strong>{biomarkerLabel(elig.biomarker)}</strong> doesn&apos;t fit this study&apos;s criteria. (We can still send the proof; the institution will see it does not pass.)</span>
                )}
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
