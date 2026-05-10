"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Listener = () => void;

type UploadState = {
  uploading: boolean;
  fileName: string;
  startUpload: (name: string) => void;
  finishUpload: () => void;
  /** Subscribe to "upload finished" events — fires once when uploading flips false. */
  onFinish: (cb: Listener) => () => void;
};

const UploadContext = createContext<UploadState | null>(null);

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [listeners] = useState<Set<Listener>>(() => new Set());

  // Warn before tab close / refresh during upload
  useEffect(() => {
    if (!uploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [uploading]);

  const startUpload = useCallback((name: string) => {
    setFileName(name);
    setUploading(true);
  }, []);

  const finishUpload = useCallback(() => {
    setUploading(false);
    setFileName("");
    // Fire all "finished" listeners on the next tick so subscribers can react
    queueMicrotask(() => listeners.forEach((cb) => cb()));
  }, [listeners]);

  const onFinish = useCallback(
    (cb: Listener) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    [listeners],
  );

  return (
    <UploadContext.Provider value={{ uploading, fileName, startUpload, finishUpload, onFinish }}>
      {children}
    </UploadContext.Provider>
  );
}

export function useUpload(): UploadState {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used inside UploadProvider");
  return ctx;
}
