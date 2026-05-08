"""Plain SQLite database for ZKHealth demo."""
from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "zkhealth.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            doc_id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            doc_type TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS observations (
            obs_id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            value REAL NOT NULL,
            unit TEXT NOT NULL DEFAULT '',
            date_effective TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_obs_doc ON observations(doc_id);
        CREATE TABLE IF NOT EXISTS zk_attestations (
            attestation_id TEXT PRIMARY KEY,
            obs_id TEXT NOT NULL UNIQUE,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS zk_proofs (
            proof_id TEXT PRIMARY KEY,
            attestation_id TEXT NOT NULL,
            biomarker_name TEXT NOT NULL,
            claim_type TEXT NOT NULL DEFAULT 'threshold_lt',
            threshold_display TEXT NOT NULL,
            passes INTEGER NOT NULL,
            solana_tx_id TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS market_listings (
            listing_id TEXT PRIMARY KEY,
            canonical_name TEXT NOT NULL UNIQUE,
            price_lamports INTEGER NOT NULL DEFAULT 1000000,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS market_grants (
            grant_id TEXT PRIMARY KEY,
            solana_tx_id TEXT NOT NULL UNIQUE,
            lamports_received INTEGER NOT NULL,
            researcher_pubkey TEXT NOT NULL DEFAULT '',
            anonymized_data TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)
    conn.commit()
    conn.close()


def save_document(filename: str, doc_type: str, content: str) -> str:
    doc_id = uuid.uuid4().hex
    conn = get_conn()
    conn.execute(
        "INSERT INTO documents (doc_id, filename, doc_type, content) VALUES (?,?,?,?)",
        (doc_id, filename, doc_type, content),
    )
    conn.commit()
    conn.close()
    return doc_id


def save_observation(doc_id: str, canonical_name: str, value: float, unit: str, date_effective: str) -> str:
    obs_id = uuid.uuid4().hex
    conn = get_conn()
    conn.execute(
        "INSERT INTO observations (obs_id, doc_id, canonical_name, value, unit, date_effective) VALUES (?,?,?,?,?,?)",
        (obs_id, doc_id, canonical_name, value, unit, date_effective),
    )
    conn.commit()
    conn.close()
    return obs_id


def get_documents() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT d.doc_id, d.filename, d.doc_type, d.created_at,
                  COUNT(o.obs_id) as obs_count
           FROM documents d
           LEFT JOIN observations o ON o.doc_id = d.doc_id
           GROUP BY d.doc_id
           ORDER BY d.created_at DESC"""
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_document(doc_id: str) -> None:
    conn = get_conn()
    conn.execute(
        """DELETE FROM zk_proofs WHERE attestation_id IN (
               SELECT attestation_id FROM zk_attestations WHERE obs_id IN (
                   SELECT obs_id FROM observations WHERE doc_id = ?
               )
           )""",
        (doc_id,),
    )
    conn.execute(
        """DELETE FROM zk_attestations WHERE obs_id IN (
               SELECT obs_id FROM observations WHERE doc_id = ?
           )""",
        (doc_id,),
    )
    conn.execute("DELETE FROM observations WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
    conn.commit()
    conn.close()


def get_observations() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT o.obs_id, o.doc_id, o.canonical_name, o.value, o.unit, o.date_effective,
                  d.doc_type
           FROM observations o
           JOIN documents d ON d.doc_id = o.doc_id
           ORDER BY o.date_effective DESC, o.created_at DESC"""
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_content() -> str:
    """Return all uploaded document content concatenated for LLM context."""
    conn = get_conn()
    rows = conn.execute("SELECT filename, doc_type, content FROM documents ORDER BY created_at DESC").fetchall()
    conn.close()
    parts = []
    for r in rows:
        parts.append(f"=== {r['filename']} ({r['doc_type']}) ===\n{r['content']}")
    return "\n\n".join(parts)


def save_attestation(obs_id: str, payload: dict) -> str:
    att_id = uuid.uuid4().hex
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO zk_attestations (attestation_id, obs_id, payload) VALUES (?,?,?)",
        (att_id, obs_id, json.dumps(payload)),
    )
    conn.commit()
    conn.close()
    return att_id


def get_attestation(obs_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT attestation_id, payload FROM zk_attestations WHERE obs_id = ?", (obs_id,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    payload = json.loads(row["payload"])
    payload["attestation_id"] = row["attestation_id"]
    return payload


def save_proof(proof_id: str, attestation_id: str, biomarker_name: str,
               threshold_display: str, passes: bool, payload: dict) -> None:
    conn = get_conn()
    conn.execute(
        """INSERT INTO zk_proofs
           (proof_id, attestation_id, biomarker_name, threshold_display, passes, payload)
           VALUES (?,?,?,?,?,?)""",
        (proof_id, attestation_id, biomarker_name, threshold_display, int(passes), json.dumps(payload)),
    )
    conn.commit()
    conn.close()


def update_proof_tx(proof_id: str, tx_id: str) -> None:
    conn = get_conn()
    conn.execute("UPDATE zk_proofs SET solana_tx_id = ? WHERE proof_id = ?", (tx_id, proof_id))
    conn.commit()
    conn.close()


def get_proofs() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT proof_id, biomarker_name, threshold_display, passes, solana_tx_id, created_at FROM zk_proofs ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_proof(proof_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM zk_proofs WHERE proof_id = ?", (proof_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    d = dict(row)
    d["payload"] = json.loads(d["payload"])
    return d


def get_setting(key: str) -> str:
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else ""


def set_setting(key: str, value: str) -> None:
    conn = get_conn()
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (key, value))
    conn.commit()
    conn.close()


# ── Market listings ───────────────────────────────────────────


def get_listings() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT listing_id, canonical_name, price_lamports, active, created_at FROM market_listings WHERE active=1 ORDER BY created_at"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_listing(canonical_name: str, price_lamports: int) -> str:
    listing_id = uuid.uuid4().hex
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO market_listings (listing_id, canonical_name, price_lamports) VALUES (?,?,?)",
        (listing_id, canonical_name, price_lamports),
    )
    # If it already existed (IGNORE), retrieve the existing id
    row = conn.execute("SELECT listing_id FROM market_listings WHERE canonical_name = ?", (canonical_name,)).fetchone()
    conn.commit()
    conn.close()
    return row["listing_id"] if row else listing_id


def remove_listing(listing_id: str) -> None:
    conn = get_conn()
    conn.execute("DELETE FROM market_listings WHERE listing_id = ?", (listing_id,))
    conn.commit()
    conn.close()


# ── Market grants ─────────────────────────────────────────────


def add_grant(tx_id: str, lamports: int, researcher_pubkey: str, anonymized_data_json: str) -> str:
    grant_id = uuid.uuid4().hex
    conn = get_conn()
    conn.execute(
        "INSERT INTO market_grants (grant_id, solana_tx_id, lamports_received, researcher_pubkey, anonymized_data) VALUES (?,?,?,?,?)",
        (grant_id, tx_id, lamports, researcher_pubkey, anonymized_data_json),
    )
    conn.commit()
    conn.close()
    return grant_id


def get_grants() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT grant_id, solana_tx_id, lamports_received, researcher_pubkey, anonymized_data, created_at FROM market_grants ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
