"""ZKHealth backend — FastAPI."""
from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import sys
import uuid
from pathlib import Path

# Load .env from the project root so things like TREASURY_KEYPAIR_PATH and
# ANTHROPIC_API_KEY are available to subprocess bridges.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parent))

import db as database
from anonymize import anonymize as scrub_pii
from ingest import extract_pdf_text, parse_lab_observations, parse_wearable_csv
from ingest_apple_health import parse_apple_health_zip
from market import get_anonymized_snapshot, get_snapshot_summary, anonymized_preview

app = FastAPI(title="ZKHealth Demo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000",
                   "http://localhost:3001", "http://127.0.0.1:3001",
                   "http://localhost:3002", "http://127.0.0.1:3002"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    database.init_db()


# ── Upload ────────────────────────────────────────────────────────────────────


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload a lab PDF or wearable CSV. Extracts content and stores observations."""
    file_bytes = await file.read()
    filename = file.filename or "upload"
    ext = Path(filename).suffix.lower()

    from zk.attestation import attest_observations_batch

    async def _save_obs_batch(doc_id: str, obs_specs: list[dict]) -> int:
        """Save observations + batch-attest them in one Node call. Returns count."""
        if not obs_specs:
            return 0
        with_ids = []
        for o in obs_specs:
            obs_id = database.save_observation(doc_id, o["canonical_name"], o["value"], o["unit"], o["date_effective"])
            with_ids.append({
                "obs_id": obs_id,
                "canonical_name": o["canonical_name"],
                "value": o["value"],
                "date_effective": o["date_effective"],
            })
        payloads = await asyncio.to_thread(attest_observations_batch, with_ids)
        for p in payloads:
            database.save_attestation(p["obs_id"], p)
        return len(with_ids)

    def _save_doc_with_tier2(filename: str, doc_type: str, content: str) -> tuple[str, dict]:
        """Save the raw document (Tier 1) and immediately write its anonymized
        copy (Tier 2). Returns (doc_id, redaction_counts)."""
        doc_id = database.save_document(filename, doc_type, content)
        anon, counts = scrub_pii(content)
        database.save_tier2(doc_id, anon, counts)
        return doc_id, counts

    if ext == ".pdf":
        text = extract_pdf_text(file_bytes)
        doc_id, redactions = _save_doc_with_tier2(filename, "lab_pdf", text)
        obs_list = parse_lab_observations(text)
        for o in obs_list:
            o.setdefault("unit", "")
        count = await _save_obs_batch(doc_id, obs_list)
        return {"doc_id": doc_id, "type": "lab_pdf", "observations_found": count, "pii_redactions": redactions}

    elif ext == ".csv":
        summary, rows = parse_wearable_csv(file_bytes)
        doc_id, redactions = _save_doc_with_tier2(filename, "wearable_csv", summary)
        _WEARABLE_UNITS = {
            "steps": "steps", "heart_rate_avg": "bpm", "heart_rate_resting": "bpm",
            "sleep_hours": "h", "hrv": "ms", "spo2": "%", "calories_burned": "kcal",
            "active_minutes": "min",
        }
        specs: list[dict] = []
        for row in rows:
            date = row.get("date", "")
            for col, unit in _WEARABLE_UNITS.items():
                if col not in row:
                    continue
                try:
                    val = float(row[col])
                except (ValueError, TypeError):
                    continue
                specs.append({"canonical_name": col, "value": val, "unit": unit, "date_effective": date})
        count = await _save_obs_batch(doc_id, specs)
        return {"doc_id": doc_id, "type": "wearable_csv", "rows": len(rows), "observations_found": count, "pii_redactions": redactions}

    elif ext == ".zip":
        try:
            summary, obs_list = parse_apple_health_zip(file_bytes)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        doc_id, redactions = _save_doc_with_tier2(filename, "apple_health", summary)
        count = await _save_obs_batch(doc_id, obs_list)
        return {"doc_id": doc_id, "type": "apple_health", "observations_found": count, "pii_redactions": redactions}

    else:
        raise HTTPException(status_code=400, detail="Unsupported file type. Upload a PDF, CSV, or Apple Health ZIP.")


# ── Chat ──────────────────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str


@app.post("/api/chat")
async def chat(body: ChatRequest):
    """Send a message to the AI with all uploaded health data as context."""
    from llm import chat as llm_chat
    context = database.get_all_content_tier2()
    try:
        reply = await asyncio.to_thread(llm_chat, body.message, context)
        return {"reply": reply}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/insights")
async def insights():
    """Generate a structured AI summary of the user's health data — flags, trends, doctor questions."""
    from llm import chat as llm_chat
    context = database.get_all_content_tier2()
    if not context.strip():
        raise HTTPException(status_code=400, detail="No health data uploaded yet.")

    prompt = (
        "Generate a concise health summary in markdown with these sections:\n"
        "**Highlights** — 2-4 bullets noting the most important observations\n"
        "**Out of typical range** — bullets for any flagged values, with the value and direction (high/low)\n"
        "**Trends** — bullets for any biomarkers with multiple readings, noting whether they're improving or worsening\n"
        "**Questions for your doctor** — 3-5 specific questions worth raising at your next appointment\n\n"
        "Keep it under 300 words. Do not diagnose. Do not prescribe. Do not give numerical reference ranges that aren't already in the data."
    )
    try:
        reply = await asyncio.to_thread(llm_chat, prompt, context)
        return {"summary": reply}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


# ── Observations ──────────────────────────────────────────────────────────────


@app.get("/api/documents")
def list_documents():
    return database.get_documents()


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str):
    database.delete_document(doc_id)
    return {"ok": True}


