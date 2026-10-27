"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_STORAGE_PREFIX, MAX_DEMO_MESSAGES, MAX_MESSAGE_LENGTH, parseDemoReplies, restoreDemoSession, sampleReply, type DemoMessage } from "@/lib/demo-chat";
import { useWorkspace } from "./use-workspace";

export function useDemoChat(conversationPath: string | undefined, repliesPath: string | undefined, rootId = "default") {
  const storageKey = DEMO_STORAGE_PREFIX + rootId + ":" + conversationPath;
  const { snapshot, error: readError, refresh } = useWorkspace(repliesPath);
  const config = parseDemoReplies(snapshot?.file?.data);
  const error = readError || (snapshot && !config ? "The sample reply file is not valid. Check its demo-replies structure." : "");
  const [session, setSession] = useState<{ path: string | undefined; messages: DemoMessage[]; draft: string }>({ path: undefined, messages: [], draft: "" });
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sending = useRef(false);
  const stop = useCallback(() => { clearTimeout(timer.current); sending.current = false; setPending(false); }, []);

  useEffect(() => {
    stop();
    if (conversationPath === undefined) return;
    let restored = { messages: [] as DemoMessage[], draft: "" };
    try { restored = restoreDemoSession(JSON.parse(sessionStorage.getItem(storageKey) || "null")); } catch { /* Session storage may be blocked or contain invalid data. */ }
    setSession({ path: conversationPath, ...restored });
    return () => { clearTimeout(timer.current); sending.current = false; };
  }, [conversationPath, stop, storageKey]);

  useEffect(() => {
    if (conversationPath === undefined || session.path !== conversationPath) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, messages: session.messages, draft: session.draft })); } catch { /* Keep the demo usable without storage. */ }
  }, [session, conversationPath, storageKey]);

  const ready = conversationPath !== undefined && session.path === conversationPath;
  const messages = ready ? session.messages : [];
  const draft = ready ? session.draft : "";
  function setDraft(value: string) { if (ready) setSession(current => ({ ...current, draft: value.slice(0, MAX_MESSAGE_LENGTH) })); }
  function send(prompt = draft) {
    const text = prompt.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!ready || !config || error || !text || sending.current) return;
    const response = sampleReply(text, config);
    sending.current = true;
    setPending(true);
    setSession(current => ({ ...current, draft: "", messages: [...current.messages, { id: crypto.randomUUID(), role: "user", content: text } as DemoMessage].slice(-MAX_DEMO_MESSAGES) }));
    timer.current = setTimeout(() => {
      setSession(current => current.path === conversationPath ? { ...current, messages: [...current.messages, { id: crypto.randomUUID(), role: "assistant", content: response.content.slice(0, MAX_MESSAGE_LENGTH), links: response.links } as DemoMessage].slice(-MAX_DEMO_MESSAGES) } : current);
      sending.current = false;
      setPending(false);
    }, 650);
  }
  function reset() { stop(); if (ready) setSession({ path: conversationPath, messages: [], draft: "" }); }
  return { ready: ready && !!config && !error, messages, draft, setDraft, send, stop, reset, pending, error, refresh, suggestions: config?.suggestions || [] };
}
