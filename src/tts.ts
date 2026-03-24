import { createHash, randomUUID, randomBytes } from "crypto";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Edge TTS WebSocket protocol
//
// Microsoft Edge exposes a TTS endpoint used by the browser's read-aloud
// feature. As of late 2024, Microsoft added DRM-style authentication:
//   - Sec-MS-GEC: a SHA-256 token derived from a rounded Windows FILETIME
//   - Sec-MS-GEC-Version: tracks the current Edge Chromium version
//   - MUID cookie: a random Microsoft User ID
//
// The protocol itself:
//   1. Open a WebSocket with auth params + headers.
//   2. Send a speech config message (output format).
//   3. Send an SSML synthesis message.
//   4. Receive text metadata + binary audio chunks (OggOpus frames).
//   5. A turn.end message signals the stream is complete.
//
// This module implements the protocol directly -- no Python, no CLI, no
// third-party npm wrappers. Auth algorithm ported from rany2/edge-tts v7.2.7.
// ---------------------------------------------------------------------------

const EDGE_TTS_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Microsoft dropped OGG Opus support circa early 2026; WebM Opus still works.
const AUDIO_OUTPUT_FORMAT = "webm-24khz-16bit-mono-opus";

// Auth constants — must track the current stable Edge Chromium version.
// When Microsoft updates Edge, update this to match (check rany2/edge-tts).
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

/** Windows FILETIME epoch offset: seconds between 1601-01-01 and 1970-01-01. */
const WIN_EPOCH = 11644473600;

/** Clock skew accumulated from server Date headers on 403 responses. */
let clockSkewSeconds = 0;

/**
 * Generate the Sec-MS-GEC token required by Microsoft's Edge TTS endpoint.
 *
 * Algorithm (from rany2/edge-tts drm.py):
 *   1. Unix timestamp (seconds) + clock skew correction
 *   2. Add Windows epoch offset (11644473600)
 *   3. Round down to nearest 5 minutes (300s)
 *   4. Convert to 100-nanosecond intervals (× 1e7)
 *   5. SHA-256("{ticks}{TRUSTED_CLIENT_TOKEN}") → uppercase hex
 */
function generateSecMsGec(): string {
  let ticks = Date.now() / 1000 + clockSkewSeconds;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7; // convert to 100-nanosecond intervals
  const strToHash = `${Math.round(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  return createHash("sha256").update(strToHash, "ascii").digest("hex").toUpperCase();
}

/** Generate a random MUID (Microsoft User ID) — 32 uppercase hex chars. */
function generateMuid(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

/** Build the full WebSocket URL with auth query parameters. */
function buildTtsUrl(connectionId: string): string {
  const gec = generateSecMsGec();
  return (
    `${EDGE_TTS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectionId}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  );
}

