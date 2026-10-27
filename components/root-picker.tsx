"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Folder, X } from "lucide-react";
import type { Entry } from "@/lib/types";
type Listing = { baseName: string; path: string; selected: string | null; directories: Entry[] };

export function RootPicker({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Listing>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setListing(undefined);
    void fetch("/api/roots?path=" + encodeURIComponent(path), { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not browse folders.");
      setListing(data);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [path]);
  async function select() {
    if (!listing || saving) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/roots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: listing.path }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not switch workspace.");
      // Reload clears old in-flight reads and deep links; all readers use the new root cookie.
      location.hash = "/"; location.reload();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not switch workspace."); setSaving(false); }
  }
  const parts = path.split("/").filter(Boolean);
  return <dialog ref={dialog} className="sheet root-picker" aria-labelledby="root-picker-title" onCancel={event => { if (saving) event.preventDefault(); else onClose(); }} onClick={event => { if (!saving && event.target === event.currentTarget) onClose(); }}>
    <div className="sheet-inner"><div className="sheet-header"><div><h2 id="root-picker-title">Observe a folder</h2><p>Choose the folder quirqy watches.</p></div><button className="round-button" disabled={saving} aria-label="Close folder picker" onClick={onClose}><X size={20} /></button></div>
    <div className="sheet-body">
      <nav className="breadcrumbs" aria-label="Folder picker path"><button disabled={saving} onClick={() => setPath("")}>{listing?.baseName || "Available folders"}</button>{parts.map((part, i) => <span key={i}><ChevronRight size={12} /><button disabled={saving} onClick={() => setPath(parts.slice(0, i + 1).join("/"))}>{part}</button></span>)}</nav>
      {path && <button className="root-link" disabled={saving} onClick={() => setPath(parts.slice(0, -1).join("/"))}><ArrowLeft size={16} />Parent folder</button>}
      {error && <p role="alert" className="notice warning">{error}</p>}
      {!listing && !error && <p role="status">Loading folders…</p>}
      {listing && <><div className="root-choice"><Folder size={24} /><div><strong>{parts.at(-1) || listing.baseName}</strong><p>{listing.selected === listing.path ? "Currently observed" : "Use this folder as your workspace root"}</p></div>{listing.selected === listing.path && <Check size={18} />}</div>
      <div className="entry-list">{listing.directories.map(entry => <button className="entry-row" key={entry.path} disabled={saving} onClick={() => setPath(entry.path)}><Folder size={20} /><span className="entry-copy"><strong>{entry.name}</strong><span>Browse folder</span></span>{listing.selected === entry.path && <span className="chip">Current</span>}<ChevronRight size={16} /></button>)}</div>
      {!listing.directories.length && <p className="muted">No subfolders. You can still observe this folder.</p>}
      <button className="observe-button" disabled={saving} onClick={select}>{saving ? "Switching…" : "Observe this folder"}</button></>}
      <p className="about-footnote">Files stay read-only. Your selection is remembered in this browser.</p>
    </div></div>
  </dialog>;
}
