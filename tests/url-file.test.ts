import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseUrlFile } from "../lib/url-file";
import { loadWorkspace } from "../lib/filesystem";

test("URL files support plain web links and Windows shortcut sections", () => {
 assert.equal(parseUrlFile(" https://example.com/path?q=1#here\n"), "https://example.com/path?q=1#here");
 assert.equal(parseUrlFile("\uFEFF[InternetShortcut]\r\nURL=https://example.com/\r\nIconIndex=0\r\n[Other]\r\nURL=javascript:bad"), "https://example.com/");
 assert.equal(parseUrlFile("[internetshortcut]\nurl = http://localhost:1234/"), "http://localhost:1234/");
});
test("URL files reject ambiguous entries, unsafe schemes and credentials", () => {
 for (const value of ["", "javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "//example.com", "https://user:secret@example.com", "https://example.com\nhttps://other.com", "https://example.com/a b", "[Other]\nURL=https://example.com", "[InternetShortcut]\nURL=https://a.com\nURL=https://b.com"]) assert.equal(parseUrlFile(value), undefined, value);
});
test("filesystem loads URL shortcuts as bounded readable text and refreshes their content", async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), "url-preview-")); t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(path.join(root, "page.url"), "https://example.com/");
 const first = await loadWorkspace("page.url", root); assert.equal(first.file?.format, "url"); assert.equal(parseUrlFile(first.file!.content!), "https://example.com/");
 await writeFile(path.join(root, "page.url"), "http://example.org/");
 const next = await loadWorkspace("page.url", root); assert.notEqual(first.revision, next.revision); assert.equal(parseUrlFile(next.file!.content!), "http://example.org/");
});
