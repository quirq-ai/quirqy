import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadWorkspace, MAX_DIRECTORY_ENTRIES, MAX_PREVIEW_BYTES, MAX_TEXT_BYTES, MirrorError, readPreview } from "../lib/filesystem";
import { GET as getWorkspace } from "../app/api/workspace/route";
import { GET as getPreview } from "../app/api/file/route";

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "muse-mirror-test-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("top-level folders become dock roots, nested files resolve to their parent, and empty folders stay empty", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  await mkdir(path.join(root, "Research", "Notes"), { recursive: true });
  await mkdir(path.join(root, "Empty"));
  await writeFile(path.join(root, "Research", "Notes", "brief.md"), "# Hello\nLive from disk.");
  await writeFile(path.join(root, "README.md"), "Example workspace");
  const top = await loadWorkspace("", root);
  assert.deepEqual(top.roots.map((entry) => entry.name), ["Empty", "Research"]);
  assert.equal(top.directory.entries.length, 3);
  assert.equal(top.rootName, path.basename(root));
  assert.equal(top.directory.name, path.basename(root));
  const nested = await loadWorkspace("Research/Notes/brief.md", root);
  assert.equal(nested.directory.path, "Research/Notes");
  assert.equal(nested.file?.format, "markdown");
  assert.equal(nested.file?.content, "# Hello\nLive from disk.");
  assert.equal(nested.file?.extension, "md");
  assert.equal(nested.file?.path, "Research/Notes/brief.md");
  assert.deepEqual((await loadWorkspace("Empty", root)).directory.entries, []);
  assert.ok(!JSON.stringify(nested).includes(root));
});

test("JSON previews preserve arbitrary objects, arrays, and scalar values", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const values: unknown[] = [{ anything: { nested: true }, messages: [1, "two"] }, ["hello", 3], null, false, 42, "a string"];
  for (const value of values) {
    await writeFile(path.join(root, "value.json"), JSON.stringify(value));
    const snapshot = await loadWorkspace("value.json", root);
    assert.equal(snapshot.file?.format, "json");
    assert.deepEqual(snapshot.file?.data, value);
    assert.equal(snapshot.file?.error, undefined);
  }
});

test("same-size changes alter revisions even when modification times are preserved", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const file = path.join(root, "note.txt");
  await writeFile(file, "first");
  const metadata = await stat(file);
  const before = await loadWorkspace("note.txt", root);
  const unchanged = await loadWorkspace("note.txt", root);
  assert.equal(before.revision, unchanged.revision);
  await writeFile(file, "other");
  await utimes(file, metadata.atime, metadata.mtime);
  const after = await loadWorkspace("note.txt", root);
  assert.equal(before.file?.size, after.file?.size);
  assert.equal(after.file?.content, "other");
  assert.notEqual(before.revision, after.revision);
});

test("malformed JSON remains readable with a parsing error", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  await writeFile(path.join(root, "broken.json"), '{"unfinished":');
  const snapshot = await loadWorkspace("broken.json", root);
  assert.equal(snapshot.file?.content, '{"unfinished":');
  assert.match(snapshot.file?.error ?? "", /JSON is not valid/);
  assert.equal(snapshot.file?.data, undefined);
});

test("traversal, absolute paths, Windows ambiguity, and hidden components are rejected", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  for (const requested of ["../secret.txt", "Notes/../../secret.txt", "/etc/passwd", "C:/Users/file.txt", "C:secret.txt", "Notes\\file.txt", "a\0b", "note.txt:secret", "Notes/file.txt::$DATA"]) {
    await assert.rejects(loadWorkspace(requested, root), (error: unknown) => error instanceof MirrorError && error.status === 400);
  }
  for (const requested of [".env", "folder/.env.local", "node_modules/package.json"]) {
    await assert.rejects(loadWorkspace(requested, root), (error: unknown) => error instanceof MirrorError && error.status === 403);
  }
});

test("hidden entries and dependency folders are omitted while ordinary filenames survive", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  for (const directory of [".git", ".next", "node_modules", "My projects"]) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, ".env"), "SECRET=do-not-expose");
  await writeFile(path.join(root, "Notes & ideas.json"), "{}");
  const snapshot = await loadWorkspace("", root);
  assert.deepEqual(snapshot.directory.entries.map((entry) => entry.name), ["My projects", "Notes & ideas.json"]);
});

test("unknown, binary, and oversized text files get explicit preview states", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  await writeFile(path.join(root, "archive.zip"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "prototype.constructor"), "ordinary unsupported file");
  await writeFile(path.join(root, "binary.txt"), Buffer.from([0, 255, 1]));
  await writeFile(path.join(root, "large.txt"), Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
  assert.equal((await loadWorkspace("archive.zip", root)).file?.format, "unsupported");
  assert.equal((await loadWorkspace("prototype.constructor", root)).file?.format, "unsupported");
  assert.equal((await loadWorkspace("binary.txt", root)).file?.format, "unsupported");
  const large = await loadWorkspace("large.txt", root);
  assert.match(large.file?.error ?? "", /2 MB/);
  assert.equal(large.file?.content, undefined);
});

