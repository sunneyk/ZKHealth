"use client";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";

const API = "http://127.0.0.1:8000";

type Provider = "fitbit" | "whoop" | "oura";

type ProviderStatus = {
  provider: Provider;
  label: string;
  connected: boolean;
  configured: boolean;
  user_id: string;
  last_sync: string;
};

type SyncResult = {
  provider: Provider;
  doc_id: string;
  synced_observations: number;
  date_range: string;
};

const PROVIDER_META: Record<Provider, {
  glyph: string;
  metrics: string;
  setupUrl: string;
  callbackPath: string;
  envClientId: string;
  envClientSecret: string;
}> = {
  fitbit: {
    glyph: "♡",
    metrics: "Steps · Calories · Active min · Resting HR · Sleep",
    setupUrl: "https://dev.fitbit.com/apps/new",
    callbackPath: "/api/wearable/fitbit/callback",
    envClientId: "FITBIT_CLIENT_ID",
    envClientSecret: "FITBIT_CLIENT_SECRET",
  },
  whoop: {
    glyph: "◐",
    metrics: "Recovery · Strain · HRV · Resting HR · Sleep",
    setupUrl: "https://developer.whoop.com",
    callbackPath: "/api/wearable/whoop/callback",
    envClientId: "WHOOP_CLIENT_ID",
    envClientSecret: "WHOOP_CLIENT_SECRET",
  },
  oura: {
    glyph: "◯",
    metrics: "Sleep · Readiness · Activity · HRV · SpO₂",
    setupUrl: "https://cloud.ouraring.com/oauth/applications",
    callbackPath: "/api/wearable/oura/callback",
    envClientId: "OURA_CLIENT_ID",
    envClientSecret: "OURA_CLIENT_SECRET",
  },
};

function ProviderCard({ status, onConnect, onSync, syncing, lastResult }: {
  status: ProviderStatus;
  onConnect: () => void;
  onSync: () => void;
  syncing: boolean;
  lastResult: SyncResult | null;
}) {
  const meta = PROVIDER_META[status.provider];
  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="wallet-icon"><span className="text-base">{meta.glyph}</span></div>
          <div>
            <p className="proof-name">{status.label}</p>
            <p className="proof-meta mt-0.5">{meta.metrics}</p>
            {status.connected ? (
              <p className="wallet-saved mt-1">
                Connected{status.user_id ? ` · ${status.user_id}` : ""}{status.last_sync ? ` · last sync ${status.last_sync}` : ""}
              </p>
            ) : status.configured ? (
              <p className="wallet-none mt-1">Not connected</p>
            ) : (
              <p className="wallet-none mt-1">Setup required</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {status.connected && (
            <button onClick={onSync} disabled={syncing} className="btn-ghost">
              {syncing ? "Syncing…" : "Sync"}
            </button>
          )}
          <button
            onClick={onConnect}
            disabled={!status.configured}
            className={status.connected ? "btn-disconnect" : "btn-connect"}
          >
            {status.connected ? "Reconnect" : "Connect"}
          </button>
        </div>
      </div>

      {!status.configured && (
        <div className="card-sunk space-y-1 text-xs">
          <p className="how-strong">Setup</p>
          <ol className="space-y-1 text-[var(--ink-3)] list-decimal list-inside">
            <li>Create a developer app at <a href={meta.setupUrl} target="_blank" rel="noopener noreferrer" className="solana-link">{new URL(meta.setupUrl).host}</a></li>
            <li>Set the OAuth callback URL to <code className="font-mono bg-[var(--paper-sunk)] px-1 py-0.5 rounded">http://localhost:8000{meta.callbackPath}</code></li>
            <li>Add <code className="font-mono bg-[var(--paper-sunk)] px-1 py-0.5 rounded">{meta.envClientId}</code> and <code className="font-mono bg-[var(--paper-sunk)] px-1 py-0.5 rounded">{meta.envClientSecret}</code> to <code className="font-mono">.env</code> and restart the backend</li>
          </ol>
        </div>
      )}

      {lastResult && lastResult.provider === status.provider && (
        <div className="card-sunk space-y-1">
          <p className="verify-ok">✓ Synced {lastResult.synced_observations} observations</p>
          <p className="stat-label">{lastResult.date_range}</p>
        </div>
      )}
    </div>
  );
}

export default function WearablePage() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [syncing, setSyncing] = useState<Provider | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const list: ProviderStatus[] = await fetch(`${API}/api/wearable/list`).then(r => r.json());
      setProviders(list);
    } catch {
      // backend may be starting
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleConnect(p: Provider) {
    try {
      const { url } = await fetch(`${API}/api/wearable/${p}/auth-url`).then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.detail)));
        return r.json();
      });
      const popup = window.open(url, `${p}-auth`, "width=600,height=750,left=200,top=100");
      if (!popup) {
        toast.error("Popup blocked — allow popups for this page");
        return;
      }
      const timer = setInterval(async () => {
        if (popup.closed) {
          clearInterval(timer);
          await fetchAll();
          toast.success("Connected — click Sync to import your data");
        }
      }, 600);
    } catch (err: unknown) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSync(p: Provider) {
    setSyncing(p);
    setLastResult(null);
    try {
      const result: SyncResult = await fetch(`${API}/api/wearable/${p}/sync`, { method: "POST" }).then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.detail)));
        return r.json();
      });
      setLastResult(result);
      toast.success(`Synced ${result.synced_observations} observations from ${PROVIDER_META[p].glyph} ${p}`);
      await fetchAll();
    } catch (err: unknown) {
      toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(null);
    }
  }

  return (
    <div className="space-y-8 cascade">
      <div>
        <h1 className="page-title">Connect a wearable</h1>
        <p className="page-subtitle">
          Pull data directly from your device — no manual export, no CSV upload. Each sync auto-attests every observation.
        </p>
      </div>

      <section className="space-y-3">
        {providers.length === 0 ? (
          <div className="card"><p className="empty-state">Loading providers…</p></div>
        ) : (
          providers.map((s) => (
            <ProviderCard
              key={s.provider}
              status={s}
              onConnect={() => handleConnect(s.provider)}
              onSync={() => handleSync(s.provider)}
              syncing={syncing === s.provider}
              lastResult={lastResult}
            />
          ))
        )}
      </section>

      <details className="how-details">
        <summary className="how-summary">
          <span className="how-arrow">▶</span> How does this work?
        </summary>
        <div className="how-body space-y-2">
          <p>
            <strong className="how-strong">OAuth2 only.</strong> ZKHealth never sees your provider password — you authorize at the provider's site, and the backend stores the access/refresh tokens locally in SQLite.
          </p>
          <p>
            <strong className="how-strong">Auto-attestation.</strong> Each synced observation is hashed with Poseidon and signed, identical to a CSV upload — so you can immediately mint ZK proofs against the data on the <a href="/zk" className="solana-link">ZK Proofs</a> page.
          </p>
          <p>
            <strong className="how-strong">Token refresh.</strong> Expired access tokens are refreshed transparently using the stored refresh token before each sync.
          </p>
        </div>
      </details>
    </div>
  );
}
