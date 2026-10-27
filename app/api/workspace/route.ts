import { observationRoot } from "../../../lib/observation-root";
import { loadWorkspace, safeMirrorError } from "../../../lib/filesystem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin, Sec-Fetch-Site" };
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin workspace access is not allowed." }, { status: 403, headers });
  try {
    const snapshot = await loadWorkspace(new URL(request.url).searchParams.get("path") ?? "", await observationRoot(request));
    const etag = `"${snapshot.revision}"`;
    const matches = request.headers.get("if-none-match")?.split(",").some((value) => {
      const candidate = value.trim().replace(/^W\//, "");
      return candidate === "*" || candidate === etag;
    });
    const responseHeaders = { ...headers, ETag: etag };
    if (matches) return new Response(null, { status: 304, headers: responseHeaders });
    return Response.json(snapshot, { headers: responseHeaders });
  } catch (error) {
    const safe = safeMirrorError(error);
    return Response.json({ error: safe.message }, { status: safe.status, headers });
  }
}
