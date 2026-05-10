"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Modal } from "../components/Modal";

const API = "http://127.0.0.1:8000";
const STALE_MS = 30 * 60 * 1000; // auto-refresh after 30 min

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
  last_sync?: string;
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
    metrics: "Steps · Calories · Active minutes · Resting HR · Sleep",
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

function relativeTime(iso: string): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function isStale(iso: string): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return true;
  return Date.now() - t > STALE_MS;
}

const SETUP_FORM_ID = "wearable-setup-form";

type SetupFormProps = {
  provider: Provider;
  label: string;
  meta: typeof PROVIDER_META[Provider];
  onSaved: () => void;
};

function useSetupForm({ provider, label, onSaved }: Omit<SetupFormProps, "meta">) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error("Paste both client ID and client secret");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/wearable/${provider}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).detail);
      toast.success(`${label} credentials saved`);
      onSaved();
    } catch (err: unknown) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = !saving && clientId.trim().length > 0 && clientSecret.trim().length > 0;
  return { clientId, setClientId, clientSecret, setClientSecret, saving, canSubmit, handleSave };
}

function SetupForm({
  label, meta, formState,
}: Omit<SetupFormProps, "provider"> & { formState: ReturnType<typeof useSetupForm> }) {
  const callbackUrl = `http://localhost:8000${meta.callbackPath}`;
  const { clientId, setClientId, clientSecret, setClientSecret, handleSave } = formState;

  function copyUrl() {
    navigator.clipboard.writeText(callbackUrl);
    toast.success("Callback URL copied");
  }

  return (
    <form id={SETUP_FORM_ID} className="setup-form" onSubmit={handleSave}>
      <p className="setup-intro">
        One-time setup. Paste your developer credentials below — we save them locally and use them to OAuth into <strong>{label}</strong>. You won&apos;t need to repeat this.
      </p>

      <ol className="setup-steps">
        <li>
          <span className="setup-step-num">1</span>
          <div className="setup-step-body">
            <p className="setup-step-title">Create a developer app</p>
            <a href={meta.setupUrl} target="_blank" rel="noopener noreferrer" className="setup-step-link">
              Open {new URL(meta.setupUrl).host} ↗
            </a>
          </div>
        </li>
        <li>
          <span className="setup-step-num">2</span>
          <div className="setup-step-body">
            <p className="setup-step-title">Set the callback URL in their portal</p>
            <div className="setup-url-row">
              <code className="setup-url">{callbackUrl}</code>
              <button type="button" onClick={copyUrl} className="setup-copy-btn" title="Copy URL">⧉</button>
            </div>
          </div>
        </li>
        <li>
          <span className="setup-step-num">3</span>
          <div className="setup-step-body">
            <p className="setup-step-title">Paste the credentials they give you</p>
            <div className="setup-inputs">
              <label className="setup-field-label">
                <span>Client ID</span>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="e.g. 23ABCD"
                  className="form-input setup-field-input"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </label>
              <label className="setup-field-label">
                <span>Client secret</span>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="••••••••••••••••"
                  className="form-input setup-field-input"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>
          </div>
        </li>
      </ol>
    </form>
  );
}

function SetupModal({ provider, onClose, onSaved }: {
  provider: Provider | null;
  onClose: () => void;
  onSaved: (p: Provider) => void;
}) {
  // Hooks must run unconditionally — drive the form state off a stable provider
  // value, then reset when the modal closes.
  const safeProvider: Provider = provider ?? "fitbit";
  const meta = PROVIDER_META[safeProvider];
  const label = safeProvider.charAt(0).toUpperCase() + safeProvider.slice(1).replace("whoop", "WHOOP");
  const formState = useSetupForm({
    provider: safeProvider,
    label,
    onSaved: () => onSaved(safeProvider),
  });

  const open = provider !== null;
  const displayLabel = provider ? (provider === "whoop" ? "WHOOP" : provider.charAt(0).toUpperCase() + provider.slice(1)) : "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={provider ? <span className="modal-icon-glyph">{PROVIDER_META[provider].glyph}</span> : null}
      title={provider ? `Connect ${displayLabel}` : ""}
      subtitle={provider ? PROVIDER_META[provider].metrics : null}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button
            type="submit"
            form={SETUP_FORM_ID}
            disabled={!formState.canSubmit}
            className="btn-connect"
          >
            {formState.saving ? "Saving…" : "Save & connect →"}
          </button>
        </>
      }
    >
      {provider && (
        <SetupForm label={displayLabel} meta={meta} formState={formState} onSaved={() => onSaved(provider)} />
      )}
    </Modal>
  );
}