@app.get("/api/observations")
def list_observations():
    return database.get_observations()


# ── Anonymization layer ──────────────────────────────────────────────────────


@app.get("/api/anonymization/stats")
def anonymization_stats():
    """Aggregate counts of PII redacted by the Tier 2 anonymization layer."""
    return database.get_tier2_stats()


# ── ZK Prove ─────────────────────────────────────────────────────────────────


class ProveRequest(BaseModel):
    obs_id: str
    threshold: float = Field(gt=0)
    biomarker_name: str
    direction: str = "below"   # "below" | "above"
    anchor_on_chain: bool = False


@app.post("/api/zk/prove")
async def prove(body: ProveRequest):
    from zk.prover import generate_proof

    if body.direction not in ("below", "above"):
        raise HTTPException(status_code=422, detail="direction must be 'below' or 'above'")

    att = database.get_attestation(body.obs_id)
    if att is None:
        raise HTTPException(status_code=404, detail="No attestation found for this observation.")

    try:
        result = await asyncio.to_thread(generate_proof, att, body.threshold, body.biomarker_name)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    # For "above": the circuit proves value < threshold; passes=0 means value >= threshold
    claim_passes = result["passes"] if body.direction == "below" else not result["passes"]
    claim_type = "threshold_lt" if body.direction == "below" else "threshold_gt"
    threshold_display = f"{'below' if body.direction == 'below' else 'above'} {body.threshold:g}"

    database.save_proof(
        result["proof_id"],
        att["attestation_id"],
        result["biomarker_name"],
        threshold_display,
        claim_passes,
        {k: result[k] for k in ("proof", "public_signals", "signature", "commitment")},
        claim_type=claim_type,
    )

    tx_id = ""
    if body.anchor_on_chain:
        try:
            from chain.solana_anchor import anchor_proof
            tx_id = await anchor_proof(result["proof"], result["public_signals"])
            database.update_proof_tx(result["proof_id"], tx_id)
        except Exception:
            pass

    return {
        "proof_id": result["proof_id"],
        "passes": claim_passes,
        "threshold": body.threshold,
        "direction": body.direction,
        "biomarker_name": body.biomarker_name,
        "date_int": result["date_int"],
        "solana_tx_id": tx_id,
    }


# ── ZK Range Prove ────────────────────────────────────────────────────────────


class ProveRangeRequest(BaseModel):
    obs_id: str
    threshold_low: float = Field(gt=0)
    threshold_high: float = Field(gt=0)
    biomarker_name: str
    anchor_on_chain: bool = False


