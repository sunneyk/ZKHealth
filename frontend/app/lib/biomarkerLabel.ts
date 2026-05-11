/** Shared biomarker name formatting. Used wherever a canonical_name from the
 *  backend needs to be rendered for humans — Market, ZK Proofs, Dashboard.
 *  Acronyms stay capitalized; other names get title-cased with underscores
 *  turned into spaces.
 */

const OVERRIDES: Record<string, string> = {
  // Lipid panel
  hdl: "HDL",
  ldl: "LDL",
  vldl: "VLDL",
  non_hdl: "Non-HDL",
  apolipoprotein_b: "ApoB",
  total_chol_hdl_ratio: "Total Chol / HDL",

  // Glucose / diabetes
  hba1c: "HbA1c",
  estimated_avg_glucose: "Estimated Avg Glucose",

  // CBC
  rbc: "RBC",
  wbc: "WBC",
  mcv: "MCV",
  mch: "MCH",
  mchc: "MCHC",
  rdw: "RDW",

  // CMP
  bun: "BUN",
  bun_creatinine_ratio: "BUN / Creatinine",
  egfr: "eGFR",
  co2: "CO₂",

  // Liver
  alt: "ALT",
  ast: "AST",
  ggt: "GGT",
  ldh: "LDH",
  alkaline_phosphatase: "Alkaline Phosphatase",

  // Thyroid
  tsh: "TSH",
  free_t4: "Free T4",
  free_t3: "Free T3",

  // Iron
  tibc: "TIBC",
  iron_saturation: "Iron Saturation",

  // Inflammation
  crp: "CRP",
  esr: "ESR",

  // Vitamins / hormones
  vitamin_d: "Vitamin D",
  vitamin_b12: "Vitamin B12",
  shbg: "SHBG",

  // Wearable
  hrv: "HRV",
  spo2: "SpO₂",
  heart_rate_resting: "Resting HR",
  heart_rate_avg: "Avg HR",
  resting_heart_rate: "Resting HR",
  bmi: "BMI",
  body_fat_percentage: "Body Fat %",
};

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function biomarkerLabel(canonical: string): string {
  return OVERRIDES[canonical] ?? titleCase(canonical);
}
