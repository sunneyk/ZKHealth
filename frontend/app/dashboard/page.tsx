"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from "recharts";

const API = "http://127.0.0.1:8000";

// ── Types ──────────────────────────────────────────────────────
type Doc = { doc_id: string; filename: string; doc_type: string; created_at: string; obs_count: number };
type Obs = { obs_id: string; doc_id: string; doc_type: string; canonical_name: string; value: number; unit: string; date_effective: string };
type Flag = "H" | "L" | "";
type LabEntry = { canonical: string; displayName: string; latest: Obs; history: Obs[]; refLow?: number; refHigh?: number; flag: Flag };
type SortKey = "name" | "value" | "date" | "flag";
type SortDir = "asc" | "desc" | null;

// ── Reference data ─────────────────────────────────────────────
const PANEL_MAP: Record<string, string> = {
  // CBC
  hemoglobin:"cbc", hematocrit:"cbc", rbc:"cbc", wbc:"cbc", platelets:"cbc",
  mcv:"cbc", mch:"cbc", mchc:"cbc", rdw:"cbc", mpv:"cbc",
  neutrophils:"cbc", lymphocytes:"cbc", monocytes:"cbc", eosinophils:"cbc", basophils:"cbc",
  neutrophil_count:"cbc", lymphocyte_count:"cbc",
  // Metabolic
  glucose:"metabolic", sodium:"metabolic", potassium:"metabolic", calcium:"metabolic",
  bicarbonate:"metabolic", chloride:"metabolic", bun:"metabolic", creatinine:"metabolic",
  albumin:"metabolic", total_protein:"metabolic", egfr:"metabolic", uric_acid:"metabolic",
  // Lipid
  cholesterol:"lipid", triglycerides:"lipid", hdl:"lipid", ldl:"lipid",
  vldl:"lipid", non_hdl:"lipid", apolipoprotein_b:"lipid",
  // Thyroid
  tsh:"thyroid", free_t4:"thyroid", free_t3:"thyroid", t3:"thyroid", t4:"thyroid",
  // Hormonal
  testosterone:"hormonal", free_testosterone:"hormonal", estradiol:"hormonal",
  dheas:"hormonal", dhea:"hormonal", lh:"hormonal", fsh:"hormonal",
  cortisol:"hormonal", shbg:"hormonal", igf_1:"hormonal",
  // Iron
  ferritin:"iron", iron:"iron", tibc:"iron", transferrin_saturation:"iron",
  // Liver
  alt:"liver", ast:"liver", ggt:"liver", alp:"liver", alkaline_phosphatase:"liver",
  bilirubin:"liver", direct_bilirubin:"liver",
  // Kidney
  // (creatinine + egfr also in metabolic; map to kidney if standalone)
  // Inflammation
  crp:"inflammation", esr:"inflammation", homocysteine:"inflammation",
  // Vitamins
  vitamin_d:"vitamin", vitamin_b12:"vitamin", b12:"vitamin", folate:"vitamin",
  // Minerals
  magnesium:"minerals", zinc:"minerals", copper:"minerals",
  selenium:"minerals", phosphorus:"minerals",
  // Cardiac
  ck:"cardiac", ldh:"cardiac", troponin:"cardiac", bnp:"cardiac",
  // Wearable
  steps:"activity", active_minutes:"activity", calories_burned:"activity",
  distance:"activity", floors:"activity", calories:"activity",
  heart_rate:"heart", resting_heart_rate:"heart", hrv:"heart",
  heart_rate_variability:"heart", spo2:"heart",
  sleep_score:"sleep", sleep_hours:"sleep", sleep_duration:"sleep",
  deep_sleep:"sleep", rem_sleep:"sleep", light_sleep:"sleep",
  weight:"body", bmi:"body", body_fat:"body", body_fat_percentage:"body",
  // Apple Health canonical names
  step_count:"activity", basal_energy_burned:"activity", active_energy_burned:"activity",
  walking_heart_rate:"heart", heart_rate_variability_sdnn:"heart",
};