@app.post("/api/zk/prove_range")
async def prove_range(body: ProveRangeRequest):
    """Generate two Groth16 proofs forming a range claim: low < value < high."""
    from zk.prover import generate_proof

    if body.threshold_low >= body.threshold_high:
        raise HTTPException(status_code=422, detail="threshold_low must be less than threshold_high")

    att = database.get_attestation(body.obs_id)
    if att is None:
        raise HTTPException(status_code=404, detail="No attestation found for this observation.")

    # Proof A: value < high  (should pass for a value in range)
    # Proof B: value < low   (should fail  for a value in range)
    try:
        result_high, result_low = await asyncio.gather(
            asyncio.to_thread(generate_proof, att, body.threshold_high, body.biomarker_name),
            asyncio.to_thread(generate_proof, att, body.threshold_low, body.biomarker_name),
        )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    in_range = result_high["passes"] and not result_low["passes"]
    proof_id = uuid.uuid4().hex
    threshold_display = f"{body.threshold_low}–{body.threshold_high}"

    payload = {
        "proof_high": result_high["proof"],
        "public_signals_high": result_high["public_signals"],
        "proof_low": result_low["proof"],
        "public_signals_low": result_low["public_signals"],
        "signature": att["signature"],
        "commitment": att["commitment"],
    }

    database.save_proof(
        proof_id,
        att["attestation_id"],
        body.biomarker_name,
        threshold_display,
        in_range,
        payload,
        claim_type="range",
    )

    tx_id = ""
    if body.anchor_on_chain:
        try:
            from chain.solana_anchor import anchor_proof
            tx_id = await anchor_proof(result_high["proof"], result_high["public_signals"])
            database.update_proof_tx(proof_id, tx_id)
        except Exception:
            pass

    return {
        "proof_id": proof_id,
        "in_range": in_range,
        "threshold_low": body.threshold_low,
        "threshold_high": body.threshold_high,
        "biomarker_name": body.biomarker_name,
        "solana_tx_id": tx_id,
    }


# ── ZK Verify ────────────────────────────────────────────────────────────────


