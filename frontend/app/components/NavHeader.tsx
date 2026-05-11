"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { ThemeToggle } from "./ThemeToggle";
import { useUpload } from "./UploadContext";

const API = "http://127.0.0.1:8000";

const LINKS = [
  { href: "/",           label: "Chat" },
  { href: "/dashboard",  label: "Dashboard" },
  { href: "/zk",         label: "ZK Proofs" },
  { href: "/market",     label: "Market" },
  { href: "/wearable",   label: "Wearable" },
];

function NavWalletButton() {
  const { publicKey, connected, connecting, connect, disconnect, select, wallets } = useWallet();
  const [pendingConnect, setPendingConnect] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (connected && publicKey) {
      const key = publicKey.toBase58();
      fetch(`${API}/api/zk/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: key }),
      }).catch(() => {});
    }
  }, [connected, publicKey]);

  useEffect(() => {
    if (pendingConnect && !connected && !connecting) {
      connect().catch(() => toast.error("Phantom not found — install from phantom.app"));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingConnect(false);
    }
  }, [pendingConnect, connected, connecting, connect]);

  // Close menu on outside click / escape
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element)?.closest?.(".nav-wallet-anchor")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleConnect() {
    const phantom = wallets.find((w) => w.adapter.name === "Phantom");
    if (!phantom) { toast.error("Phantom not found — install from phantom.app"); return; }
    select(phantom.adapter.name);
    setPendingConnect(true);
  }

  function handleCopy() {
    if (!publicKey) return;
    navigator.clipboard.writeText(publicKey.toBase58());
    toast.success("Address copied");
    setOpen(false);
  }

  function handleDisconnect() {
    disconnect();
    toast.success("Wallet disconnected");
    setOpen(false);
  }

  if (connected && publicKey) {
    const pk = publicKey.toBase58();
    return (
      <div className="nav-wallet-anchor">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="nav-wallet-pill"
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <span className="nav-wallet-dot" aria-hidden />
          <span className="nav-wallet-key">{pk.slice(0, 4)}…{pk.slice(-4)}</span>
          <span className={`nav-wallet-caret ${open ? "is-open" : ""}`} aria-hidden>⌄</span>
        </button>
        {open && (
          <div className="nav-wallet-menu" role="menu">
            <div className="nav-wallet-menu-header">
              <span className="nav-wallet-menu-label">Connected</span>
              <span className="nav-wallet-menu-pk">{pk.slice(0, 8)}…{pk.slice(-8)}</span>
            </div>
            <button type="button" onClick={handleCopy} role="menuitem" className="nav-wallet-menu-item">
              <span>Copy address</span>
              <span className="nav-wallet-menu-icon">⧉</span>
            </button>
            <button type="button" onClick={handleDisconnect} role="menuitem" className="nav-wallet-menu-item nav-wallet-menu-danger">
              <span>Disconnect</span>
              <span className="nav-wallet-menu-icon">↗</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleConnect}
      disabled={connecting}
      className="nav-wallet-pill nav-wallet-cta"
    >
      <span className="nav-wallet-dot nav-wallet-dot-off" aria-hidden />
      {connecting ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}

function MarketNavDropdown({ uploading, onBlock }: {
  uploading: boolean;
  onBlock: (e: React.MouseEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function show() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  }
  function scheduleHide() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div
      className="market-nav-anchor"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={scheduleHide}
    >
      <Link
        href="/market"
        className="nav-link"
        onClick={onBlock}
        aria-disabled={uploading || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Market
      </Link>
      {open && (
        <div className="market-nav-menu" role="menu">
          <Link
            href="/market?tab=buy"
            className="market-nav-item"
            role="menuitem"
            onClick={(e) => { onBlock(e); setOpen(false); }}
          >
            <span className="market-nav-item-label">Buy data</span>
            <span className="market-nav-item-hint">Browse anonymized snapshots</span>
          </Link>
          <Link
            href="/market?tab=sell"
            className="market-nav-item"
            role="menuitem"
            onClick={(e) => { onBlock(e); setOpen(false); }}
          >
            <span className="market-nav-item-label">Sell my data</span>
            <span className="market-nav-item-hint">List biomarkers from your uploads</span>
          </Link>
        </div>
      )}
    </div>
  );
}

export function NavHeader() {
  const { uploading, fileName } = useUpload();

  function blockIfUploading(e: React.MouseEvent) {
    if (uploading) {
      e.preventDefault();
      toast.warning("Hold on — upload still in progress");
    }
  }

  return (
    <>
      {uploading && (
        <div className="upload-banner" role="status" aria-live="polite">
          <span className="upload-banner-spinner" />
          <span>Uploading <strong>{fileName}</strong>…</span>
        </div>
      )}
      <header className={`nav-header ${uploading ? "nav-locked" : ""}`}>
        <div className="flex items-center gap-5">
          <span className="nav-brand">ZKHealth</span>
          <nav className="flex items-center gap-0.5">
            {LINKS.map((l) =>
              l.href === "/market" ? (
                <MarketNavDropdown
                  key={l.href}
                  uploading={uploading}
                  onBlock={blockIfUploading}
                />
              ) : (
                <Link
                  key={l.href}
                  href={l.href}
                  className="nav-link"
                  onClick={blockIfUploading}
                  aria-disabled={uploading || undefined}
                >
                  {l.label}
                </Link>
              ),
            )}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <NavWalletButton />
          <ThemeToggle />
        </div>
      </header>
    </>
  );
}
