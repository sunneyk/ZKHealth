"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { Toaster } from "sonner";
import { UploadProvider } from "./components/UploadContext";

export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint="https://api.devnet.solana.com">
      <WalletProvider wallets={wallets} autoConnect>
        <UploadProvider>
          {children}
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: "var(--paper-card)",
                color: "var(--ink)",
                border: "0.5px solid var(--rule-s)",
                boxShadow: "var(--shadow-hi)",
                borderRadius: "var(--r-lg)",
                fontSize: "13px",
              },
            }}
          />
        </UploadProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