const REF: Record<string, [number, number]> = {
  hemoglobin:[13.5,17.5], hematocrit:[41,53], rbc:[4.5,5.9], wbc:[4.5,11.0],
  platelets:[150,400], mcv:[80,100], mch:[27,33], mchc:[32,36], rdw:[11.5,14.5],
  neutrophils:[40,70], lymphocytes:[20,45], monocytes:[2,10], eosinophils:[1,6], basophils:[0,1],
  glucose:[70,99], sodium:[136,145], potassium:[3.5,5.0], calcium:[8.5,10.5],
  bicarbonate:[22,29], chloride:[98,107], bun:[7,20], creatinine:[0.7,1.3],
  albumin:[3.5,5.0], total_protein:[6.0,8.3], egfr:[60,120], uric_acid:[3.5,7.2],
  cholesterol:[0,200], triglycerides:[0,150], hdl:[40,200], ldl:[0,130], vldl:[0,30],
  tsh:[0.4,4.0], free_t4:[0.8,1.8], free_t3:[2.3,4.1], t3:[80,200], t4:[4.5,12.5],
  testosterone:[300,1000], estradiol:[10,40], cortisol:[6,23], shbg:[10,57],
  ferritin:[20,300], iron:[60,170], tibc:[240,450], transferrin_saturation:[20,50],
  alt:[7,56], ast:[10,40], ggt:[9,48], alp:[44,147], alkaline_phosphatase:[44,147],
  bilirubin:[0.1,1.2],
  crp:[0,1.0], homocysteine:[5,15], esr:[0,20],
  vitamin_d:[30,100], vitamin_b12:[200,900], b12:[200,900], folate:[2.7,17.0],
  magnesium:[1.7,2.2], zinc:[60,130], copper:[70,140], phosphorus:[2.5,4.5],
};

const LAB_PANELS: Record<string, { label: string; sym: string; order: number }> = {
  cbc:         { label:"CBC & Blood Count",   sym:"◉", order:1 },
  metabolic:   { label:"Metabolic Panel",     sym:"⬡", order:2 },
  lipid:       { label:"Lipid Panel",         sym:"♡", order:3 },
  thyroid:     { label:"Thyroid",             sym:"⌖", order:4 },
  hormonal:    { label:"Hormones",            sym:"◈", order:5 },
  iron:        { label:"Iron Studies",        sym:"◆", order:6 },
  liver:       { label:"Liver",               sym:"▽", order:7 },
  inflammation:{ label:"Inflammation",        sym:"△", order:8 },
  vitamin:     { label:"Vitamins",            sym:"✦", order:9 },
  minerals:    { label:"Minerals",            sym:"⬗", order:10 },
  cardiac:     { label:"Cardiac",             sym:"♥", order:11 },
  other_lab:   { label:"Other Lab Values",    sym:"○", order:99 },
};

const WEARABLE_PANELS: Record<string, { label: string; sym: string; order: number }> = {
  activity:        { label:"Activity",          sym:"→", order:1 },
  heart:           { label:"Heart",             sym:"♡", order:2 },
  sleep:           { label:"Sleep",             sym:"◌", order:3 },
  body:            { label:"Body Composition",  sym:"◎", order:4 },
  other_wearable:  { label:"Other Metrics",     sym:"○", order:99 },
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  lab_pdf:"Lab Results", wearable_csv:"Wearable Data", apple_health:"Apple Health",
};

// ── Helpers ─────────────────────────────────────────────────────
const LAB_ABBR = new Set(["hba1c","hdl","ldl","vldl","tsh","egfr","gfr","alt","ast","alp","ggt","crp","esr","bun","mcv","mch","mchc","rdw","mpv","wbc","rbc","hgb","hct","lh","fsh","dhea","dheas","shbg","igf","spo2","ck","ldh","bnp","hrv","bmi"]);
function formatLabName(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w+/g, w =>
    LAB_ABBR.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
}
function fmtVal(v: number): string {
  if (Number.isInteger(v)) return v.toString();
  return parseFloat(v.toPrecision(4)).toString();
}
function getFlag(v: number, lo?: number, hi?: number): Flag {
  if (lo == null || hi == null) return "";
  if (v > hi) return "H";
  if (v < lo) return "L";
  return "";
}
function rangePct(v: number, lo: number, hi: number): number {
  const pad = (hi - lo) * 0.5;
  return Math.max(2, Math.min(98, (v - (lo - pad)) / ((hi + pad) - (lo - pad)) * 100));
}
function fmtRef(lo?: number, hi?: number): string {
  if (lo != null && hi != null) return `${lo}–${hi}`;
  return "—";
}