test("preview bytes require a permitted extension and matching content signature", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  await writeFile(path.join(root, "pixel.png"), png);
  await writeFile(path.join(root, "fake.png"), "<html>not an image</html>");
  await writeFile(path.join(root, "unsafe.svg"), '<svg onload="alert(1)"></svg>');
  await writeFile(path.join(root, "page.html"), "<h1>Hello</h1>");
  const preview = await readPreview("pixel.png", root);
  assert.equal(preview.contentType, "image/png");
  assert.deepEqual(Buffer.from(preview.bytes), png);
  for (const file of ["fake.png", "unsafe.svg", "page.html"]) {
    await assert.rejects(readPreview(file, root), (error: unknown) => error instanceof MirrorError && error.status === 415);
  }
  // Source files remain available as escaped text to the frontend.
  assert.equal((await loadWorkspace("unsafe.svg", root)).file?.format, "text");
});

test("binary previews reject oversized files before loading their contents", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const file = path.join(root, "large.pdf");
  await writeFile(file, "%PDF-1.7\n");
  await truncate(file, MAX_PREVIEW_BYTES + 1);
  assert.match((await loadWorkspace("large.pdf", root)).file?.error ?? "", /20 MB/);
  await assert.rejects(readPreview("large.pdf", root), (error: unknown) => error instanceof MirrorError && error.status === 413);
});

test("external and hidden-target symlinks cannot expose files; internal symlinks remain usable", async (t) => {
  const { root, cleanup } = await fixture();
  const outside = await fixture();
  t.after(cleanup);
  t.after(outside.cleanup);
  await writeFile(path.join(outside.root, "secret.txt"), "outside-secret");
  await writeFile(path.join(root, ".env"), "hidden-secret");
  await writeFile(path.join(root, "visible.txt"), "inside");
  try {
    await symlink(path.join(outside.root, "secret.txt"), path.join(root, "escape.txt"));
    await symlink(path.join(root, ".env"), path.join(root, "hidden.txt"));
    await symlink(path.join(root, "visible.txt"), path.join(root, "alias.txt"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
      t.skip("The current platform does not permit creating symlinks.");
      return;
    }
    throw error;
  }
  await assert.rejects(loadWorkspace("escape.txt", root), (error: unknown) => error instanceof MirrorError && error.status === 403);
  await assert.rejects(loadWorkspace("hidden.txt", root), (error: unknown) => error instanceof MirrorError && error.status === 403);
  assert.equal((await loadWorkspace("alias.txt", root)).file?.content, "inside");
  assert.deepEqual((await loadWorkspace("", root)).directory.entries.map((entry) => entry.name), ["alias.txt", "visible.txt"]);
});

test("directory limits fail explicitly instead of silently truncating files", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const batchSize = 100;
  for (let offset = 0; offset <= MAX_DIRECTORY_ENTRIES; offset += batchSize) {
    const end = Math.min(offset + batchSize, MAX_DIRECTORY_ENTRIES + 1);
    await Promise.all(Array.from({ length: end - offset }, (_, index) => writeFile(path.join(root, `${offset + index}.txt`), "")));
  }
  await assert.rejects(loadWorkspace("", root), (error: unknown) => error instanceof MirrorError && error.status === 413 && /entries/.test(error.message));
});

test("HTTP routes refuse cross-origin reads and support conditional snapshots without exposing disk paths", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const previousRoot = process.env.MIRROR_ROOT;
  process.env.MIRROR_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.MIRROR_ROOT;
    else process.env.MIRROR_ROOT = previousRoot;
  });
  await writeFile(path.join(root, "note.txt"), "The current contents.");
  await writeFile(path.join(root, "document.pdf"), "%PDF-1.7\npreview header for route validation");
  const url = "http://localhost:3000/api/workspace?path=note.txt";
  const response = await getWorkspace(new Request(url, { headers: { Origin: "http://localhost:3000" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const binary = await getPreview(new Request("http://localhost:3000/api/file?path=document.pdf"));
  assert.equal(binary.status, 200);
  assert.equal(binary.headers.get("cache-control"), "no-store");
  assert.equal(binary.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'self'");
  assert.equal(binary.headers.get("x-content-type-options"), "nosniff");
  assert.equal(binary.headers.get("content-type"), "application/pdf");
  const etag = response.headers.get("etag");
  assert.ok(etag);
  const conditional = await getWorkspace(new Request(url, { headers: { "If-None-Match": `W/${etag}` } }));
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
  const blockedHeaders: HeadersInit[] = [{ Origin: "https://other.example" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "null" }];
  for (const headers of blockedHeaders) {
    assert.equal((await getWorkspace(new Request(url, { headers }))).status, 403);
    assert.equal((await getPreview(new Request("http://localhost:3000/api/file?path=note.txt", { headers }))).status, 403);
  }
  const missing = await getWorkspace(new Request("http://localhost:3000/api/workspace?path=missing.txt"));
  assert.equal(missing.status, 404);
  assert.ok(!(await missing.text()).includes(root));
});