function ProviderCard({ status, syncing, lastResult, onConnect, onSync }: {
  status: ProviderStatus;
  syncing: boolean;
  lastResult: SyncResult | null;
  onConnect: () => void;
  onSync: () => void;
}) {
  const meta = PROVIDER_META[status.provider];
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="provider-glyph" aria-hidden>{meta.glyph}</div>
          <div>
            <div className="flex items-center gap-2">
              <p className="proof-name">{status.label}</p>
              {status.connected && (
                <span className="provider-status-dot" aria-label="Connected" />
              )}
            </div>
            <p className="proof-meta mt-0.5">{meta.metrics}</p>
            {status.connected ? (
              <p className="provider-sync-line mt-1">
                Synced {relativeTime(status.last_sync)}
                {status.user_id ? ` · ${status.user_id}` : ""}
              </p>
            ) : status.configured ? (
              <p className="wallet-none mt-1">Ready to connect</p>
            ) : (
              <p className="wallet-none mt-1">Click Connect to set up</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {status.connected && (
            <button onClick={onSync} disabled={syncing} className="btn-ghost" title="Refresh data">
              {syncing ? "Syncing…" : "↻ Sync"}
            </button>
          )}
          <button
            onClick={onConnect}
            className={status.connected ? "btn-disconnect" : "btn-connect"}
          >
            {status.connected ? "Reconnect" : "Connect"}
          </button>
        </div>
      </div>

      {lastResult && lastResult.provider === status.provider && lastResult.synced_observations > 0 && (
        <div className="provider-sync-result">
          ✓ Imported <strong>{lastResult.synced_observations}</strong> observations · <span className="wallet-saved">{lastResult.date_range}</span>
        </div>
      )}
    </div>
  );
}

export default function WearablePage() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [syncing, setSyncing] = useState<Set<Provider>>(new Set());
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [setupProvider, setSetupProvider] = useState<Provider | null>(null);
  const [lastResults, setLastResults] = useState<Record<Provider, SyncResult | null>>({
    fitbit: null, whoop: null, oura: null,
  });
  const autoSyncedRef = useRef(false);

  const fetchAll = useCallback(async (isActive: () => boolean = () => true): Promise<ProviderStatus[]> => {
    try {
      const list: ProviderStatus[] = await fetch(`${API}/api/wearable/list`).then(r => r.json());
      if (!isActive()) return list;
      setProviders(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const syncProvider = useCallback(async (p: Provider): Promise<SyncResult | null> => {
    setSyncing(s => { const n = new Set(s); n.add(p); return n; });
    try {
      const result: SyncResult = await fetch(`${API}/api/wearable/${p}/sync`, { method: "POST" }).then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.detail)));
        return r.json();
      });
      setLastResults(prev => ({ ...prev, [p]: result }));
      return result;
    } catch (err: unknown) {
      toast.error(`${p} sync failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      setSyncing(s => { const n = new Set(s); n.delete(p); return n; });
    }
  }, []);

  // Initial load + auto-sync any connected provider whose data is stale.
  useEffect(() => {
    let active = true;
    (async () => {
      const list = await fetchAll(() => active);
      if (!active || autoSyncedRef.current) return;
      autoSyncedRef.current = true;
      const stale = list.filter(p => p.connected && isStale(p.last_sync));
      if (stale.length === 0) return;
      // Auto-refresh in background — no toast spam, just keep data fresh.
      for (const p of stale) {
        if (!active) return;
        await syncProvider(p.provider);
      }
      if (active) await fetchAll(() => active);
    })();
    return () => { active = false; };
  }, [fetchAll, syncProvider]);

  async function runOAuth(p: Provider) {
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
        if (!popup.closed) return;
        clearInterval(timer);
        const list = await fetchAll();
        const updated = list.find(s => s.provider === p);
        if (updated?.connected) {
          toast.success(`${PROVIDER_META[p].glyph} ${updated.label} connected — syncing…`);
          const result = await syncProvider(p);
          await fetchAll();
          if (result && result.synced_observations > 0) {
            toast.success(`Imported ${result.synced_observations} observations from ${updated.label}`);
          }
        }
      }, 600);
    } catch (err: unknown) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleConnect(p: Provider) {
    const status = providers.find(s => s.provider === p);
    // Need credentials first? Open setup modal — modal's onSaved will continue to OAuth.
    if (!status?.configured) {
      setSetupProvider(p);
      return;
    }
    await runOAuth(p);
  }

  async function handleCredentialsSaved(p: Provider) {
    setSetupProvider(null);
    await fetchAll();
    // Seamless: jump straight from "saved" to OAuth popup
    await runOAuth(p);
  }

  async function handleSyncOne(p: Provider) {
    const result = await syncProvider(p);
    await fetchAll();
    if (result && result.synced_observations > 0) {
      toast.success(`Synced ${result.synced_observations} from ${PROVIDER_META[p].glyph} ${p}`);
    } else if (result) {
      toast.info(`Synced ${PROVIDER_META[p].glyph} ${p} — no new observations`);
    }
  }

  async function handleSyncAll() {
    const connected = providers.filter(p => p.connected);
    if (connected.length === 0) {
      toast.error("Connect a wearable first");
      return;
    }
    setBulkSyncing(true);
    let totalObs = 0;
    for (const p of connected) {
      const result = await syncProvider(p.provider);
      if (result) totalObs += result.synced_observations;
    }
    setBulkSyncing(false);
    await fetchAll();
    toast.success(`Synced ${totalObs} observations across ${connected.length} provider${connected.length === 1 ? "" : "s"}`);
  }

  const connectedCount = providers.filter(p => p.connected).length;

  return (
    <div className="space-y-8 cascade">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Connect a wearable</h1>
          <p className="page-subtitle">
            Pull data directly from your device. Each sync auto-attests every observation, ready to be proved.
          </p>
        </div>
        {connectedCount > 0 && (
          <button
            type="button"
            onClick={handleSyncAll}
            disabled={bulkSyncing}
            className="btn-mode-active flex-shrink-0"
            title="Refresh all connected wearables"
          >
            {bulkSyncing ? "Syncing all…" : `↻ Sync all (${connectedCount})`}
          </button>
        )}
      </div>

      <section className="space-y-3">
        {providers.length === 0 ? (
          <div className="card"><p className="empty-state">Loading providers…</p></div>
        ) : (
          providers.map((s) => (
            <ProviderCard
              key={s.provider}
              status={s}
              syncing={syncing.has(s.provider)}
              lastResult={lastResults[s.provider]}
              onConnect={() => handleConnect(s.provider)}
              onSync={() => handleSyncOne(s.provider)}
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
            <strong className="how-strong">OAuth2 only.</strong> ZKHealth never sees your provider password — you authorize at the provider&apos;s site, and the backend stores the access/refresh tokens locally in SQLite.
          </p>
          <p>
            <strong className="how-strong">One click to connect &amp; sync.</strong> After authorizing in the popup, the data is fetched immediately. No second action needed. Click <em>Sync all</em> any time to refresh every connected wearable in one shot.
          </p>
          <p>
            <strong className="how-strong">Auto-attestation.</strong> Each synced observation is hashed with Poseidon and signed automatically — identical to a CSV upload — so you can immediately mint ZK proofs against the data on the <a href="/zk" className="solana-link">ZK Proofs</a> page.
          </p>
          <p>
            <strong className="how-strong">Token refresh.</strong> Expired access tokens are refreshed transparently using the stored refresh token before each sync. Stale data (more than 30 minutes old) is auto-refreshed when you visit this page.
          </p>
        </div>
      </details>

      <SetupModal
        provider={setupProvider}
        onClose={() => setSetupProvider(null)}
        onSaved={(p) => handleCredentialsSaved(p)}
      />
    </div>
  );
}
