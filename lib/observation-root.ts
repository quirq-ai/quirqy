import path from "node:path";
import { MirrorError, resolveObservationDirectory } from "./filesystem";

export const ROOT_COOKIE = "open-chat-root";
export function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const target = new URL(request.url);
  // Next dev can normalize request.url to localhost; Host retains the browser-facing address.
  if (request.headers.get("host")) target.host = request.headers.get("host")!;
  return origin === target.origin;
}
export function browseBase(): string {
  return process.env.MIRROR_BROWSE_ROOT || process.env.MIRROR_ROOT || path.join(process.cwd(), "workspace");
}
export async function observationRoot(request: Request): Promise<string | undefined> {
  const cookie = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(ROOT_COOKIE + "="));
  if (!cookie) return undefined;
  let selected: string;
  try { selected = decodeURIComponent(cookie.slice(ROOT_COOKIE.length + 1)); }
  catch { throw new MirrorError("Invalid workspace selection. Choose a folder again."); }
  return resolveObservationDirectory(selected, browseBase());
}
