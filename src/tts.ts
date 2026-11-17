/**
 * ElevenLabs Text-to-Speech over the stream-input websocket.
 *
 * A socket is kept warm between replies so the first audio chunk is not
 * delayed by a TLS handshake. Audio is requested as 24 kHz PCM (available on
 * every plan, no codec in the way) and upsampled to Discord's 48 kHz stereo as
 * it arrives, so playback starts on the first chunk.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
 */

import { safeError } from "./redact.js";
import WebSocket from "ws";
import { PcmUpsampler } from "./audio-utils.js";
import { debugLog } from "./debug.js";
import { connectSocket, ElevenLabsError, toIsoLanguage } from "./elevenlabs.js";
import { SpeechStream } from "./speech-stream.js";
import { DailyBudget, type BudgetSnapshot } from "./usage-budget.js";

export { isTtsAbort, TtsAbortError, SpeechStream } from "./speech-stream.js";

const DEFAULT_MODEL = "eleven_flash_v2_5"; // lowest latency model (~75 ms)
export const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // "George", the premade voice used in the API docs
const DEFAULT_DAILY_BUDGET_CHARS = 50_000;
const OUTPUT_FORMAT = "pcm_24000";
const INACTIVITY_TIMEOUT_SECS = "180"; // longest the API allows an idle socket to stay open
const MAX_TEXT_LENGTH = 5000;
const MAX_CACHED_TEXT_LENGTH = 30;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 200;
const MAX_ATTEMPTS = 2;

export interface TTSConfig {
  apiKey: string;
  model?: string;
  /** ElevenLabs voice_id. */
  voice?: string;
  /** BCP-47 tag such as "nb-NO". Omit to let the model infer it from the text. */
  language?: string;
  dailyBudgetChars?: number;
}

interface CachedSpeech {
  pcm: Buffer;
  chars: number;
}

interface ServerMessage {
  audio?: string | null;
  alignment?: { chars?: string[] } | null;
  isFinal?: boolean | null;
  error?: string;
  message?: string;
}

export class TextToSpeech {
  private voice: string;
  private language: string | undefined;
  private readonly model: string;
  private readonly budget: DailyBudget;
  private readonly cache = new Map<string, CachedSpeech>();
  private readonly active = new Set<SpeechStream>();
  private warm: Promise<WebSocket> | null = null;
  private cacheBytes = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private closed = false;

  constructor(private readonly config: TTSConfig) {
    this.voice = config.voice ?? DEFAULT_VOICE;
    this.language = config.language;
    this.model = config.model ?? DEFAULT_MODEL;
    this.budget = new DailyBudget("tts", config.dailyBudgetChars ?? DEFAULT_DAILY_BUDGET_CHARS, "chars");
  }

  /**
   * Start synthesizing `text`. Returns immediately; audio becomes readable as
   * soon as the first chunk arrives. Failures and aborts surface via `done`.
   */
  speak(text: string): SpeechStream {
    const stream = new SpeechStream();
    const rejected = this.reject(text);
    if (rejected) {
      stream.finish(rejected);
      return stream;
    }

    const cached = this.cache.get(this.cacheKey(text));
    if (cached) {
      this.cache.delete(this.cacheKey(text)); // refresh recency
      this.cache.set(this.cacheKey(text), cached);
      this.cacheHits++;
      stream.append(cached.pcm, cached.chars);
      stream.finish();
      return stream;
    }

    this.cacheMisses++;
    this.budget.add(text.length);
    this.active.add(stream);
    const finished = () => {
      this.active.delete(stream);
      if (this.active.size === 0) this.warmUp();
    };
    stream.done.then(finished, finished);
    this.synthesize(stream, text).catch((err) => {
      console.error(`[tts] synthesis failed: ${safeError(err)}`);
      stream.finish(err instanceof Error ? err : new Error(String(err)));
    });
    return stream;
  }

  /** Open the websocket for the next reply ahead of time. No-op while a reply is being synthesized. */
  warmUp(): void {
    if (this.closed || this.warm || this.active.size > 0) return;
    const socket = this.openSocket();
    this.warm = socket;
    socket.catch(() => {
      if (this.warm === socket) this.warm = null;
    });
  }

  /** Cancel every in-flight synthesis (barge-in). */
  abort(): void {
    for (const stream of [...this.active]) stream.abort();
  }

  setVoice(voice: string): void {
    if (voice === this.voice) return;
    this.voice = voice;
    this.resetConnection();
  }

  setLanguage(language: string | undefined): void {
    this.language = language;
    this.resetConnection();
  }

  get usage(): BudgetSnapshot {
    return this.budget.snapshot();
  }

