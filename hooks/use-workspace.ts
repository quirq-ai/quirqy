"use client";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "@/lib/types";

/** Fresh, abortable reads for the overlay and file-backed demo reply configuration. */
export function useWorkspace(path: string | undefined) {
  const [result, setResult] = useState<{ path: string; snapshot: WorkspaceSnapshot }>();
  const [failure, setFailure] = useState<{ path: string; message: string }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (path === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let etag = "";
    let pending = false;
    const read = async () => {
      if (controller.signal.aborted || pending) return;
      clearTimeout(timer);
      if (document.hidden) { timer = setTimeout(read, 1500); return; }
      pending = true;
      try {
        const response = await fetch(`/api/workspace?path=${encodeURIComponent(path)}`, { cache: "no-store", signal: controller.signal, headers: etag ? { "If-None-Match": etag } : {} });
        if (response.status !== 304) {
          const data = await response.json();
          if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "This file could not be read.");
          etag = response.headers.get("ETag") || "";
          setResult({ path, snapshot: data as WorkspaceSnapshot });
        }
        setFailure(undefined);
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ path, message: error instanceof Error ? error.message : "This file could not be read." });
      } finally {
        pending = false;
        if (!controller.signal.aborted) timer = setTimeout(read, 1500);
      }
    };
    const wake = () => { if (!document.hidden) void read(); };
    void read();
    document.addEventListener("visibilitychange", wake);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [path, revision]);
  return { snapshot: result && result.path === path ? result.snapshot : undefined, error: failure && failure.path === path ? failure.message : "", refresh };
}