// ── Trend chart ──────────────────────────────────────────────────
function TrendChart({ entry, colSpan }: { entry: LabEntry; colSpan: number }) {
  const data = useMemo(() =>
    [...entry.history]
      .filter(h => h.date_effective)
      .sort((a, b) => a.date_effective.localeCompare(b.date_effective))
      .map(h => ({ date: h.date_effective.slice(0, 10), value: h.value })),
    [entry.history]
  );

  if (data.length < 2) return null;

  const values = data.map(d => d.value);
  const { refLow, refHigh } = entry;
  const domainMin = Math.min(...values, refLow ?? Infinity) * 0.92;
  const domainMax = Math.max(...values, refHigh ?? -Infinity) * 1.08;

  return (
    <tr>
      <td colSpan={colSpan} className="px-4 pb-4 pt-1">
        <p className="text-[10px] text-[var(--ink-3)] mb-1.5 font-medium tracking-wide uppercase">Trend</p>
        <ResponsiveContainer width="100%" height={110}>
          <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            {refLow != null && refHigh != null && (
              <ReferenceArea y1={refLow} y2={refHigh} fill="var(--range-ok)" ifOverflow="extendDomain" />
            )}
            {refLow != null && (
              <ReferenceLine y={refLow} stroke="var(--sage)" strokeDasharray="3 3" strokeOpacity={0.5} />
            )}
            {refHigh != null && (
              <ReferenceLine y={refHigh} stroke="var(--sage)" strokeDasharray="3 3" strokeOpacity={0.5} />
            )}
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--ink-3)" }} tickLine={false} axisLine={false} />
            <YAxis domain={[domainMin, domainMax]} tick={{ fontSize: 10, fill: "var(--ink-3)" }} tickLine={false} axisLine={false} width={48} />
            <Tooltip
              contentStyle={{ background: "var(--paper-card)", border: "1px solid var(--rule-s)", borderRadius: 6, fontSize: 12 }}
              itemStyle={{ color: "var(--ink)" }}
              labelStyle={{ color: "var(--ink-3)" }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--brand)"
              strokeWidth={1.5}
              dot={{ r: 3, fill: "var(--brand)", strokeWidth: 0 }}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </td>
    </tr>
  );
}

// ── Range bar ────────────────────────────────────────────────────
function RangeBar({ value, refLow, refHigh, flag }: { value: number; refLow?: number; refHigh?: number; flag: Flag }) {
  if (refLow == null || refHigh == null) return <span className="lab-range-none">—</span>;
  const pct = rangePct(value, refLow, refHigh);
  return (
    <div className="lab-range-wrap">
      <div className="lab-range-track">
        <div className="lab-range-bad" style={{ width: "25%" }} />
        <div className="lab-range-ok"  style={{ width: "50%" }} />
        <div className="lab-range-bad" style={{ width: "25%" }} />
      </div>
      <div className={`lab-range-dot${flag === "H" ? " dot-h" : flag === "L" ? " dot-l" : ""}`} style={{ left: `${pct}%` }} />
    </div>
  );
}

// ── Flag badge ──────────────────────────────────────────────────
function FlagBadge({ flag }: { flag: Flag }) {
  if (!flag) return null;
  return (
    <span className={`flag-badge ${flag === "H" ? "flag-h" : "flag-l"}`}>
      <span className="flag-dot" />
      {flag === "H" ? "High" : "Low"}
    </span>
  );
}

