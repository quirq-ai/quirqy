import { observationRoot } from "../../../lib/observation-root";
import { readPreview, safeMirrorError } from "../../../lib/filesystem";

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
    const preview = await readPreview(new URL(request.url).searchParams.get("path") ?? "", await observationRoot(request));
    return new Response(new Uint8Array(preview.bytes), {
      headers: {
        ...headers,
        "Content-Type": preview.contentType,
        "Content-Length": String(preview.bytes.byteLength),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(preview.name)}`,
        "Content-Security-Policy": preview.contentType === "application/pdf"
          ? "default-src 'none'; frame-ancestors 'self'"
          : "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    const safe = safeMirrorError(error);
    return Response.json({ error: safe.message }, { status: safe.status, headers });
  }
}
