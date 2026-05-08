"""ZKHealth demo backend — FastAPI."""
from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import sys
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parent))

import db as database
from ingest import extract_pdf_text, parse_lab_observations, parse_wearable_csv
from ingest_apple_health import parse_apple_health_zip
from market import get_anonymized_snapshot, anonymized_preview

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

    if ext == ".pdf":
        text = extract_pdf_text(file_bytes)
        doc_id = database.save_document(filename, "lab_pdf", text)
        obs_list = parse_lab_observations(text)
        obs_ids = []
        for obs in obs_list:
            obs_id = database.save_observation(
                doc_id, obs["canonical_name"], obs["value"], obs["unit"], obs["date_effective"]
            )
            obs_ids.append(obs_id)
            # Auto-attest each observation
            from zk.attestation import attest_observation
            payload = attest_observation(obs_id, obs["canonical_name"], obs["value"], obs["date_effective"])
            database.save_attestation(obs_id, payload)
        return {"doc_id": doc_id, "type": "lab_pdf", "observations_found": len(obs_list)}

    elif ext == ".csv":
        summary, rows = parse_wearable_csv(file_bytes)
        doc_id = database.save_document(filename, "wearable_csv", summary)
        # Save provable numeric metrics as observations so they can have ZK proofs
        _WEARABLE_UNITS = {
            "steps": "steps", "heart_rate_avg": "bpm", "heart_rate_resting": "bpm",
            "sleep_hours": "h", "hrv": "ms", "spo2": "%", "calories_burned": "kcal",
            "active_minutes": "min",
        }
        from zk.attestation import attest_observation
        obs_count = 0
        for row in rows:
            date = row.get("date", "")
            for col, unit in _WEARABLE_UNITS.items():
                if col not in row:
                    continue
                try:
                    val = float(row[col])
                except (ValueError, TypeError):
                    continue
                obs_id = database.save_observation(doc_id, col, val, unit, date)
                payload = attest_observation(obs_id, col, val, date)
                database.save_attestation(obs_id, payload)
                obs_count += 1
        return {"doc_id": doc_id, "type": "wearable_csv", "rows": len(rows), "observations_found": obs_count}

    elif ext == ".zip":
        try:
            summary, obs_list = parse_apple_health_zip(file_bytes)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        doc_id = database.save_document(filename, "apple_health", summary)
        from zk.attestation import attest_observation
        obs_count = 0
        for obs in obs_list:
            obs_id = database.save_observation(
                doc_id, obs["canonical_name"], obs["value"], obs["unit"], obs["date_effective"]
            )
            payload = attest_observation(obs_id, obs["canonical_name"], obs["value"], obs["date_effective"])
            database.save_attestation(obs_id, payload)
            obs_count += 1
        return {"doc_id": doc_id, "type": "apple_health", "observations_found": obs_count}

    else:
        raise HTTPException(status_code=400, detail="Unsupported file type. Upload a PDF, CSV, or Apple Health ZIP.")


# ── Chat ──────────────────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str


@app.post("/api/chat")
async def chat(body: ChatRequest):
    """Send a message to the AI with all uploaded health data as context."""
    from llm import chat as llm_chat
    context = database.get_all_content()
    try:
        reply = await asyncio.to_thread(llm_chat, body.message, context)
        return {"reply": reply}
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
    from zk.html_export import VERIFY_HTML

    row = database.get_proof(proof_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Proof not found.")

    payload = row["payload"]
    vkey = json.loads((Path(__file__).parent.parent / "circuit" / "verification_key.json").read_text())

    sigs = payload["public_signals"]
    passes = sigs[0] == "1"
    date_int = int(sigs[2]) if len(sigs) > 2 else 0
    threshold_val = int(sigs[1]) / 1000 if len(sigs) > 1 else 0

    memo = "hb-zk:" + hashlib.sha256(
        json.dumps({"proof": payload["proof"], "public_signals": sigs}, sort_keys=True).encode()
    ).hexdigest()[:32]
    digest = memo[len("hb-zk:"):]

    meta = {
        "biomarker_name": row["biomarker_name"],
        "claim_type": "threshold_lt",
        "threshold_display": row["threshold_display"],
        "solana_tx_id": row["solana_tx_id"],
        "created_at": row["created_at"],
    }
    export_payload = {
        "proof": payload["proof"],
        "public_signals": sigs,
        "passes": passes,
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
    threshold_val = int(payload["public_signals"][1]) / 1000

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
        "__THRESHOLD_DISPLAY__": f"below {threshold_val:g}",
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


@app.post("/api/market/access")
async def market_access(body: AccessBody):
    recipient_pubkey = database.get_setting("solana_wallet_pubkey")
    if not recipient_pubkey:
        raise HTTPException(status_code=400, detail="No wallet saved. Save your Solana wallet on the ZK Proofs page first.")

    listings = database.get_listings()
    if not listings:
        raise HTTPException(status_code=400, detail="No active listings. Add biomarkers to the marketplace first.")

    min_price = min(l["price_lamports"] for l in listings)

    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            ["node", str(_PAYMENT_VERIFY), body.tx_signature, recipient_pubkey, str(min_price)],
            capture_output=True,
            text=True,
            timeout=15,
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

    all_obs = database.get_observations()
    listed_canonicals = {l["canonical_name"] for l in listings}
    snapshot = get_anonymized_snapshot(all_obs, listed_canonicals)

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
        "data": snapshot,
    }


@app.get("/api/market/grants")
def market_list_grants():
    return database.get_grants()


@app.get("/api/market/earnings")
def market_earnings():
    grants = database.get_grants()
    total_lamports = sum(g["lamports_received"] for g in grants)
    return {"total_lamports": total_lamports, "grant_count": len(grants)}


# ── Wearable / Fitbit ────────────────────────────────────────────────────────


@app.get("/api/wearable/fitbit/status")
def fitbit_status():
    from wearable import get_status
    return get_status()


@app.get("/api/wearable/fitbit/auth-url")
def fitbit_auth_url():
    from wearable import get_auth_url, _client_id
    try:
        _client_id()  # will raise if not configured
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"url": get_auth_url()}


@app.get("/api/wearable/fitbit/callback")
async def fitbit_callback(code: str = "", state: str = "", error: str = ""):
    if error:
        return HTMLResponse(
            f"<html><body style='font-family:sans-serif;text-align:center;padding:3rem'>"
            f"<h2>Fitbit error</h2><p>{error}</p></body></html>",
            status_code=400,
        )
    try:
        from wearable import exchange_code
        await asyncio.to_thread(exchange_code, code, state)
    except Exception as exc:
        return HTMLResponse(
            f"<html><body style='font-family:sans-serif;text-align:center;padding:3rem'>"
            f"<h2>Connection failed</h2><p>{exc}</p></body></html>",
            status_code=400,
        )
    return HTMLResponse("""
<html>
<head><title>Fitbit Connected</title></head>
<body style="font-family:sans-serif;text-align:center;padding:4rem;background:#0a0a0a;color:#e5e5e5">
  <p style="font-size:2.5rem;margin:0">✓</p>
  <h2 style="margin:.5rem 0 1rem;font-weight:500">Fitbit connected</h2>
  <p style="color:#888">Close this tab and return to ZKHealth to sync your data.</p>
  <script>setTimeout(()=>window.close(),1500)</script>
</body>
</html>
""")


@app.post("/api/wearable/fitbit/sync")
async def fitbit_sync():
    from wearable import sync_data
    try:
        result = await asyncio.to_thread(sync_data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