// ── Source row ───────────────────────────────────────────────────
const TYPE_ICON: Record<string, string> = { lab_pdf:"🧪", apple_health:"🍎", wearable_csv:"📊" };
function SourceRow({ doc, onDelete }: { doc: Doc; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <div className="source-row">
      <span className="source-icon">{TYPE_ICON[doc.doc_type] ?? "📄"}</span>
      <div className="source-info">
        <p className="source-name">{doc.filename}</p>
        <p className="source-meta">{SOURCE_TYPE_LABEL[doc.doc_type] ?? doc.doc_type} · {doc.created_at.slice(0, 10)}</p>
      </div>
      <span className="source-count">{doc.obs_count} obs</span>
      <button
        className={confirming ? "source-del-confirm" : "source-del"}
        onClick={() => { if (!confirming) { setConfirming(true); } else { onDelete(doc.doc_id); } }}
        title={confirming ? "Click again to confirm" : "Delete source"}
      >
        {confirming ? "Delete?" : "✕"}
      </button>
    </div>
  );
}

// ── Lab table row ────────────────────────────────────────────────
function LabRow({ entry, isWearable }: { entry: LabEntry; isWearable: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasHistory = entry.history.length > 1;
  const colSpan = isWearable ? 3 : 6;

  return (
    <>
      <tr className={`lab-tr${hasHistory ? " lab-tr-clickable" : ""}`} onClick={hasHistory ? () => setExpanded(x => !x) : undefined}>
        <td className="lab-td lab-td-name">
          <span className="lab-name-wrap">
            {hasHistory && <span className={`lab-chevron${expanded ? " open" : ""}`}>›</span>}
            {formatLabName(entry.canonical)}
          </span>
        </td>
        <td className={`lab-td lab-td-value${entry.flag === "H" ? " val-h" : entry.flag === "L" ? " val-l" : ""}`}>
          {fmtVal(entry.latest.value)}
          {entry.latest.unit && <span className="lab-unit"> {entry.latest.unit}</span>}
        </td>
        {!isWearable && (
          <>
            <td className="lab-td lab-td-range">
              <RangeBar value={entry.latest.value} refLow={entry.refLow} refHigh={entry.refHigh} flag={entry.flag} />
            </td>
            <td className="lab-td lab-td-ref">{fmtRef(entry.refLow, entry.refHigh)}</td>
            <td className="lab-td lab-td-flag"><FlagBadge flag={entry.flag} /></td>
          </>
        )}
        <td className="lab-td lab-td-date">{entry.latest.date_effective || "—"}</td>
      </tr>
      {expanded && entry.history.slice(1).map((h, i) => (
        <tr key={`${entry.canonical}-h${i}`} className="lab-tr-hist">
          <td className="lab-td lab-td-name-hist">{formatLabName(entry.canonical)}</td>
          <td className="lab-td lab-td-value">
            {fmtVal(h.value)}
            {h.unit && <span className="lab-unit"> {h.unit}</span>}
          </td>
          {!isWearable && (
            <>
              <td className="lab-td lab-td-range">
                <RangeBar value={h.value} refLow={entry.refLow} refHigh={entry.refHigh} flag={getFlag(h.value, entry.refLow, entry.refHigh)} />
              </td>
              <td className="lab-td lab-td-ref">{fmtRef(entry.refLow, entry.refHigh)}</td>
              <td className="lab-td lab-td-flag"><FlagBadge flag={getFlag(h.value, entry.refLow, entry.refHigh)} /></td>
            </>
          )}
          <td className="lab-td lab-td-date">{h.date_effective || "—"}</td>
        </tr>
      ))}
      {expanded && <TrendChart entry={entry} colSpan={colSpan} />}
    </>
  );
}

// ── Panel table ──────────────────────────────────────────────────
function PanelTable({ entries, isWearable }: { entries: LabEntry[]; isWearable: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey | null; dir: SortDir }>({ key: null, dir: null });

  function handleSort(key: SortKey) {
    setSort(prev => {
      if (prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key: null, dir: null };
    });
  }

  const sorted = useMemo(() => {
    if (!sort.key || !sort.dir) return entries;
    const d = sort.dir === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => {
      if (sort.key === "name")  return d * a.canonical.localeCompare(b.canonical);
      if (sort.key === "value") return d * (a.latest.value - b.latest.value);
      if (sort.key === "date")  return d * (a.latest.date_effective ?? "").localeCompare(b.latest.date_effective ?? "");
      if (sort.key === "flag")  return d * (["H","L",""].indexOf(a.flag) - ["H","L",""].indexOf(b.flag));
      return 0;
    });
  }, [entries, sort]);

  function SortTh({ label, sk, align = "left" }: { label: string; sk: SortKey; align?: "left" | "right" | "center" }) {
    const active = sort.key === sk;
    return (
      <th className={`lab-th${active ? " lab-th-active" : ""} lab-th-${align}`} onClick={() => handleSort(sk)}>
        {label}{active && <span className="lab-sort-icon">{sort.dir === "asc" ? " ↑" : " ↓"}</span>}
      </th>
    );
  }

  return (
    <div className="lab-table-scroll">
      <table className="lab-table">
        <thead>
          <tr>
            <SortTh label="Test" sk="name" />
            <SortTh label="Value" sk="value" align="right" />
            {!isWearable && <th className="lab-th lab-th-center">Range</th>}
            {!isWearable && <th className="lab-th lab-th-right">Ref. Range</th>}
            {!isWearable && <SortTh label="Flag" sk="flag" />}
            <SortTh label="Date" sk="date" align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => <LabRow key={e.canonical} entry={e} isWearable={isWearable} />)}
        </tbody>
      </table>
    </div>
  );
}

