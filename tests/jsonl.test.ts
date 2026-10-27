import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { parseJsonl, jsonlPost } from "../lib/jsonl";
import { loadWorkspace, MAX_TEXT_BYTES } from "../lib/filesystem";

test("JSONL preserves physical lines, arbitrary JSON values, and valid neighbours of incomplete records", () => {
 const parsed = parseJsonl(' {"text":"Hello"}\r\n\r\nnull\r\n{"broken":\r\n[1,2]\r\nfalse\r\n42\r\n"post"\r\n');
 assert.deepEqual(parsed.map(record => record.line), [1,3,4,5,6,7,8]);
 assert.equal(parsed[1].value, null); assert.ok(parsed[2].error); assert.equal(parsed[2].raw, '{"broken":');
 assert.deepEqual(parsed[3].value, [1,2]); assert.equal(parsed[4].value, false); assert.equal(parsed[5].value, 42); assert.equal(parsed[6].value, "post");
 assert.deepEqual(parseJsonl(" \n\r\n"), []);
});

test("post extraction recognizes message blocks and common metadata without losing raw fields", () => {
 const record = { sender: { name: "Sam" }, timestamp: "2026-10-27T10:00:00Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "One" }, { type: "tool_use", id: "tool" }, { type: "text", text: "Two" }] }, extra: true };
 assert.deepEqual(jsonlPost(record), { author: "Sam", time: record.timestamp, kind: "message", title: "", body: "One\n\nTwo" });
 assert.equal(jsonlPost({ text: "Plain text", author: "Alex", title: "Update" }).body, "Plain text");
 assert.equal(jsonlPost("A scalar post").body, "A scalar post");
 assert.equal(jsonlPost(null).body, ""); assert.equal(record.extra, true);
});

test("filesystem recognizes JSONL and NDJSON and refreshes appended posts within the text size limit", async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), "jsonl-feed-")); t.after(() => rm(root, { recursive: true, force: true }));
 for (const extension of ["jsonl", "ndjson"]) {
  const filename = "feed." + extension;
  await writeFile(path.join(root, filename), '{"text":"Hello"}\n{"unfinished":');
  const first = await loadWorkspace(filename, root);
  assert.equal(first.file?.format, "jsonl"); assert.equal(first.file?.error, undefined); assert.equal(parseJsonl(first.file!.content!)[0].line, 1);
  await writeFile(path.join(root, filename), '{"text":"Hello"}\n{"text":"New post"}\n');
  const updated = await loadWorkspace(filename, root); assert.notEqual(first.revision, updated.revision); assert.equal(parseJsonl(updated.file!.content!).length, 2);
 }
 await writeFile(path.join(root, "large.jsonl"), "x".repeat(MAX_TEXT_BYTES + 1));
 assert.match((await loadWorkspace("large.jsonl", root)).file!.error!, /2 MB/);
 await writeFile(path.join(root, "binary.jsonl"), Buffer.from([0, 255]));
 assert.equal((await loadWorkspace("binary.jsonl", root)).file!.format, "unsupported");
});
