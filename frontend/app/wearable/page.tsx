"use client";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";

const API = "http://127.0.0.1:8000";

type FitbitStatus = {
  connected: boolean;
  configured: boolean;
  user_id: string;
  last_sync: string;
};

type SyncResult = {
  doc_id: string;
  synced_observations: number;
  date_range: string;
};

export default function WearablePage() {
  const [status, setStatus] = useState<FitbitStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await fetch(`${API}/api/wearable/fitbit/status`).then(r => r.json());
      setStatus(s);
    } catch {
      // backend may be starting
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  async function handleConnect() {
    try {
      const { url } = await fetch(`${API}/api/wearable/fitbit/auth-url`).then(r => r.json());
      const popup = window.open(url, "fitbit-auth", "width=600,height=700,left=200,top=100");
      if (!popup) {
        toast.error("Popup blocked — allow popups for this page");
        return;
      }
      // Poll until popup closes, then re-fetch status
      const timer = setInterval(async () => {
        if (popup.closed) {
          clearInterval(timer);
          await fetchStatus();
          toast.success("Fitbit connected — click Sync to import your data");
        }
      }, 600);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FITBIT_CLIENT_ID")) {
        toast.error("Add FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET to your .env — see .env.example");
      } else {
        toast.error(`Failed: ${msg}`);
      }
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result: SyncResult = await fetch(`${API}/api/wearable/fitbit/sync`, { method: "POST" }).then(r => {
        if (!r.ok) return r.json().then(d => Promise.reject(new Error(d.detail)));
        return r.json();
      });
      setSyncResult(result);
      toast.success(`Synced ${result.synced_observations} observations`);
      await fetchStatus();
    } catch (err: unknown) {
      toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  const notConfigured = status && !status.configured;
  const notConnected = status && status.configured && !status.connected;
  const connected = status?.connected;

  return (
    <div className="space-y-8 cascade">
      <div>
        <h1 className="page-title">Wearable Connect</h1>
        <p className="page-subtitle">
          Pull data directly from your wearable account — no manual CSV export needed.
        </p>
      </div>

      {/* Fitbit card */}
      <section className="space-y-2">
        <p className="section-label">Fitbit</p>
        <div className="card space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="wallet-icon"><span className="text-sm">♡</span></div>
              <div>
                <p className="section-label">Fitbit</p>
                {connected ? (
                  <p className="wallet-saved mt-0.5">
                    Connected{status.user_id ? ` · ${status.user_id}` : ""}
                  </p>
                ) : (
                  <p className="wallet-none mt-0.5">Not connected</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {connected && (
                <button onClick={handleSync} disabled={syncing} className="btn-ghost">
                  {syncing ? "Syncing…" : "Sync now"}
                </button>
              )}
              <button
                onClick={handleConnect}
                disabled={notConfigured ?? false}
                className={connected ? "btn-disconnect" : "btn-connect"}
              >
                {connected ? "Reconnect" : "Connect Fitbit"}
              </button>
            </div>
          </div>

          {notConfigured && (
            <div className="card-sunk space-y-1">
              <p className="how-strong">Setup required</p>
              <ol className="space-y-1 text-sm text-[var(--fg-muted)] list-decimal list-inside">
                <li>Create a free app at <a href="https://dev.fitbit.com/apps/new" target="_blank" rel="noopener noreferrer" className="solana-link">dev.fitbit.com/apps/new</a></li>
                <li>Set OAuth 2.0 Application Type to <strong>Personal</strong></li>
                <li>Set Callback URL to <code className="font-mono text-xs bg-[var(--surface-2)] px-1 py-0.5 rounded">http://localhost:8000/api/wearable/fitbit/callback</code></li>
                <li>Add <code className="font-mono text-xs bg-[var(--surface-2)] px-1 py-0.5 rounded">FITBIT_CLIENT_ID</code> and <code className="font-mono text-xs bg-[var(--surface-2)] px-1 py-0.5 rounded">FITBIT_CLIENT_SECRET</code> to your <code className="font-mono text-xs">.env</code> and restart the backend</li>
              </ol>
            </div>
          )}

          {connected && status.last_sync && (
            <p className="stat-label">Last sync: {status.last_sync}</p>
          )}

          {syncResult && (
            <div className="card-sunk space-y-1">
              <p className="verify-ok">✓ Synced {syncResult.synced_observations} observations</p>
              <p className="stat-label">{syncResult.date_range}</p>
              <p className="stat-label">View in <a href="/dashboard" className="solana-link">Dashboard</a> or chat about it on the <a href="/" className="solana-link">Chat</a> page.</p>
            </div>
          )}
        </div>
      </section>

      {/* What gets synced */}
      <details className="how-details">
        <summary className="how-summary">
          <span className="how-arrow">▶</span> What data is synced?
        </summary>
        <div className="how-body space-y-2">
          <p>ZKHealth fetches the last 7 days from these Fitbit endpoints:</p>
          <ul className="space-y-1 text-sm text-[var(--fg-muted)] list-disc list-inside">
            <li><strong className="how-strong">Steps</strong> — daily step count</li>
            <li><strong className="how-strong">Calories burned</strong> — total daily calories</li>
            <li><strong className="how-strong">Active minutes</strong> — fairly + very active minutes</li>
            <li><strong className="how-strong">Resting heart rate</strong> — daily resting HR</li>
            <li><strong className="how-strong">Sleep hours</strong> — main sleep duration each night</li>
          </ul>
          <p>All data is stored locally and each observation gets a ZK attestation automatically — the same as uploading a CSV.</p>
        </div>
      </details>

      {/* Coming soon */}
      <details className="how-details">
        <summary className="how-summary">
          <span className="how-arrow">▶</span> More integrations (coming soon)
        </summary>
        <div className="how-body space-y-1">
          {["WHOOP — HRV, strain, recovery", "Garmin Connect — running, sleep, stress", "Apple Health — via on-device export or future direct sync", "Oura Ring — sleep stages, readiness"].map(s => (
            <p key={s} className="stat-label opacity-60">{s}</p>
          ))}
        </div>
      </details>
    </div>
  );
}