/** Build WebSocket connection headers including MUID cookie. */
function buildTtsHeaders(): Record<string, string> {
  return {
    "User-Agent":
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 ` +
      `Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    Cookie: `muid=${generateMuid()};`,
  };
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

const VOICES: ReadonlyArray<string> = [
  "en-US-JennyNeural",
  "en-US-GuyNeural",
  "en-US-AriaNeural",
];

const DEFAULT_VOICE = "en-US-JennyNeural";
const DEFAULT_RATE = "+18%";
const DEFAULT_VOLUME = "+0%";
const DEFAULT_PITCH = "+0Hz";

// ---------------------------------------------------------------------------
// Pronunciation substitution table
//
// Add language-specific pronunciation rules here. Edge TTS sometimes
// struggles with abbreviations, symbols, and domain-specific terms.
// This table applies regex replacements BEFORE text reaches SSML.
//
// Order matters: more specific patterns first, general ones last.
// ---------------------------------------------------------------------------

interface PronunciationRule {
  pattern: RegExp;
  replacement: string;
}

const PRONUNCIATION_RULES: ReadonlyArray<PronunciationRule> = [
  // Common abbreviations
  { pattern: /\bSTT\b/g, replacement: "S T T" },
  { pattern: /\bTTS\b/g, replacement: "T T S" },
  { pattern: /\bAPI\b/g, replacement: "A P I" },
  { pattern: /\bPR\b/g, replacement: "pull request" },
  { pattern: /\bCI\b/g, replacement: "C I" },
  { pattern: /\bCD\b/g, replacement: "C D" },

  // Units and symbols
  { pattern: /(\d+)\s*ms\b/g, replacement: "$1 milliseconds" },
  { pattern: /(\d+)\s*s\b/g, replacement: "$1 seconds" },
  { pattern: /(\d+)\s*min\b/g, replacement: "$1 minutes" },
  { pattern: /(\d+)%/g, replacement: "$1 percent" },
  { pattern: /(\d+)\s*USD/g, replacement: "$1 dollars" },
];

/**
 * Apply pronunciation substitutions to text before TTS synthesis.
 * Converts abbreviations and symbols to spoken equivalents.
 */
function preprocessPronunciation(text: string): string {
  let result = text;
  for (const rule of PRONUNCIATION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pre-cached common phrases (populated lazily on first use)
// ---------------------------------------------------------------------------

const CACHED_PHRASES: ReadonlyArray<string> = [
  "Hello",
  "Yes",
  "No",
  "One moment",
  "Thanks",
  "OK",
  "Sorry",
  "Please wait",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TTSConfig {
  /** TTS voice name. Default: 'en-US-JennyNeural' */
  voice?: string;
  /** Speech rate modifier, e.g. '+20%' or '-10%'. Default: '+25%' */
  rate?: string;
  /** Volume modifier, e.g. '+10%'. Default: '+0%' */
  volume?: string;
  /** Pitch modifier, e.g. '+5Hz'. Default: '+0Hz' */
  pitch?: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequestId(): string {
  return randomUUID().replace(/-/g, "");
}

function buildSpeechConfigMessage(requestId: string): string {
  const config = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
          outputFormat: AUDIO_OUTPUT_FORMAT,
        },
      },
    },
  });

  return (
    `X-Timestamp:${new Date().toISOString()}\r\n` +
    "Content-Type:application/json; charset=utf-8\r\n" +
    `Path:speech.config\r\n\r\n${config}`
  );
}

