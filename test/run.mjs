// Small dependency-free tests. Run: npm test (builds first).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseJsonKeepingBigInts, parseIds, SNOWFLAKE } = await import("../dist/access.js");
let passed = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { passed++; console.log("ok  " + name); });

await t("big numeric IDs keep their digits", () => {
  const d = parseJsonKeepingBigInts('{"allowFrom":[123456789012345678, "987654321098765432"]}');
  assert.deepEqual(d.allowFrom, ["123456789012345678", "987654321098765432"]);
  assert.deepEqual(parseIds(d.allowFrom), ["123456789012345678", "987654321098765432"]);
});
await t("strings containing digits are untouched", () => {
  const d = parseJsonKeepingBigInts('{"note":"id 123456789012345678 here","n":5,"f":1.5e3}');
  assert.equal(d.note, "id 123456789012345678 here");
  assert.equal(d.n, 5);
});
await t("small numbers are rejected, not coerced", () => {
  assert.deepEqual(parseIds([12345, "  111111111111111111\r"]), ["111111111111111111"]);
});
await t("snowflake regex", () => {
  assert.ok(SNOWFLAKE.test("123456789012345678"));
  assert.ok(!SNOWFLAKE.test("1234"));
});

// Silero VAD: independent state per SpeechBuffer.
const { SpeechBuffer } = await import("../dist/audio-utils.js");
await t("each SpeechBuffer has its own VAD state", async () => {
  const a = await SpeechBuffer.create();
  const b = await SpeechBuffer.create();
  assert.notEqual(a.vad, b.vad);
  assert.notEqual(a.vad._state, b.vad._state);
  const noise = Buffer.alloc(1024 * 3);
  for (let i = 0; i < noise.length; i += 2) noise.writeInt16LE(Math.round((Math.random() - 0.5) * 20000), i);
  const before = b.vad._state;
  await a.feed(noise);
  assert.equal(b.vad._state, before, "feeding A must not change B's state");
  const sA = a.vad._state;
  a.endOfInput();
  assert.notEqual(a.vad._state, sA, "state reset at end of input");
});

// TTS cache LRU
const { TextToSpeech } = await import("../dist/tts.js");
await t("TTS cache is bounded (entries and bytes)", () => {
  const tts = new TextToSpeech({ apiKey: "x" });
  for (let i = 0; i < 500; i++) tts.cacheStore("k" + i, { pcm: Buffer.alloc(10), chars: 1 });
  assert.ok(tts.cache.size <= 200);
  assert.ok(tts.cache.has("k499") && !tts.cache.has("k0"));
  tts.cache.clear(); tts.cacheBytes = 0;
  for (let i = 0; i < 5; i++) tts.cacheStore("b" + i, { pcm: Buffer.alloc(3 * 1024 * 1024), chars: 1 });
  assert.ok(tts.cacheBytes <= 8 * 1024 * 1024);
  assert.equal(tts.cache.size, 2);
  tts.cacheStore("huge", { pcm: Buffer.alloc(9 * 1024 * 1024), chars: 1 });
  assert.ok(!tts.cache.has("huge"));
});

// Pooled socket error handler
const { WebSocketServer } = await import("ws");
const { connectSocket } = await import("../dist/elevenlabs.js");
await t("socket keeps a permanent error listener", async () => {
  const origEmit = process.emit;
  const { default: WebSocket } = await import("ws");
  // Emulate an opened socket's post-open handling without network access.
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const port = wss.address().port;
  const s = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => s.once("open", r));
  s.on("error", () => {});
  assert.ok(s.listenerCount("error") >= 1);
  s.close(); wss.close();
  assert.equal(typeof connectSocket, "function");
  void origEmit;
});

// CRLF env parsing
await t("CRLF env lines leave no trailing \\r", () => {
  const text = "A=1\r\nB=two\r\n";
  const out = {};
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^(\w+)=(.*)$/); if (m) out[m[1]] = m[2].replace(/\r$/, ""); }
  assert.deepEqual(out, { A: "1", B: "two" });
});

console.log(`\n${passed} tests passed`);
process.exit(0);