// ── Panel card ────────────────────────────────────────────────────
function PanelCard({ panelKey, label, sym, entries, isWearable }: {
  panelKey: string; label: string; sym: string; entries: LabEntry[]; isWearable: boolean;
}) {
  const flagged = entries.filter(e => e.flag).length;
  return (
    <div className="panel-card">
      <div className="panel-header">
        <div className="panel-header-left">
          <span className="panel-sym">{sym}</span>
          <h2 className="panel-title">{label}</h2>
        </div>
        <div className="panel-header-right">
          {flagged > 0 && <span className="panel-flagged">{flagged} flagged</span>}
          <span className="panel-count">{entries.length} {entries.length === 1 ? "test" : "tests"}</span>
        </div>
      </div>
      <PanelTable entries={entries} isWearable={isWearable} />
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────
function StatCard({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="stat-card">
      <p className="stat-value">{value}</p>
      <p className="stat-label">{label}</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [obs, setObs] = useState<Obs[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API}/api/documents`).then(r => r.json()),
      fetch(`${API}/api/observations`).then(r => r.json()),
    ]).then(([d, o]) => { setDocs(d); setObs(o); })
      .catch(() => toast.error("Failed to load data"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(doc_id: string) {
    try {
      const res = await fetch(`${API}/api/documents/${doc_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Source deleted");
      load();
    } catch { toast.error("Delete failed"); }
  }

  // Build lab entries grouped by doc_type → panel
  const { labGroups, wearableGroups } = useMemo(() => {
    const q = search.trim().toLowerCase();

    // Group by canonical across all obs, keeping doc_type
    const byTypeAndName = new Map<string, Map<string, Obs[]>>();
    for (const o of obs) {
      if (!byTypeAndName.has(o.doc_type)) byTypeAndName.set(o.doc_type, new Map());
      const byName = byTypeAndName.get(o.doc_type)!;
      const list = byName.get(o.canonical_name) ?? [];
      list.push(o);
      byName.set(o.canonical_name, list);
    }

    function buildEntries(docType: string): LabEntry[] {
      const byName = byTypeAndName.get(docType);
      if (!byName) return [];
      return Array.from(byName.entries()).map(([canonical, readings]) => {
        const [lo, hi] = REF[canonical] ?? [undefined, undefined];
        const latest = readings[0];
        return {
          canonical,
          displayName: formatLabName(canonical),
          latest,
          history: readings,
          refLow: lo,
          refHigh: hi,
          flag: getFlag(latest.value, lo, hi),
        };
      }).filter(e => !q || formatLabName(e.canonical).toLowerCase().includes(q));
    }

    function buildGroups(docType: string, panelDefs: typeof LAB_PANELS) {
      const entries = buildEntries(docType);
      const byPanel = new Map<string, LabEntry[]>();
      for (const e of entries) {
        const panel = PANEL_MAP[e.canonical] ?? (docType === "lab_pdf" ? "other_lab" : "other_wearable");
        const list = byPanel.get(panel) ?? [];
        list.push(e);
        byPanel.set(panel, list);
      }
      return Object.entries(panelDefs)
        .sort((a, b) => a[1].order - b[1].order)
        .flatMap(([key, def]) => {
          const es = byPanel.get(key);
          return es && es.length > 0 ? [{ key, label: def.label, sym: def.sym, entries: es }] : [];
        });
    }

    const labTypes = ["lab_pdf"];
    const wearableTypes = ["wearable_csv", "apple_health"];

    const labGroups: Array<{ sourceLabel: string; panels: ReturnType<typeof buildGroups> }> = [];
    for (const dt of labTypes) {
      if (!byTypeAndName.has(dt)) continue;
      const panels = buildGroups(dt, LAB_PANELS);
      if (panels.length > 0) labGroups.push({ sourceLabel: SOURCE_TYPE_LABEL[dt], panels });
    }

    const wearableGroups: typeof labGroups = [];
    for (const dt of wearableTypes) {
      if (!byTypeAndName.has(dt)) continue;
      const panels = buildGroups(dt, WEARABLE_PANELS);
      if (panels.length > 0) wearableGroups.push({ sourceLabel: SOURCE_TYPE_LABEL[dt], panels });
    }

    return { labGroups, wearableGroups };
  }, [obs, search]);

  const stats = useMemo(() => {
    const uniqueNames = new Set(obs.map(o => o.canonical_name));
    const dates = obs.map(o => o.date_effective).filter(Boolean).sort();
    const flagged = obs.filter(o => {
      const [lo, hi] = REF[o.canonical_name] ?? [];
      return lo != null && hi != null && (o.value > hi || o.value < lo);
    });
    const dateRange = dates.length === 0 ? "—"
      : dates[0] === dates[dates.length - 1] ? dates[0]
      : `${dates[0].slice(0, 7)} – ${dates[dates.length - 1].slice(0, 7)}`;
    return { biomarkers: uniqueNames.size, readings: obs.length, flagged: flagged.length, dateRange };
  }, [obs]);

  if (loading) return (
    <div className="space-y-8 cascade">
      <div><h1 className="page-title">Dashboard</h1><p className="page-subtitle">Loading…</p></div>
    </div>
  );

  return (
    <div className="space-y-8 cascade">
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">A snapshot of everything you've uploaded.</p>
      </div>

      {obs.length === 0 ? (
        <div className="card"><p className="empty-state">No data yet — upload a file on the Chat page to get started.</p></div>
      ) : (
        <>
          <div className="dash-stats">
            <StatCard value={docs.length} label="Sources" />
            <StatCard value={stats.biomarkers} label="Biomarkers" />
            <StatCard value={stats.flagged > 0 ? `${stats.flagged} flagged` : stats.readings} label={stats.flagged > 0 ? "Out of range" : "Readings"} />
            <StatCard value={stats.dateRange} label="Date range" />
          </div>

          <section className="space-y-2">
            <p className="section-label">Sources</p>
            <div className="card divide-y divide-[var(--rule-s)]">
              {docs.map(d => <SourceRow key={d.doc_id} doc={d} onDelete={handleDelete} />)}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <p className="section-label">Results</p>
              <input type="search" placeholder="Filter tests…" value={search}
                onChange={e => setSearch(e.target.value)} className="dash-search" />
            </div>

            {[...labGroups, ...wearableGroups].length === 0 ? (
              <p className="empty-proofs">No matches.</p>
            ) : (
              <div className="space-y-4">
                {labGroups.map(({ sourceLabel, panels }) => (
                  <div key={sourceLabel} className="space-y-3">
                    {labGroups.length + wearableGroups.length > 1 && (
                      <p className="source-section-label">{sourceLabel}</p>
                    )}
                    {panels.map(p => (
                      <PanelCard key={p.key} panelKey={p.key} label={p.label} sym={p.sym} entries={p.entries} isWearable={false} />
                    ))}
                  </div>
                ))}
                {wearableGroups.map(({ sourceLabel, panels }) => (
                  <div key={sourceLabel} className="space-y-3">
                    {labGroups.length + wearableGroups.length > 1 && (
                      <p className="source-section-label">{sourceLabel}</p>
                    )}
                    {panels.map(p => (
                      <PanelCard key={p.key} panelKey={p.key} label={p.label} sym={p.sym} entries={p.entries} isWearable={true} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