  get cacheStats(): { hits: number; misses: number; size: number } {
    return { hits: this.cacheHits, misses: this.cacheMisses, size: this.cache.size };
  }

  close(): void {
    this.closed = true;
    this.abort();
    this.resetConnection();
  }

  private reject(text: string): Error | null {
    if (this.closed) return new Error("TextToSpeech instance has been closed");
    if (text.length > MAX_TEXT_LENGTH) {
      return new Error(`Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters (got ${text.length})`);
    }
    if (this.budget.exhausted && !this.cache.has(this.cacheKey(text))) {
      return new ElevenLabsError("TTS daily character budget reached", false, true);
    }
    return null;
  }

  private async synthesize(stream: SpeechStream, text: string): Promise<void> {
    const startedAt = performance.now();
    stream.once("firstAudio", () =>
      debugLog(`TTS_FIRST_AUDIO: ${(performance.now() - startedAt).toFixed(0)}ms after speak()`),
    );

    for (let attempt = 1; ; attempt++) {
      try {
        await this.runOnce(stream, text);
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const retryable = !(error instanceof ElevenLabsError && error.fatal);
        if (stream.cancelled || stream.hasAudio || !retryable || attempt >= MAX_ATTEMPTS) {
          stream.finish(error);
          return;
        }
        console.error(`[tts] attempt ${attempt} failed, retrying: ${safeError(error)}`);
      }
    }
  }

  private async runOnce(stream: SpeechStream, text: string): Promise<void> {
    const socket = await this.takeSocket();
    stream.abortSource = () => socket.close();
    if (stream.cancelled) {
      socket.close();
      return;
    }

    const upsampler = new PcmUpsampler();
    const pcmParts: Buffer[] = [];
    let charsSpoken = 0;

    await new Promise<void>((resolve, reject) => {
      socket.on("message", (raw) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.error) {
          reject(new ElevenLabsError(message.message ?? message.error, /quota/i.test(message.error), true));
          return;
        }
        if (message.audio) {
          const pcm = upsampler.process(Buffer.from(message.audio, "base64"));
          const chars = message.alignment?.chars?.length ?? 0;
          charsSpoken += chars;
          pcmParts.push(pcm);
          stream.append(pcm, chars);
        }
        if (message.isFinal) {
          socket.close();
          resolve();
        }
      });
      socket.once("error", reject);
      socket.once("close", () => {
        if (stream.cancelled) resolve();
        else reject(new Error("TTS connection closed before the reply was complete"));
      });
      socket.send(JSON.stringify({ text: `${text} ` }));
      socket.send(JSON.stringify({ text: "" })); // end of input: generate the rest and finish
    });

    if (stream.cancelled) return;
    if (text.length <= MAX_CACHED_TEXT_LENGTH) {
      this.cacheStore(this.cacheKey(text), { pcm: Buffer.concat(pcmParts), chars: charsSpoken });
    }
    stream.finish();
  }

  /** Use the warm socket when it is still open, otherwise connect now. */
  private async takeSocket(): Promise<WebSocket> {
    const pending = this.warm;
    this.warm = null;
    if (pending) {
      try {
        const socket = await pending;
        if (socket.readyState === WebSocket.OPEN) return socket;
      } catch {
        // fall through to a fresh connection
      }
    }
    return this.openSocket();
  }

  private async openSocket(): Promise<WebSocket> {
    const socket = await connectSocket(
      `/v1/text-to-speech/${encodeURIComponent(this.voice)}/stream-input`,
      {
        model_id: this.model,
        output_format: OUTPUT_FORMAT,
        language_code: toIsoLanguage(this.language),
        sync_alignment: "true",
        auto_mode: "true", // generate immediately instead of buffering for chunk schedules
        inactivity_timeout: INACTIVITY_TIMEOUT_SECS,
      },
      this.config.apiKey,
    );
    socket.send(JSON.stringify({ text: " " })); // required opening message
    return socket;
  }

  private resetConnection(): void {
    const pending = this.warm;
    this.warm = null;
    pending?.then((socket) => socket.close()).catch(() => {});
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** Insert into the LRU cache (Map keeps insertion order), evicting oldest entries over the caps. */
  private cacheStore(key: string, value: CachedSpeech): void {
    if (value.pcm.length > MAX_CACHE_BYTES) return;
    const old = this.cache.get(key);
    if (old) {
      this.cacheBytes -= old.pcm.length;
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    this.cacheBytes += value.pcm.length;
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cacheBytes -= this.cache.get(oldest.value)!.pcm.length;
      this.cache.delete(oldest.value);
    }
  }

  private cacheKey(text: string): string {
    return `${this.voice}|${this.language ?? ""}|${text}`;
  }
}
