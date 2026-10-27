import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DEMO_MESSAGES, MAX_MESSAGE_LENGTH, parseDemoReplies, restoreDemoSession, sampleReply } from "../lib/demo-chat";

test("file-provided reply configuration loads without a bundled workspace", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-chat-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "replies.json");
  await writeFile(file, JSON.stringify({ type: "demo-replies", suggestions: [{ label: "Say hello", prompt: "hello" }], rules: [{ keywords: ["hello"], content: "Hello from disk" }], fallback: { content: "Saved reply" } }));
  const config = parseDemoReplies(JSON.parse(await readFile(file, "utf8")));
  assert.ok(config);
  assert.equal(config.suggestions[0].prompt, "hello");
  assert.equal(sampleReply("Hello", config).content, "Hello from disk");
});

test("sample replies match words and phrases case-insensitively with ordered priority", () => {
  const config = parseDemoReplies({ type: "demo-replies", rules: [
    { keywords: ["file"], content: "file reply" },
    { keywords: ["thank you"], content: "thanks reply" },
    { keywords: ["hi"], content: "hello reply" }
  ], fallback: { content: "fallback" } });
  assert.ok(config);
  assert.equal(sampleReply("Find a FILE!", config).content, "file reply");
  assert.equal(sampleReply("Thank, you!", config).content, "thanks reply");
  assert.equal(sampleReply("This is a profile", config).content, "fallback");
  assert.equal(sampleReply("Hi, show a file", config).content, "file reply");
});

test("unmatched messages use the file-provided fallback", () => {
  const config = parseDemoReplies({ type: "demo-replies", rules: [], fallback: { content: "Saved fallback", links: [{ label: "Guide", path: "Files/Welcome.md" }] } });
  assert.ok(config);
  assert.deepEqual(sampleReply("anything", config), config.fallback);
});

test("malformed reply configurations do not enable chat", () => {
  for (const value of [null, {}, { type: "demo-replies", rules: [], fallback: { content: 1 } },
    { type: "demo-replies", rules: [{ keywords: [""], content: "bad" }], fallback: { content: "ok" } },
    { type: "demo-replies", rules: [], fallback: { content: "ok", links: false } }]) assert.equal(parseDemoReplies(value), undefined);
});

test("stored demo sessions reject malformed messages and restore only bounded local turns", () => {
  assert.deepEqual(restoreDemoSession({ version: 9, messages: [] }), { messages: [], draft: "" });
  const messages = Array.from({ length: MAX_DEMO_MESSAGES + 2 }, (_, i) => ({ id: String(i), role: "user", content: "x".repeat(MAX_MESSAGE_LENGTH + 1) }));
  const restored = restoreDemoSession({ version: 1, messages: [...messages, { id: "bad", role: "system", content: "not local" }], draft: "d".repeat(MAX_MESSAGE_LENGTH + 5) });
  assert.equal(restored.messages.length, MAX_DEMO_MESSAGES);
  assert.equal(restored.messages[0].id, "2");
  assert.equal(restored.messages[0].content.length, MAX_MESSAGE_LENGTH);
  assert.equal(restored.draft.length, MAX_MESSAGE_LENGTH);
});
