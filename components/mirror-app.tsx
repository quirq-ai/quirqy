"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronRight, CircleHelp, File, FileCode2,
  FileImage, FileText, Folder, FolderOpen, House, Lightbulb, LockKeyhole,
  Menu, MessageCircle, PanelsTopLeft, RefreshCw, Search, Shapes, SquareCheck, X,
  type LucideIcon
} from "lucide-react";
import type { Entry, WorkspaceSnapshot } from "@/lib/types";
import { FileContent, isConversation } from "./content-view";
import { FileOverlay } from "./file-overlay";
import { ChatComposer } from "./chat-composer";
import { useDemoChat } from "@/hooks/use-demo-chat";
import { ThemePicker } from "./theme-picker";
import { QuirqyAvatar } from "./quirqy-avatar";
import { RootPicker } from "./root-picker";

const icons = new Map<string, LucideIcon>([
  ["chat", MessageCircle], ["activity", PanelsTopLeft], ["insights", Lightbulb],
  ["vision", SquareCheck], ["library", BookOpen], ["ideas", Lightbulb],
  ["goals", SquareCheck], ["files", FolderOpen], ["apps", Shapes]
]);
const order = ["chat", "activity", "insights", "vision", "library", "ideas", "goals", "files", "apps"];
const nameOf = (path: string) => path.split("/").filter(Boolean).at(-1) || "Workspace";
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
function hashPath() { try { return decodeURIComponent(location.hash.replace(/^#\/?/, "")); } catch { return ""; } }
function prettySize(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function entryIcon(entry: Entry): LucideIcon {
  if (entry.kind === "directory") return icons.get(entry.name.toLowerCase()) || Folder;
  if (/json|js|ts|py|css|html|csv|yaml|toml/.test(entry.extension)) return FileCode2;
  if (/png|jpg|jpeg|gif|webp|avif/.test(entry.extension)) return FileImage;
  return /md|txt|pdf/.test(entry.extension) ? FileText : File;
}

function EntryRows({ entries, navigate, openFile, selected }: { entries: Entry[]; navigate: (path: string) => void; openFile: (path: string) => void; selected?: string }) {
  return <div className="entry-list">{entries.map((entry, index) => {
    const Icon = entryIcon(entry);
    return <button className={`entry-row ${selected === entry.path ? "selected" : ""}`} key={entry.path} onClick={() => entry.kind === "directory" ? navigate(entry.path) : openFile(entry.path)}>
      <span className={`icon-box tint-${index % 5}`}><Icon size={20} strokeWidth={1.8} /></span>
      <span className="entry-copy"><strong>{entry.name}</strong><span>{entry.kind === "directory" ? "Folder" : `${(entry.extension || "file").replace(/^\./, "").toUpperCase()} · ${prettySize(entry.size)}`}</span></span>
      <ChevronRight size={16} className="muted" />
    </button>;
  })}</div>;
}

export function MirrorApp() {
  const [path, setPath] = useState("");
  const [choosingRoot, setChoosingRoot] = useState(false);
  const [previewPaths, setPreviewPaths] = useState<string[]>([]);
  const pendingChatSection = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<{ path: string; snapshot: WorkspaceSnapshot }>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"files" | "about" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [lastRead, setLastRead] = useState("");
  const [checking, setChecking] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLElement>(null);
  const initialNavigation = useRef(true);
  const snapshot = result?.path === path ? result.snapshot : undefined;
  const conversation = snapshot?.file?.format === "json" && isConversation(snapshot.file.data) ? snapshot.file.data : undefined;
  const repliesPath = typeof conversation?.demoReplies === "string" ? conversation.demoReplies : undefined;
  const chatEnabled = !!conversation && !!repliesPath;
  const chat = useDemoChat(chatEnabled ? snapshot?.file?.path : undefined, repliesPath, snapshot?.rootId);
  const closePreview = useCallback(() => setPreviewPaths([]), []);
  const openFile = useCallback((next: string) => { setPanel(null); setPreviewPaths(current => current.at(-1) === next ? current : [...current, next]); }, []);
  const roots = [...(result?.snapshot.roots || [])].sort((a, b) => {
    const left = order.indexOf(a.name.toLowerCase());
    const right = order.indexOf(b.name.toLowerCase());
    return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.name.localeCompare(b.name);
  });

  const navigate = useCallback((next: string) => {
    setPreviewPaths([]);
    setQuery("");
    setPanel(null);
    setError("");
    if (next === path) setRefresh(value => value + 1);
    location.hash = `/${encodeURIComponent(next)}`;
    setPath(next);
    content.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [path]);

  useEffect(() => {
    const update = () => { setPath(hashPath()); setQuery(""); setError(""); setPreviewPaths([]); };
    update(); setReady(true);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let etag = "";
    let pending = false;
    const read = async () => {
      if (controller.signal.aborted || pending) return;
      if (document.hidden) { timer = setTimeout(read, 1500); return; }
      clearTimeout(timer);
      pending = true;
      setChecking(true);
      try {
        const response = await fetch(`/api/workspace?path=${encodeURIComponent(path)}`, {
          cache: "no-store", signal: controller.signal,
          headers: etag ? { "If-None-Match": etag } : {}
        });
        if (response.status !== 304) {
          const data = await response.json();
          if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not read this location.");
          etag = response.headers.get("ETag") || "";
          setResult({ path, snapshot: data as WorkspaceSnapshot });
        }
        setError("");
        setLastRead(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The local reader is unavailable.");
      } finally {
        pending = false;
        if (!controller.signal.aborted) { setChecking(false); timer = setTimeout(read, 1500); }
      }
    };
    const wake = () => { if (!document.hidden) void read(); };
    void read();
    document.addEventListener("visibilitychange", wake);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [path, ready, refresh]);

  useEffect(() => {
    const element = dialog.current;
    if (panel && element && !element.open) element.showModal();
    else if (!panel && element?.open) element.close();
  }, [panel]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "k") { event.preventDefault(); search.current?.focus(); }
      if (event.key === "Escape") setQuery("");
    };
    addEventListener("keydown", shortcut);
    return () => removeEventListener("keydown", shortcut);
  }, []);

  const entries = snapshot?.directory.entries || [];
  const index = entries.find(entry => entry.kind === "file" && entry.name === "index.json");
  const folderPath = snapshot?.directory.path || (snapshot?.file ? parentOf(path) : path);
  const selectedRoot = path.split("/")[0];
  const filtered = entries.filter(entry => entry.name.toLowerCase().includes(query.toLowerCase()));
  const activeName = snapshot?.directory.path ? nameOf(snapshot.directory.path) : "Your workspace";

  useEffect(() => {
    if (!snapshot || !initialNavigation.current) return;
    initialNavigation.current = false;
    // A saved home view is optional. Explicit deep links always take precedence.
    if (!location.hash && !path && index) navigate(index.path);
  }, [snapshot, path, index, navigate]);

  useEffect(() => {
    if (snapshot && !snapshot.file && pendingChatSection.current === path) {
      pendingChatSection.current = undefined;
      if (index) navigate(index.path);
    }
  }, [snapshot, path, index, navigate]);

  useEffect(() => {
    if (chatEnabled && content.current) content.current.scrollTo({ top: content.current.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [chatEnabled, chat.messages.length, chat.pending]);

  function openSection(section: Entry) {
    pendingChatSection.current = section.name.toLowerCase() === "chat" ? section.path : undefined;
    navigate(section.path);
  }

  return <div className="app-shell">
    <header className="app-header">
      <button className="round-button header-left" aria-label="Browse workspace" onClick={() => setPanel("files")}><Menu size={20} strokeWidth={1.8} /></button>
      <div className="brand"><QuirqyAvatar pending={chat.pending} drafting={!!chat.draft.trim()} replied={chat.messages.at(-1)?.role === "assistant"} /><button className="brand-name" onClick={() => setChoosingRoot(true)} aria-label="Choose observation root" title="Change observed folder">quirqy</button></div>
      <span className={`connection ${error ? "offline" : ""}`}><i />{error ? "Connection needs attention" : "Your files, in sync"}</span>
      <div className="header-actions header-right"><ThemePicker /><button className="round-button" aria-label="About this workspace" onClick={() => setPanel("about")}><CircleHelp size={20} strokeWidth={1.8} /></button></div>
    </header>

    <main className="main-content" ref={content} id="main-content">
      {path && <nav className="breadcrumbs" aria-label="Breadcrumb"><button onClick={() => navigate("")} aria-label="Workspace root"><House size={13} /></button>{folderPath.split("/").filter(Boolean).map((part, i, all) => <span key={i}><ChevronRight size={12} /><button onClick={() => navigate(all.slice(0, i + 1).join("/"))}>{part}</button></span>)}</nav>}
      {error && <div className="notice warning" role="alert"><strong>{snapshot ? "Showing the last saved view." : "This location is unavailable."}</strong><p>{error}</p><button onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} /> Try again</button><button onClick={() => navigate(parentOf(path))}><ArrowLeft size={13} /> Back to folder</button></div>}
      {!snapshot && !error && <div className="loading-state"><RefreshCw className="spin" size={21} /><p>Opening your workspace…</p></div>}
      {snapshot && (query ? <section><div className="section-heading"><h1>Find a file</h1><p>{filtered.length} {filtered.length === 1 ? "match" : "matches"} in {activeName.toLowerCase()}</p></div><EntryRows entries={filtered} navigate={navigate} openFile={openFile} />{!filtered.length && <div className="empty-state"><Search /><p>No files match “{query}”.</p></div>}</section> : snapshot.file ? <><FileContent key={snapshot.file.path} file={snapshot.file} revision={snapshot.revision} navigate={openFile} demo={chatEnabled} extraMessages={chatEnabled ? chat.messages : undefined} />{chatEnabled && chat.pending && <div className="typing-message" aria-hidden="true"><span>quirqy</span><div><i /><i /><i /></div></div>}</> : <section>
        <div className="section-heading"><div className="between"><h1>{activeName}</h1><span className="chip"><LockKeyhole size={11} /> Read only</span></div><p>{folderPath ? "Everything here comes straight from this folder." : "A little room for everything you’re working on."}</p></div>
        {index && <button className="folder-intro" onClick={() => navigate(index.path)}><span className="icon-box tint-0"><MessageCircle size={21} /></span><span><strong>Open {folderPath ? activeName.toLowerCase() : "your daily view"}</strong><small>Read the saved view in index.json</small></span><ArrowUpRight size={18} /></button>}
        <div className="list-caption"><span>{entries.length} {entries.length === 1 ? "item" : "items"}</span><span>{snapshot.rootName}{folderPath ? ` / ${folderPath}` : ""}</span></div>
        <EntryRows entries={entries} navigate={navigate} openFile={openFile} />
        {!entries.length && <div className="empty-state"><FolderOpen size={30} /><h2>A little space to begin</h2><p>Add a file to this folder. It will appear here automatically.</p></div>}
        {!folderPath && <div className="quiet-note"><span className="note-symbol">↳</span><div><strong>The filesystem is the interface.</strong><p>Edit a file, add a folder, or update some JSON.<br />Your workspace follows along.</p></div></div>}
      </section>)}
      {snapshot?.file && !query && <button className="back-to-folder" onClick={() => navigate(snapshot.directory.path)}><FolderOpen size={15} />Browse {snapshot.directory.name || "workspace"}<span>{entries.length} items</span><ChevronRight size={14} /></button>}
      <div className="content-bottom-space" />
    </main>

    <footer className="workspace-footer">
      {chatEnabled ? <ChatComposer chat={chat} /> : <>
        <div className="search-composer"><Search size={18} strokeWidth={1.7} /><input ref={search} aria-label="Find files in this folder" placeholder="Find a file in this folder…" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button className="search-action" aria-label="Clear search" onClick={() => setQuery("")}><X size={16} /></button> : <button className="search-action" aria-label="Refresh from disk" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} className={checking ? "checking" : ""} /></button>}</div>
      <div className="mirror-caption"><LockKeyhole size={10} />Read from disk<span>·</span>Changes appear automatically</div>
      </>}
      <nav className="dock" aria-label="Workspace folders">{roots.length ? roots.map(root => { const Icon = icons.get(root.name.toLowerCase()) || Folder; return <button key={root.path} className={selectedRoot === root.path ? "dock-item active" : "dock-item"} onClick={() => openSection(root)} aria-label={`Open ${root.name}`} aria-current={selectedRoot === root.path ? "page" : undefined} title={root.name}><Icon size={23} strokeWidth={1.8} /><span>{root.name}</span></button>; }) : <button className="dock-item active" onClick={() => navigate("")} aria-label="Workspace"><FolderOpen size={23} /><span>Workspace</span></button>}</nav>
    </footer>

    <dialog ref={dialog} className="sheet" onCancel={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) setPanel(null); }} aria-labelledby="sheet-title">
      <div className="sheet-inner"><div className="sheet-header"><div><h2 id="sheet-title">{panel === "files" ? "Your workspace" : "A window into your files"}</h2><p>{panel === "files" ? "Folders and files, just as you saved them." : "Local, read-only, and entirely yours."}</p></div><button className="round-button" aria-label="Close panel" onClick={() => setPanel(null)}><X size={20} /></button></div>
      <div className="sheet-body">{panel === "files" ? <><button className="root-link" onClick={() => navigate("")}><House size={17} />Workspace root<ArrowUpRight size={16} /></button><EntryRows entries={roots} navigate={navigate} openFile={openFile} selected={selectedRoot} />{!!snapshot?.directory.entries.length && <><div className="divider" /><span className="eyebrow">IN THIS FOLDER</span><EntryRows entries={snapshot.directory.entries} navigate={navigate} openFile={openFile} selected={path} /></>}</> : <>
        <div className="about-steps"><div><span className="icon-box tint-0"><Folder size={20} /></span><p><strong>Folders become places.</strong>Every top-level folder gets a spot in the dock. Open it to browse what’s inside.</p></div><div><span className="icon-box tint-1"><FileCode2 size={20} /></span><p><strong>Files become the content.</strong>Read Markdown, explore JSON, view images, and follow links to other saved files.</p></div><div><span className="icon-box tint-2"><RefreshCw size={20} /></span><p><strong>Edit on disk. See it here.</strong>The view checks for changes every 1.5 seconds while this tab is visible.</p></div></div>
        <div className="workspace-details"><span>Workspace</span><strong>{result?.snapshot.rootName || "workspace"}</strong><span>Last checked</span><strong>{lastRead || "Waiting for connection"}</strong><span>Access</span><strong><LockKeyhole size={12} /> Read only</strong><span>Connected services</span><strong><Check size={12} /> None required</strong></div>
        <p className="about-footnote">Visual design adapted from OpenMuse. This app reads local files using Next.js, without an agent runtime or account.</p>
      </>}</div></div>
    </dialog>
    {choosingRoot && <RootPicker onClose={() => setChoosingRoot(false)} />}
    {!!previewPaths.length && <FileOverlay path={previewPaths[previewPaths.length - 1]} canGoBack={previewPaths.length > 1} onBack={() => setPreviewPaths(current => current.slice(0, -1))} onClose={closePreview} onOpen={openFile} onNavigate={navigate} />}
  </div>;
}
