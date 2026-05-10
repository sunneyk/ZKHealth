"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useUpload } from "./components/UploadContext";

const API = "http://127.0.0.1:8000";

type Message = { role: "user" | "assistant"; text: string };
type LoadedFile = { name: string; type: string; count: number };
type Doc = { doc_id: string; filename: string; doc_type: string; obs_count: number };

const TYPE_LABEL: Record<string, string> = {
  lab_pdf: "lab results",
  apple_health: "Apple Health data",
  wearable_csv: "wearable data",
};

function fileTypeLabel(type: string) {
  if (type === "lab_pdf") return "Lab PDF";
  if (type === "apple_health") return "Apple Health";
  return "Wearable CSV";
}

function buildWelcome(docs: Doc[]): string {
  if (docs.length === 0) {
    return "Upload your lab PDF, wearable CSV, or Apple Health ZIP above, then ask me anything about your health data.";
  }

  const totalObs = docs.reduce((s, d) => s + d.obs_count, 0);
  const types = [...new Set(docs.map(d => TYPE_LABEL[d.doc_type] ?? "health data"))];
  const typeStr = types.length === 1 ? types[0]
    : types.slice(0, -1).join(", ") + " and " + types[types.length - 1];

  return `You have **${totalObs.toLocaleString()} readings** from ${typeStr} loaded. Ask me anything — what to look for, how values compare, or what questions to bring to your next appointment.\n\nYou can also drop in new bloodwork or an updated wearable export above to keep things current.`;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadedFiles, setLoadedFiles] = useState<LoadedFile[]>([]);
  const [hasExistingData, setHasExistingData] = useState(false);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { uploading, startUpload, finishUpload, onFinish } = useUpload();

  // Refresh welcome message based on current docs. Replaces only the first
  // (welcome) message to preserve any chat history.
  const refreshWelcome = useCallback(async () => {
    try {
      const docs: Doc[] = await fetch(`${API}/api/documents`).then(r => r.json());
      setHasExistingData(docs.length > 0);
      const welcome = { role: "assistant" as const, text: buildWelcome(docs) };
      setMessages((m) => (m.length === 0 ? [welcome] : [welcome, ...m.slice(1)]));
    } catch {
      setMessages((m) => (m.length === 0 ? [{ role: "assistant", text: buildWelcome([]) }] : m));
    }
  }, []);

  // Initial load + refresh whenever the tab regains focus
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshWelcome();
    const onVis = () => { if (document.visibilityState === "visible") refreshWelcome(); };
    window.addEventListener("focus", refreshWelcome);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refreshWelcome);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshWelcome]);

  // Refresh after any upload finishes (even if it kicked off from another tab/page)
  useEffect(() => onFinish(refreshWelcome), [onFinish, refreshWelcome]);

  async function processFile(file: File) {
    const allowed = [".pdf", ".csv", ".zip"];
    const lower = file.name.toLowerCase();
    if (!allowed.some(ext => lower.endsWith(ext))) {
      toast.error("Unsupported file — drop a PDF, CSV, or Apple Health ZIP");
      return;
    }
    if (uploading) {
      toast.warning("Already uploading — wait for the current upload to finish");
      return;
    }
    startUpload(file.name);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/api/upload`, { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).detail);
      const data = await res.json();
      const count = data.observations_found;
      const msg = data.type === "lab_pdf"
        ? `Added **${file.name}** — ${count} lab values are now in context.`
        : data.type === "apple_health"
        ? `Added **${file.name}** — ${count} daily Apple Health observations loaded.`
        : `Added **${file.name}** — ${count} wearable observations loaded.`;
      setMessages((m) => [...m, { role: "assistant", text: msg }]);
      setLoadedFiles((f) => [...f, { name: file.name, type: data.type, count }]);
      setHasExistingData(true);
      toast.success("File uploaded");
    } catch (err: unknown) {
      toast.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      finishUpload();
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await processFile(file);
  }

  function handleDragEnter(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setDragActive(true);
  }

  function handleDragOver(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    e.stopPropagation();
    // Only clear when leaving the zone itself, not its children
    if (e.currentTarget === e.target) setDragActive(false);
  }

  async function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await processFile(file);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || thinking) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", text: userMsg }]);
    setThinking(true);
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg }),
      });
      if (!res.ok) throw new Error((await res.json()).detail);
      const { reply } = await res.json();
      setMessages((m) => [...m, { role: "assistant", text: reply }]);
    } catch (err: unknown) {
      toast.error(`Chat failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setThinking(false);
    }
  }

  return (
    <div className="space-y-6 cascade">
      <div>
        <h1 className="page-title">Health Chat</h1>
        <p className="page-subtitle">Upload your health data and ask anything. All processing is local.</p>
      </div>

      <label
        className={`upload-zone ${uploading ? "is-uploading" : ""} ${dragActive ? "is-drag-active" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input ref={fileRef} type="file" accept=".pdf,.csv,.zip" className="hidden" onChange={handleUpload} />
        <div className="upload-icon">
          <span className="text-base">{uploading ? "⏳" : dragActive ? "⤓" : "📎"}</span>
        </div>
        <div>
          <p className="upload-label">
            {uploading ? "Uploading…" : dragActive ? "Drop to upload" : hasExistingData ? "Add new records" : "Upload health data"}
          </p>
          <p className="upload-hint">
            {dragActive
              ? "Release the file to ingest it"
              : hasExistingData
              ? "Drop or click · PDF · CSV · Apple Health ZIP"
              : "Drop or click · PDF lab reports · CSV wearables · Apple Health ZIP"}
          </p>
        </div>
      </label>


      {loadedFiles.length > 0 && (
        <div className="loaded-bar">
          <span className="loaded-bar-label">Loaded</span>
          <div className="loaded-chips">
            {loadedFiles.map((f, i) => (
              <span key={i} className="loaded-chip">
                <span className="loaded-chip-type">{fileTypeLabel(f.type)}</span>
                <span className="loaded-chip-name">{f.name}</span>
                <span className="loaded-chip-count">{f.count} obs</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3 min-h-48">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            {m.role === "user"
              ? <div className="msg-user">{m.text}</div>
              : (
                <div className="msg-assistant">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                </div>
              )
            }
          </div>
        ))}
        {thinking && (
          <div className="flex justify-start">
            <div className="msg-assistant flex items-center gap-1.5 !py-3">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSend} className="input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your health data…"
          className="chat-input"
        />
        <button type="submit" disabled={!input.trim() || thinking} className="btn-primary">
          Send
        </button>
      </form>
    </div>
  );
}