@app.get("/api/zk/verify/{proof_id}")
async def verify(proof_id: str):
    from zk.verifier import verify_proof, verify_signature

    row = database.get_proof(proof_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Proof not found.")

    payload = row["payload"]
    claim_type = row.get("claim_type", "threshold_lt")

    if claim_type == "range":
        high_valid = await asyncio.to_thread(verify_proof, payload["proof_high"], payload["public_signals_high"])
        low_valid = await asyncio.to_thread(verify_proof, payload["proof_low"], payload["public_signals_low"])
        sig_valid = verify_signature(payload["commitment"], payload["signature"])
        proof_valid = high_valid and low_valid
        return {
            "proof_id": proof_id,
            "claim_type": "range",
            "biomarker_name": row["biomarker_name"],
            "threshold_display": row["threshold_display"],
            "passes": bool(row["passes"]),
            "proof_valid": proof_valid,
            "signature_valid": sig_valid,
            "fully_verified": proof_valid and sig_valid,
            "solana_tx_id": row["solana_tx_id"],
            "created_at": row["created_at"],
        }

    proof_valid = await asyncio.to_thread(verify_proof, payload["proof"], payload["public_signals"])
    sig_valid = verify_signature(payload["commitment"], payload["signature"])
    sigs = payload["public_signals"]
    return {
        "proof_id": proof_id,
        "claim_type": claim_type,
        "biomarker_name": row["biomarker_name"],
        "threshold_display": row["threshold_display"],
        "passes": bool(row["passes"]),
        "proof_valid": proof_valid,
        "signature_valid": sig_valid,
        "fully_verified": proof_valid and sig_valid,
        "date_int": int(sigs[2]) if len(sigs) > 2 else 0,
        "solana_tx_id": row["solana_tx_id"],
        "created_at": row["created_at"],
    }


# ── ZK List ───────────────────────────────────────────────────────────────────


@app.get("/api/zk/list")
def list_proofs():
    return database.get_proofs()


# ── ZK Export ─────────────────────────────────────────────────────────────────


@app.get("/api/zk/export/{proof_id}")
async def export_proof(proof_id: str):
    from zk.html_export import RANGE_VERIFY_HTML, VERIFY_HTML

    row = database.get_proof(proof_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Proof not found.")

    claim_type = row.get("claim_type", "threshold_lt")
    payload = row["payload"]
    vkey = json.loads((Path(__file__).parent.parent / "circuit" / "verification_key.json").read_text())

    if claim_type == "range":
        sigs_h = payload["public_signals_high"]
        sigs_l = payload["public_signals_low"]
        date_int = int(sigs_h[2]) if len(sigs_h) > 2 else 0
        in_range = sigs_h[0] == "1" and sigs_l[0] == "0"
        canonical_obj = {
            "proof_high": payload["proof_high"],
            "public_signals_high": sigs_h,
            "proof_low": payload["proof_low"],
            "public_signals_low": sigs_l,
        }
        memo = "hb-zk:" + hashlib.sha256(json.dumps(canonical_obj, sort_keys=True).encode()).hexdigest()[:32]
        digest = memo[len("hb-zk:"):]

        # threshold_display is stored as "70–99"; split for the template
        td = row["threshold_display"]
        low_str, high_str = (td.split("–", 1) + [""])[:2] if "–" in td else (td, td)

        meta = {
            "biomarker_name": row["biomarker_name"],
            "claim_type": claim_type,
            "threshold_display": td,
            "low": low_str,
            "high": high_str,
            "solana_tx_id": row["solana_tx_id"],
            "created_at": row["created_at"],
        }
        export_payload = {
            "proof_high": payload["proof_high"],
            "signals_high": sigs_h,
            "proof_low": payload["proof_low"],
            "signals_low": sigs_l,
            "passes": in_range,
            "date_int": date_int,
            "memo_digest": digest,
            "canonical": json.dumps(canonical_obj, sort_keys=True),
        }
        html = _build_range_verify_html(proof_id, meta, export_payload, vkey, RANGE_VERIFY_HTML)
    else:
        sigs = payload["public_signals"]
        raw_passes = sigs[0] == "1"
        claim_passes = raw_passes if claim_type == "threshold_lt" else not raw_passes
        date_int = int(sigs[2]) if len(sigs) > 2 else 0

        memo = "hb-zk:" + hashlib.sha256(
            json.dumps({"proof": payload["proof"], "public_signals": sigs}, sort_keys=True).encode()
        ).hexdigest()[:32]
        digest = memo[len("hb-zk:"):]

        meta = {
            "biomarker_name": row["biomarker_name"],
            "claim_type": claim_type,
            "threshold_display": row["threshold_display"],
            "solana_tx_id": row["solana_tx_id"],
            "created_at": row["created_at"],
        }
        export_payload = {
            "proof": payload["proof"],
            "public_signals": sigs,
            "passes": claim_passes,
            "date_int": date_int,
            "memo_digest": digest,
        }
        html = _build_verify_html(proof_id, meta, export_payload, vkey, VERIFY_HTML)

    filename = f"zkhealth_proof_{proof_id[:8]}.html"
    return Response(
        content=html,
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _build_verify_html(proof_id, meta, payload, vkey, template):
    passes = payload["passes"]
    d = str(payload["date_int"])
    date_display = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else d

    explorer_url = (
        f"https://explorer.solana.com/tx/{meta['solana_tx_id']}?cluster=devnet"
        if meta["solana_tx_id"] else ""
    )
    explorer_link = (
        f'<a href="{explorer_url}" target="_blank" rel="noopener noreferrer">View on Solana Explorer &#x2197;</a>'
        if explorer_url else "<span>No on-chain anchor</span>"
    )

    def _js(obj):
        return json.dumps(obj).replace("</", "<\\/")

    canonical = json.dumps(
        {"proof": payload["proof"], "public_signals": payload["public_signals"]}, sort_keys=True
    )

    tokens = {
        "__TITLE__": f"{meta['biomarker_name']} · ZK Proof",
        "__BIOMARKER_NAME__": meta["biomarker_name"],
        "__THRESHOLD_DISPLAY__": meta["threshold_display"],
        "__PASS_CLASS__": "badge-pass" if passes else "badge-fail",
        "__PASS_TEXT__": "✓ PASSES" if passes else "✗ DOES NOT PASS",
        "__DATE_DISPLAY__": date_display,
        "__PROOF_ID_SHORT__": proof_id[:8],
        "__MEMO__": f"hb-zk:{payload['memo_digest']}",
        "__MEMO_DIGEST__": payload["memo_digest"],
        "__EXPLORER_LINK__": explorer_link,
        "__PROOF_JSON__": _js(payload["proof"]),
        "__PUBLIC_SIGNALS_JSON__": _js(payload["public_signals"]),
        "__VKEY_JSON__": _js(vkey),
        "__CANONICAL_JSON__": _js(canonical),
    }

    html = template
    for token, value in tokens.items():
        html = html.replace(token, value)
    return html


def _build_range_verify_html(proof_id, meta, payload, vkey, template):
    passes = payload["passes"]
    d = str(payload["date_int"])
    date_display = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else d

    explorer_url = (
        f"https://explorer.solana.com/tx/{meta['solana_tx_id']}?cluster=devnet"
        if meta["solana_tx_id"] else ""
    )
    explorer_link = (
        f'<a href="{explorer_url}" target="_blank" rel="noopener noreferrer">View on Solana Explorer &#x2197;</a>'
        if explorer_url else "<span>No on-chain anchor</span>"
    )

    def _js(obj):
        return json.dumps(obj).replace("</", "<\\/")

    tokens = {
        "__TITLE__": f"{meta['biomarker_name']} · ZK Range Proof",
        "__BIOMARKER_NAME__": meta["biomarker_name"],
        "__THRESHOLD_DISPLAY__": meta["threshold_display"],
        "__LOW__": meta["low"],
        "__HIGH__": meta["high"],
        "__PASS_CLASS__": "badge-pass" if passes else "badge-fail",
        "__PASS_TEXT__": "✓ IN RANGE" if passes else "✗ OUT OF RANGE",
        "__DATE_DISPLAY__": date_display,
        "__PROOF_ID_SHORT__": proof_id[:8],
        "__MEMO__": f"hb-zk:{payload['memo_digest']}",
        "__MEMO_DIGEST__": payload["memo_digest"],
        "__EXPLORER_LINK__": explorer_link,
        "__PROOF_HIGH_JSON__": _js(payload["proof_high"]),
        "__SIGNALS_HIGH_JSON__": _js(payload["signals_high"]),
        "__PROOF_LOW_JSON__": _js(payload["proof_low"]),
        "__SIGNALS_LOW_JSON__": _js(payload["signals_low"]),
        "__VKEY_JSON__": _js(vkey),
        "__CANONICAL_JSON__": _js(payload["canonical"]),
    }

    html = template
    for token, value in tokens.items():
        html = html.replace(token, value)
    return html


# ── Wallet ────────────────────────────────────────────────────────────────────


@app.get("/api/zk/wallet")
def get_wallet():
    return {"pubkey": database.get_setting("solana_wallet_pubkey")}


class WalletBody(BaseModel):
    pubkey: str


@app.post("/api/zk/wallet")
def save_wallet(body: WalletBody):
    pubkey = body.pubkey.strip()
    if not (32 <= len(pubkey) <= 44 and pubkey.isalnum()):
        raise HTTPException(status_code=422, detail="invalid pubkey")
    database.set_setting("solana_wallet_pubkey", pubkey)
    return {"pubkey": pubkey}


# ── Market ───────────────────────────────────────────────────────────────────


_PAYMENT_VERIFY = Path(__file__).parent / "chain" / "payment_verify.cjs"


class ListingBody(BaseModel):
    canonical_name: str
    price_lamports: int = 1_000_000


class AccessBody(BaseModel):
    tx_signature: str
    researcher_pubkey: str = ""


@app.get("/api/market/listings")
def market_list_listings():
    return database.get_listings()


@app.post("/api/market/listings")
def market_add_listing(body: ListingBody):
    if not body.canonical_name.strip():
        raise HTTPException(status_code=422, detail="canonical_name is required")
    if body.price_lamports <= 0:
        raise HTTPException(status_code=422, detail="price_lamports must be positive")
    listing_id = database.add_listing(body.canonical_name.strip(), body.price_lamports)
    return {"listing_id": listing_id, "canonical_name": body.canonical_name.strip()}


@app.delete("/api/market/listings/{listing_id}")
def market_remove_listing(listing_id: str):
    database.remove_listing(listing_id)
    return {"ok": True}


@app.get("/api/market/preview")
def market_preview():
    all_obs = database.get_observations()
    listings = database.get_listings()
    listed_canonicals = {l["canonical_name"] for l in listings}
    return anonymized_preview(all_obs, listed_canonicals)


@app.get("/api/market/treasury")
def market_treasury():
    """Return the treasury wallet's pubkey — the address researchers should pay."""
    from chain.solana_anchor import get_treasury_pubkey
    try:
        return {"pubkey": get_treasury_pubkey()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/market/access")
async def market_access(body: AccessBody):
    from chain.solana_anchor import get_treasury_pubkey, release_to

    data_owner_pubkey = database.get_setting("solana_wallet_pubkey")
    if not data_owner_pubkey:
        raise HTTPException(status_code=400, detail="No data owner wallet saved. Save your wallet on the ZK Proofs page first.")

    listings = database.get_listings()
    if not listings:
        raise HTTPException(status_code=400, detail="No active listings. Add biomarkers to the marketplace first.")

    try:
        treasury_pubkey = get_treasury_pubkey()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Treasury unavailable: {exc}") from exc

    min_price = min(l["price_lamports"] for l in listings)

    # 1. Verify the researcher's payment landed in the TREASURY, not the data owner's wallet.
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            ["node", str(_PAYMENT_VERIFY), body.tx_signature, treasury_pubkey, str(min_price)],
            capture_output=True, text=True, timeout=15,
        )
        verify_result = json.loads(proc.stdout)
    except subprocess.TimeoutExpired:
        return {"verified": False, "error": "Payment verification timed out"}
    except Exception as exc:
        return {"verified": False, "error": str(exc)}

    if not verify_result.get("verified"):
        return {"verified": False, "error": verify_result.get("error", "Payment not verified")}

    lamports = verify_result.get("lamports", min_price)
    sender = verify_result.get("sender", body.researcher_pubkey)
    researcher_pubkey = body.researcher_pubkey or sender

    # 2. Compute the contributor split.
    all_obs = database.get_observations()
    listed_canonicals = {l["canonical_name"] for l in listings}
    snapshot = get_anonymized_snapshot(all_obs, listed_canonicals)        # per-row
    summary = get_snapshot_summary(all_obs, listed_canonicals)            # per-biomarker counts
    total_contributors = max((row["n_contributors"] for row in summary), default=1)
    data_owner_share = lamports // total_contributors

    # 3. Release the data owner's share from treasury via on-chain transfer.
    # The remaining (N-1)/N is allocated against the contributor pool and
    # released as those contributor wallets are settled.
    release_tx = ""
    release_error = ""
    try:
        release_tx = await release_to(data_owner_pubkey, max(data_owner_share, 1))
    except Exception as exc:
        release_error = str(exc)

    grant_id = database.add_grant(
        body.tx_signature,
        lamports,
        researcher_pubkey,
        json.dumps(snapshot),
    )

    return {
        "verified": True,
        "grant_id": grant_id,
        "lamports": lamports,
        "treasury_pubkey": treasury_pubkey,
        "release_tx": release_tx,
        "release_error": release_error,
        "release_lamports": data_owner_share,
        "n_contributors": total_contributors,
        "data": snapshot,            # per-row anonymized readings
        "summary": summary,          # per-biomarker counts
    }


@app.get("/api/market/grants")
def market_list_grants():
    return database.get_grants()


@app.get("/api/market/earnings")
def market_earnings():
    grants = database.get_grants()
    total_lamports = sum(g["lamports_received"] for g in grants)
    return {"total_lamports": total_lamports, "grant_count": len(grants)}


# ── Demo seeding ─────────────────────────────────────────────────────────────


_SAMPLE_WEARABLES = Path(__file__).parent.parent / "sample_data" / "sample_wearables.csv"

# Three time-points per biomarker so the dashboard trend chart has data to plot.
# Some values trend in/out of normal range to make the flags + chart visible.
# Format: (canonical_name, [(date, value)], unit)
_DEMO_LAB_PANEL: list[tuple[str, list[tuple[str, float]], str]] = [
    ("hemoglobin",     [("2025-11-15", 13.8), ("2026-02-15", 14.0), ("2026-05-08", 14.2)], "g/dL"),
    ("hematocrit",     [("2025-11-15", 41.0), ("2026-02-15", 41.8), ("2026-05-08", 42.5)], "%"),
    ("rbc",            [("2025-11-15", 4.7),  ("2026-02-15", 4.75), ("2026-05-08", 4.8)],  "M/uL"),
    ("wbc",            [("2025-11-15", 7.1),  ("2026-02-15", 6.9),  ("2026-05-08", 6.7)],  "K/uL"),
    ("platelets",      [("2025-11-15", 232),  ("2026-02-15", 240),  ("2026-05-08", 245)],  "K/uL"),
    ("glucose",        [("2025-11-15", 98),   ("2026-02-15", 95),   ("2026-05-08", 92)],   "mg/dL"),
    ("hba1c",          [("2025-11-15", 5.6),  ("2026-02-15", 5.5),  ("2026-05-08", 5.4)],  "%"),
    ("sodium",         [("2025-11-15", 139),  ("2026-02-15", 140),  ("2026-05-08", 140)],  "mmol/L"),
    ("potassium",      [("2025-11-15", 4.1),  ("2026-02-15", 4.2),  ("2026-05-08", 4.2)],  "mmol/L"),
    ("creatinine",     [("2025-11-15", 1.05), ("2026-02-15", 1.02), ("2026-05-08", 1.0)],  "mg/dL"),
    # Cholesterol trending UP — out of range now
    ("cholesterol",    [("2025-11-15", 198),  ("2026-02-15", 207),  ("2026-05-08", 215)],  "mg/dL"),
    ("ldl",            [("2025-11-15", 128),  ("2026-02-15", 135),  ("2026-05-08", 142)],  "mg/dL"),
    ("hdl",            [("2025-11-15", 52),   ("2026-02-15", 50),   ("2026-05-08", 48)],   "mg/dL"),
    ("triglycerides",  [("2025-11-15", 110),  ("2026-02-15", 118),  ("2026-05-08", 124)],  "mg/dL"),
    ("tsh",            [("2025-11-15", 2.3),  ("2026-02-15", 2.2),  ("2026-05-08", 2.1)],  "uIU/mL"),
    # Ferritin trending DOWN
    ("ferritin",       [("2025-11-15", 56),   ("2026-02-15", 47),   ("2026-05-08", 38)],   "ng/mL"),
    # Vitamin D out of range (low) — improving with supplementation
    ("vitamin_d",      [("2025-11-15", 18),   ("2026-02-15", 21),   ("2026-05-08", 24)],   "ng/mL"),
    ("vitamin_b12",    [("2025-11-15", 460),  ("2026-02-15", 470),  ("2026-05-08", 480)],  "pg/mL"),
    ("alt",            [("2025-11-15", 30),   ("2026-02-15", 29),   ("2026-05-08", 28)],   "U/L"),
    ("ast",            [("2025-11-15", 24),   ("2026-02-15", 23),   ("2026-05-08", 22)],   "U/L"),
    ("crp",            [("2025-11-15", 0.8),  ("2026-02-15", 0.7),  ("2026-05-08", 0.6)],  "mg/L"),
    ("testosterone",   [("2025-11-15", 510),  ("2026-02-15", 525),  ("2026-05-08", 540)],  "ng/dL"),
]


@app.post("/api/demo/load")
async def demo_load():
    """Seed the database with a sample lab panel + wearable CSV. Idempotent — skips if demo data already loaded."""
    from zk.attestation import attest_observations_batch

    existing = database.get_documents()
    already = any(d["filename"].startswith("demo_") for d in existing)
    if already:
        return {"already_loaded": True, "documents": len(existing)}

    # Build the full list of (doc_id, canonical, value, unit, date) tuples first,
    # save observations, then batch-attest them all in one Node call.
    pending: list[dict] = []

    # Lab panel — one document per visit date so the dashboard groups by visit
    visit_dates = sorted({d for _, readings, _ in _DEMO_LAB_PANEL for d, _ in readings})
    visit_docs = {
        v_date: database.save_document(
            f"demo_bloodwork_{v_date}.pdf", "lab_pdf",
            f"Comprehensive metabolic + lipid + vitamin panel — collected {v_date} (demo).",
        )
        for v_date in visit_dates
    }
    lab_count = 0
    for canonical, readings, unit in _DEMO_LAB_PANEL:
        for d, value in readings:
            obs_id = database.save_observation(visit_docs[d], canonical, value, unit, d)
            pending.append({"obs_id": obs_id, "canonical_name": canonical, "value": value, "date_effective": d})
            lab_count += 1

    # Wearable CSV
    wearable_count = 0
    if _SAMPLE_WEARABLES.exists():
        from ingest import parse_wearable_csv
        with open(_SAMPLE_WEARABLES, "rb") as f:
            file_bytes = f.read()
        summary, rows = parse_wearable_csv(file_bytes)
        wearable_doc_id = database.save_document("demo_wearables.csv", "wearable_csv", summary)
        units = {
            "steps": "steps", "heart_rate_avg": "bpm", "heart_rate_resting": "bpm",
            "sleep_hours": "h", "hrv": "ms", "spo2": "%", "calories_burned": "kcal",
            "active_minutes": "min",
        }
        for row in rows:
            d = row.get("date", "")
            for col, unit in units.items():
                if col not in row:
                    continue
                try:
                    val = float(row[col])
                except (ValueError, TypeError):
                    continue
                obs_id = database.save_observation(wearable_doc_id, col, val, unit, d)
                pending.append({"obs_id": obs_id, "canonical_name": col, "value": val, "date_effective": d})
                wearable_count += 1

    # ONE Node subprocess for all hashes (~1.5s instead of ~30s)
    payloads = await asyncio.to_thread(attest_observations_batch, pending)
    for p in payloads:
        database.save_attestation(p["obs_id"], p)

    return {
        "already_loaded": False,
        "lab_observations": lab_count,
        "wearable_observations": wearable_count,
    }


# ── Wearable providers (Fitbit, WHOOP, Oura) ────────────────────────────────


def _wearable_callback_html(label: str, ok: bool, message: str = "") -> HTMLResponse:
    if ok:
        body = f"""
  <p style="font-size:2.5rem;margin:0">✓</p>
  <h2 style="margin:.5rem 0 1rem;font-weight:500">{label} connected</h2>
  <p style="color:#888">Close this tab and return to ZKHealth to sync your data.</p>
  <script>setTimeout(()=>window.close(),1500)</script>"""
    else:
        body = f"""
  <p style="font-size:2.5rem;margin:0;color:#ef6b5e">✗</p>
  <h2 style="margin:.5rem 0 1rem;font-weight:500">Connection failed</h2>
  <p style="color:#888">{message}</p>"""
    return HTMLResponse(f"""<html><head><title>{label}</title></head>
<body style="font-family:sans-serif;text-align:center;padding:4rem;background:#0a0a0a;color:#e5e5e5">{body}</body></html>""",
        status_code=200 if ok else 400,
    )


@app.get("/api/wearable/list")
def wearable_list():
    import wearable
    return wearable.list_status()


class WearableCredentialsBody(BaseModel):
    client_id: str
    client_secret: str
    redirect_uri: str = ""


@app.post("/api/wearable/{provider}/credentials")
def wearable_save_credentials(provider: str, body: WearableCredentialsBody):
    import wearable
    from wearable._common import cred_set

    try:
        wearable.get(provider)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    cid = body.client_id.strip()
    csec = body.client_secret.strip()
    if not cid or not csec:
        raise HTTPException(status_code=422, detail="Both client_id and client_secret are required")

    cred_set(provider, "client_id", cid)
    cred_set(provider, "client_secret", csec)
    if body.redirect_uri.strip():
        cred_set(provider, "redirect_uri", body.redirect_uri.strip())
    return {"ok": True, "provider": provider}


@app.delete("/api/wearable/{provider}/credentials")
def wearable_clear_credentials(provider: str):
    import wearable
    from wearable._common import cred_clear

    try:
        wearable.get(provider)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    cred_clear(provider)
    return {"ok": True, "provider": provider}


@app.get("/api/wearable/{provider}/status")
def wearable_status(provider: str):
    import wearable
    try:
        return wearable.get(provider).get_status()
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.get("/api/wearable/{provider}/auth-url")
def wearable_auth_url(provider: str):
    import wearable
    try:
        mod = wearable.get(provider)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    try:
        return {"url": mod.get_auth_url()}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/wearable/{provider}/callback")
async def wearable_callback(provider: str, code: str = "", state: str = "", error: str = ""):
    import wearable
    try:
        mod = wearable.get(provider)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    label = mod.LABEL
    if error:
        return _wearable_callback_html(label, ok=False, message=error)
    try:
        await asyncio.to_thread(mod.exchange_code, code, state)
    except Exception as exc:
        return _wearable_callback_html(label, ok=False, message=str(exc))
    return _wearable_callback_html(label, ok=True)


@app.post("/api/wearable/{provider}/sync")
async def wearable_sync(provider: str):
    import wearable
    try:
        mod = wearable.get(provider)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    try:
        return await asyncio.to_thread(mod.sync_data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