function buildSSMLMessage(
  requestId: string,
  text: string,
  voice: string,
  rate: string,
  volume: string,
  pitch: string,
): string {
  // Escape XML entities in the user-supplied text.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  // NOTE: <break> SSML element causes Edge TTS WebSocket 1007 rejection as of 2026-03.
  // Microsoft dropped support for it in their free endpoint. Keep commas as-is.
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escaped}` +
    `</prosody></voice></speak>`;

  return (
    `X-RequestId:${requestId}\r\n` +
    "Content-Type:application/ssml+xml\r\n" +
    `X-Timestamp:${new Date().toISOString()}\r\n` +
    `Path:ssml\r\n\r\n${ssml}`
  );
}

/**
 * Extract audio payload from a binary WebSocket frame.
 *
 * Binary frames have a 2-byte header-length prefix (big-endian UInt16)
 * followed by UTF-8 headers, then the raw audio bytes.
 */
function extractAudioFromBinaryFrame(data: Buffer): Buffer | null {
  if (data.length < 2) return null;
  const headerLen = data.readUInt16BE(0);
  const audioStart = 2 + headerLen;
  if (audioStart >= data.length) return null;
  return data.subarray(audioStart);
}

// ---------------------------------------------------------------------------
// TextToSpeech
// ---------------------------------------------------------------------------

/** Maximum text length accepted by synthesize(). */
const MAX_TEXT_LENGTH = 5000;

/** Force-reconnect if last successful synthesis was this long ago. */
const WS_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

export class TextToSpeech {
  private voice: string;
  private rate: string;
  private volume: string;
  private pitch: string;

  private readonly cache = new Map<string, Buffer>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheWarmed = false;
  private closed = false;
  private aborted = false;

  // Persistent WebSocket -- reused across synthesis calls to avoid repeated
  // TLS handshakes (saves 80-200ms per call).
  private persistentWs: WebSocket | null = null;
  private wsReady: Promise<void> | null = null;
  private wsConnecting = false;
  private lastSuccessfulSynthesis = 0;
  private pendingRequests = new Map<
    string,
    {
      audioChunks: Buffer[];
      resolve: (buf: Buffer) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(config?: TTSConfig) {
    this.voice = config?.voice ?? DEFAULT_VOICE;
    this.rate = config?.rate ?? DEFAULT_RATE;
    this.volume = config?.volume ?? DEFAULT_VOLUME;
    this.pitch = config?.pitch ?? DEFAULT_PITCH;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Synthesize `text` into an OggOpus audio buffer.
   *
   * Short common phrases are served from an in-memory cache after the first
   * call warms it.  All other text goes through the Edge TTS WebSocket.
   *
   * A persistent WebSocket connection is maintained across calls to eliminate
   * TLS handshake overhead.  Each request is correlated via its X-RequestId.
   */
  async synthesize(text: string): Promise<Buffer> {
    this.aborted = false;

    if (this.closed) {
      throw new Error("TextToSpeech instance has been closed");
    }

    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(
        `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters (got ${text.length})`,
      );
    }

    // Apply pronunciation fixes before synthesis
    const processedText = preprocessPronunciation(text);

    const cacheKey = this.cacheKey(processedText);

    // Check cache first.
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    this.cacheMisses++;
    // Retry on transient Edge TTS errors (code 1007, connection drops).
    // Edge TTS is a free, undocumented endpoint that occasionally rejects connections.
    let audio!: Buffer;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        audio = await this.synthesizeViaWebSocket(processedText);
        lastErr = null;
        break;
      } catch (err) {
        if (this.aborted || this.closed) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        console.error(`[tts] attempt ${attempt + 1}/3 failed: ${lastErr.message}`);
        // Brief pause before retry to let the old socket fully close
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (lastErr) throw lastErr;

    // Cache short phrases for future use (based on processed text, not original).
    if (this.shouldCache(processedText)) {
      this.cache.set(cacheKey, audio);
    }

    // Warm the cache lazily in the background after the first real synthesis.
    if (!this.cacheWarmed) {
      this.cacheWarmed = true;
      this.warmCache().catch(() => {
        /* best-effort */
      });
    }

    return audio;
  }

  /**
   * Synthesize `text` by splitting it into sentences and yielding each
   * sentence's audio buffer as soon as it is ready.
   *
   * This lets the caller start playing the first sentence while subsequent
   * ones are still being synthesized, dramatically reducing perceived latency
   * for long responses.
   *
   * Respects the abort flag -- if abort() is called mid-stream, the generator
   * throws and stops synthesizing remaining sentences.
   */
  async *synthesizeChunked(text: string): AsyncGenerator<Buffer, void, unknown> {
    this.aborted = false;

    if (this.closed) {
      throw new Error("TextToSpeech instance has been closed");
    }

    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(
        `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters (got ${text.length})`,
      );
    }

    // Apply pronunciation fixes before synthesis
    const processedText = preprocessPronunciation(text);
    const sentences = this.splitIntoSentences(processedText);

    for (const sentence of sentences) {
      if (this.aborted) {
        throw new Error("Aborted");
      }

      const cacheKey = this.cacheKey(sentence);
      const cached = this.cache.get(cacheKey);

      if (cached) {
        this.cacheHits++;
        yield cached;
        continue;
      }

      this.cacheMisses++;
      let audio: Buffer;
      try {
        audio = await this.synthesizeViaWebSocket(sentence);
      } catch (firstErr) {
        // Abort is non-recoverable — rethrow to stop the stream
        if (this.aborted || (firstErr instanceof Error && firstErr.message === "Aborted")) {
          throw firstErr;
        }
        // Retry once on transient errors (code 1007, connection drops)
        try {
          audio = await this.synthesizeViaWebSocket(sentence);
        } catch (retryErr) {
          if (this.aborted || (retryErr instanceof Error && retryErr.message === "Aborted")) {
            throw retryErr;
          }
          // Both attempts failed — skip this sentence, continue
          console.error(
            `[tts] sentence synthesis failed after retry, skipping: ${retryErr instanceof Error ? retryErr.message : retryErr}`,
          );
          continue;
        }
      }

      if (this.aborted) {
        throw new Error("Aborted");
      }

      if (this.shouldCache(sentence)) {
        this.cache.set(cacheKey, audio);
      }

      yield audio;
    }

    // Warm the cache lazily in the background after the first real synthesis.
    if (!this.cacheWarmed) {
      this.cacheWarmed = true;
      this.warmCache().catch(() => {
        /* best-effort */
      });
    }
  }

  /**
   * Abort any ongoing synthesis.
   *
   * Sets the aborted flag (checked by synthesize/synthesizeChunked) and
   * rejects all pending WebSocket requests with an "Aborted" error.
   */
  abort(): void {
    this.aborted = true;

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Aborted"));
      this.pendingRequests.delete(id);
    }
  }

  /** Change the active voice. */
  setVoice(voice: string): void {
    if (this.voice !== voice) {
      this.voice = voice;
      // Invalidate cache since it was generated with a different voice.
      this.cache.clear();
      this.cacheWarmed = false;
    }
  }

  /** List TTS voices available on the Edge TTS service. */
  static listVoices(): string[] {
    return [...VOICES];
  }

  /** Cache performance counters. */
  get cacheStats(): CacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
    };
  }

  /**
   * Close the persistent WebSocket connection.
   * Call this when the TextToSpeech instance is no longer needed (e.g. bot
   * disconnect) to release the underlying socket and cancel any in-flight
   * requests.
   */
  close(): void {
    this.closed = true;

    if (this.persistentWs) {
      this.persistentWs.removeAllListeners();
      this.persistentWs.close();
      this.persistentWs = null;
      this.wsReady = null;
      this.wsConnecting = false;
    }

    // Reject any in-flight requests.
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("TextToSpeech instance closed"));
    }
    this.pendingRequests.clear();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Split text into sentence-level chunks for incremental synthesis.
   *
   * Strategy:
   *   1. Split on sentence-ending punctuation (. ! ? ;) followed by whitespace
   *      or end-of-string.
   *   2. If any segment exceeds 200 characters, further split on em dash
   *      boundaries (commas removed — they caused audible inter-chunk gaps).
   *   3. Merge very short segments (< 10 chars) with the previous segment to
   *      avoid choppy synthesis of fragments like "Ja." or "Ok,".
   *   4. Never return empty strings.
   */
  private splitIntoSentences(text: string): string[] {
    // Step 0: Protect abbreviations from being split.
    // Replace "abbrev. " with "abbrev.\x00" temporarily, then restore after splitting.
    const ABBREVS = /\b(e\.g|i\.e|vs|etc|approx|no|dept|inc)\.\s/gi;
    const protected_ = text.replace(ABBREVS, (match) => match.replace(/\.\s/, '.\x00'));

    // Step 1: Split on sentence-ending punctuation followed by space or EOS.
    // The regex keeps the punctuation attached to the preceding text.
    const rawParts = protected_.split(/(?<=[.!?;])\s+/).map(s => s.replace(/\x00/g, ' '));

    // Step 2: Further split long segments on em dash and comma.
    const refined: string[] = [];
    for (const part of rawParts) {
      if (part.length > 200) {
        // Split on em dash only — comma splits cause audible gaps between chunks.
        const subParts = part.split(/(?<=—)\s+/);
        for (const sub of subParts) {
          const trimmed = sub.trim();
          if (trimmed.length > 0) {
            refined.push(trimmed);
          }
        }
      } else {
        const trimmed = part.trim();
        if (trimmed.length > 0) {
          refined.push(trimmed);
        }
      }
    }

    // Step 3: Merge very short segments with the previous one.
    const merged: string[] = [];
    for (const segment of refined) {
      if (merged.length > 0 && segment.length < 10) {
        merged[merged.length - 1] += " " + segment;
      } else {
        merged.push(segment);
      }
    }

    // Guarantee at least one segment (the original text).
    if (merged.length === 0) {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        return [trimmed];
      }
      return [];
    }

    return merged;
  }

  /**
   * Ensure a persistent WebSocket is open and ready.  If the existing
   * connection is still alive and not stale, returns immediately.  Otherwise
   * creates a new one and waits for the `open` event.
   *
   * Guards against concurrent callers: if a connection attempt is already in
   * progress (`wsConnecting`), subsequent callers share the same `wsReady`
   * promise instead of opening a second socket.
   */
  private ensureWebSocket(): Promise<void> {
    // Fast path: existing connection is open, not stale, and not mid-connect.
    if (
      this.persistentWs &&
      this.persistentWs.readyState === WebSocket.OPEN &&
      this.wsReady &&
      !this.isConnectionStale()
    ) {
      return this.wsReady;
    }

    // If another call is already connecting, piggyback on its promise.
    if (this.wsConnecting && this.wsReady) {
      return this.wsReady;
    }

    // Clean up stale/broken socket if it exists.
    if (this.persistentWs) {
      this.persistentWs.removeAllListeners();
      try {
        this.persistentWs.close();
      } catch {
        /* ignore */
      }
      this.persistentWs = null;
    }

    this.wsConnecting = true;

    const connectionId = makeRequestId();
    const url = buildTtsUrl(connectionId);

    const ws = new WebSocket(url, {
      headers: buildTtsHeaders(),
    });

    this.persistentWs = ws;

    // Register persistent handlers BEFORE the open/error promise so that
    // events emitted between open and handler registration are not lost.
    ws.on("message", (data: WebSocket.Data, isBinary: boolean) => {
      this.handleMessage(data, isBinary);
    });

    ws.on("error", (err: Error) => {
      this.handleConnectionLost(
        new Error(`Edge TTS WebSocket error: ${err.message}`),
      );
    });

    ws.on("close", (code: number) => {
      this.handleConnectionLost(
        new Error(`Edge TTS WebSocket closed unexpectedly (code ${code})`),
      );
    });

    // Handle HTTP error responses during WebSocket upgrade (e.g., 403 auth failure).
    // The ws library emits 'unexpected-response' instead of 'error' for these.
    ws.on("unexpected-response" as any, (req: any, res: any) => {
      const statusCode = res?.statusCode ?? 0;
      console.error(`[tts] Edge TTS WebSocket upgrade failed: HTTP ${statusCode}`);

      // On 403, adjust clock skew from server Date header (matches rany2/edge-tts DRM logic)
      if (statusCode === 403 && res?.headers?.date) {
        const serverTime = new Date(res.headers.date).getTime() / 1000;
        const localTime = Date.now() / 1000;
        if (!isNaN(serverTime)) {
          clockSkewSeconds = serverTime - localTime;
          console.error(`[tts] clock skew adjusted: ${clockSkewSeconds.toFixed(1)}s (server Date: ${res.headers.date})`);
        }
      }

      this.handleConnectionLost(
        new Error(`Edge TTS HTTP ${statusCode} — ${statusCode === 403 ? "auth failed, clock skew adjusted" : "upgrade rejected"}`),
      );
    });

    this.wsReady = new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        this.wsConnecting = false;
        resolve();
      });
      ws.once("error", (err: Error) => {
        this.persistentWs = null;
        this.wsReady = null;
        this.wsConnecting = false;
        reject(new Error(`Edge TTS WebSocket connection failed: ${err.message}`));
      });
    });

    return this.wsReady;
  }

  /**
   * Check whether the persistent connection is stale (no successful synthesis
   * in the last 5 minutes).  A WebSocket can report readyState OPEN while the
   * underlying TCP connection is half-open; forcing a reconnect avoids silent
   * hangs on the next synthesis.
   */
  private isConnectionStale(): boolean {
    if (this.lastSuccessfulSynthesis === 0) return false;
    return Date.now() - this.lastSuccessfulSynthesis > WS_STALENESS_MS;
  }

  /**
   * Extract the X-RequestId from a text WebSocket frame header block.
   */
  private static extractRequestId(msg: string): string | null {
    const match = msg.match(/X-RequestId:([a-f0-9]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Extract the X-RequestId from a binary WebSocket frame header block.
   * The first 2 bytes are header length (UInt16BE), then the header is UTF-8.
   */
  private static extractRequestIdFromBinary(data: Buffer): string | null {
    if (data.length < 2) return null;
    const headerLen = data.readUInt16BE(0);
    if (2 + headerLen > data.length) return null;
    const headerStr = data.subarray(2, 2 + headerLen).toString("utf-8");
    return TextToSpeech.extractRequestId(headerStr);
  }

  /**
   * Handle an incoming WebSocket message on the persistent connection.
   * Routes audio chunks and turn.end signals to the correct pending request.
   */
  private handleMessage(data: WebSocket.Data, isBinary: boolean): void {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const reqId = TextToSpeech.extractRequestIdFromBinary(buf);
      const audio = extractAudioFromBinaryFrame(buf);
      if (reqId && audio && audio.length > 0) {
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          pending.audioChunks.push(audio);
        }
      }
      return;
    }

    // Text frame -- check for turn.end and route to the correct request.
    const msg = data.toString();
    if (msg.includes("Path:turn.end")) {
      const reqId = TextToSpeech.extractRequestId(msg);
      if (reqId) {
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          this.pendingRequests.delete(reqId);
          clearTimeout(pending.timeout);
          if (pending.audioChunks.length === 0) {
            pending.reject(new Error("Edge TTS returned no audio data"));
          } else {
            this.lastSuccessfulSynthesis = Date.now();
            pending.resolve(Buffer.concat(pending.audioChunks));
          }
        }
      }
    }
  }

  /**
   * Handle a lost connection -- reject all pending requests and clear state
   * so the next call creates a fresh connection.
   */
  private handleConnectionLost(err: Error): void {
    this.persistentWs = null;
    this.wsReady = null;
    this.wsConnecting = false;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  /**
   * Send SSML over the persistent WebSocket and collect the returned OggOpus
   * audio chunks into a single buffer.  Each request is identified by its
   * unique X-RequestId so multiple requests can be in-flight on the same
   * connection (though in practice we serialize via the cache/warm logic).
   */
  private async synthesizeViaWebSocket(text: string): Promise<Buffer> {
    if (this.aborted) {
      throw new Error("Aborted");
    }

    await this.ensureWebSocket();

    const ws = this.persistentWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Edge TTS WebSocket is not open after ensureWebSocket()");
    }

    const requestId = makeRequestId();

    return new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          this.pendingRequests.delete(requestId);
          reject(new Error("Edge TTS synthesis timed out after 30 seconds"));
        }
      }, 30_000);

      this.pendingRequests.set(requestId, {
        audioChunks: [],
        resolve,
        reject,
        timeout,
      });

      // Send speech config + SSML for this request.
      ws.send(buildSpeechConfigMessage(requestId));
      ws.send(
        buildSSMLMessage(requestId, text, this.voice, this.rate, this.volume, this.pitch),
      );
    });
  }

  /** Build a cache key incorporating voice + prosody settings. */
  private cacheKey(text: string): string {
    return `${this.voice}|${this.rate}|${this.volume}|${this.pitch}|${text}`;
  }

  /** Short, common phrases are worth caching. */
  private shouldCache(text: string): boolean {
    return text.length <= 30;
  }

  /**
   * Pre-synthesize common phrases so subsequent calls are instant.
   * Runs in the background and does not block the caller.
   */
  private async warmCache(): Promise<void> {
    for (const phrase of CACHED_PHRASES) {
      if (this.closed || this.aborted) return;
      const key = this.cacheKey(phrase);
      if (this.cache.has(key)) continue;
      try {
        const audio = await this.synthesizeViaWebSocket(phrase);
        if (!this.closed) {
          this.cache.set(key, audio);
        }
      } catch {
        // Non-fatal -- the phrase will be synthesized on demand.
      }
    }
  }
}
