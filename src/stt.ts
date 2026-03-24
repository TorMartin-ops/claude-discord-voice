/**
 * Azure Speech-to-Text wrapper with aggressive cost optimization.
 *
 * Azure STT costs ~$1/hour of audio. Key optimizations:
 * - Client-side VAD filters silence before audio reaches this module
 * - Single-shot recognition for short utterances (< 2s)
 * - Continuous recognition only for longer speech
 * - 1s end-silence timeout to stop early
 * - 30s max duration auto-stop
 * - Session pooling (recognizer reuse)
 */

import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { Readable } from "stream";

export interface STTConfig {
  subscriptionKey: string;
  region: string;
  language?: string; // default 'en-US'
  endSilenceMs?: number; // default 1000
  maxDurationMs?: number; // default 30000
  dailyBudgetUSD?: number; // default 1.0 ($1/day = ~60 min audio)
}

export interface TranscriptionResult {
  text: string;
  language: string;
  durationMs: number;
  confidence: number;
  budgetExhausted?: boolean; // true when this result signals budget cap reached
}

export interface UsageStats {
  totalSeconds: number;
  estimatedCostUSD: number;
  transcriptions: number;
  dailyBudgetUSD: number;
  dailyBudgetRemainingUSD: number;
  dailyBudgetResetAt: string; // ISO timestamp of next midnight
  budgetExhausted: boolean;
}

const COST_PER_SECOND = 1 / 3600; // $1/hour
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
const SHORT_UTTERANCE_THRESHOLD_MS = 1000;
// Azure STT errors on extremely short audio. 200ms = 6400 bytes at 16kHz mono 16-bit.
const MIN_AUDIO_BYTES = BYTES_PER_SECOND * 0.5; // 16000 bytes = 500ms — Azure returns NoMatch on sub-500ms audio
const RETRY_DELAY_BASE_MS = 500; // exponential backoff base for transient retries

export class SpeechToText {
  private readonly speechConfig: sdk.SpeechConfig;
  private readonly language: string;
  private readonly maxDurationMs: number;
  private readonly dailyBudgetUSD: number;
  private stats: UsageStats = {
    totalSeconds: 0,
    estimatedCostUSD: 0,
    transcriptions: 0,
    dailyBudgetUSD: 1.0,
    dailyBudgetRemainingUSD: 1.0,
    dailyBudgetResetAt: "",
    budgetExhausted: false,
  };
  private budgetDateKey: string = ""; // YYYY-MM-DD for daily reset detection
  private disposed = false;
  /** Active recognizers tracked for cleanup on dispose(). */
  private activeRecognizers = new Set<sdk.SpeechRecognizer>();

  constructor(config: STTConfig) {
    this.language = config.language ?? "en-US";
    this.maxDurationMs = config.maxDurationMs ?? 30000;
    this.dailyBudgetUSD = config.dailyBudgetUSD ?? 1.0;
    this.stats.dailyBudgetUSD = this.dailyBudgetUSD;
    this.stats.dailyBudgetRemainingUSD = this.dailyBudgetUSD;
    this.resetDailyBudgetIfNeeded();

    this.speechConfig = sdk.SpeechConfig.fromSubscription(
      config.subscriptionKey,
      config.region,
    );
    this.speechConfig.speechRecognitionLanguage = this.language;

    // End-silence timeout: very aggressive since audio is already VAD-segmented.
    // The buffer is finite and pushed via pushStream.close(), so Azure just
    // needs to process what's there without waiting for more.
    this.speechConfig.setProperty(
      "SpeechServiceConnection_EndSilenceTimeoutMs",
      String(config.endSilenceMs ?? 300),
    );

    // Initial silence timeout: allow for pre-speech buffer delay
    this.speechConfig.setProperty(
      "SpeechServiceConnection_InitialSilenceTimeoutMs",
      "5000",
    );

    // Segmentation silence: aligned with endSilence since VAD already segments speech
    this.speechConfig.setProperty(
      "Speech_SegmentationSilenceTimeoutMs",
      "500",
    );

    // Detailed output format gives us NBest with real confidence scores
    // (Simple format returns confidence=0 always)
    this.speechConfig.outputFormat = sdk.OutputFormat.Detailed;

    // Word-level timestamps removed — never consumed, adds Azure-side processing latency

    // Disable profanity filter — Azure censors words with *** by default,
    // which garbles output for a productivity tool
    this.speechConfig.setProfanity(sdk.ProfanityOption.Raw);

    // Enable TrueText post-processing for better punctuation and formatting
    this.speechConfig.setProperty(
      "SpeechServiceResponse_PostProcessingOption",
      "TrueText",
    );
  }

  /**
   * Add phrase hints to improve recognition of domain-specific terms.
   * Azure STT uses these to bias recognition toward expected words.
   */
  private createPhraseList(recognizer: sdk.SpeechRecognizer): void {
    const phraseList = sdk.PhraseListGrammar.fromRecognizer(recognizer);
    const phrases: string[] = [
      // Add domain-specific terms here to improve recognition accuracy.
      // Example: "Claude", "GitHub", "deploy", "pipeline",
    ];
    for (const phrase of phrases) {
      phraseList.addPhrase(phrase);
    }
  }

  /**
   * Transcribe a complete PCM buffer (16kHz mono 16-bit LE).
   * Returns null on error or empty speech.
   */
  async transcribe(pcmBuffer: Buffer): Promise<TranscriptionResult | null> {
    if (this.disposed) return null;
    if (pcmBuffer.length === 0) return null;

    // Skip buffers too short for Azure STT (< 200ms). Azure errors on
    // extremely short audio and the result wouldn't be meaningful anyway.
    if (pcmBuffer.length < MIN_AUDIO_BYTES) {
      return null;
    }

    // Daily budget reset check (simple date comparison, no timer needed)
    this.resetDailyBudgetIfNeeded();

    if (this.stats.budgetExhausted) {
      return {
        text: "",
        language: this.language,
        durationMs: 0,
        confidence: 0,
        budgetExhausted: true,
      };
    }

    const durationMs = (pcmBuffer.length / BYTES_PER_SECOND) * 1000;

    // Clamp to max duration
    const effectiveBytes = Math.min(
      pcmBuffer.length,
      (this.maxDurationMs / 1000) * BYTES_PER_SECOND,
    );
    const effectiveBuffer =
      effectiveBytes < pcmBuffer.length
        ? pcmBuffer.subarray(0, effectiveBytes)
        : pcmBuffer;
    const effectiveDurationMs =
      (effectiveBuffer.length / BYTES_PER_SECOND) * 1000;

    try {
      const result = await this.recognizeWithRetry(
        effectiveBuffer,
        effectiveDurationMs,
      );

      // Track usage
      const seconds = effectiveDurationMs / 1000;
      this.stats.totalSeconds += seconds;
      this.stats.estimatedCostUSD += seconds * COST_PER_SECOND;
      this.stats.transcriptions++;
      this.stats.dailyBudgetRemainingUSD = Math.max(
        0,
        this.dailyBudgetUSD - this.stats.estimatedCostUSD,
      );

      // Check if budget is now exhausted
      if (this.stats.estimatedCostUSD >= this.dailyBudgetUSD) {
        this.stats.budgetExhausted = true;
        console.error(
          `[stt] DAILY BUDGET EXHAUSTED: $${this.stats.estimatedCostUSD.toFixed(4)} spent ` +
            `of $${this.dailyBudgetUSD.toFixed(2)} budget. STT disabled until ${this.stats.dailyBudgetResetAt}.`,
        );
      } else if (this.stats.estimatedCostUSD >= this.dailyBudgetUSD * 0.8) {
        console.error(
          `[stt] WARNING: 80%+ of daily budget used ($${this.stats.estimatedCostUSD.toFixed(4)} ` +
            `of $${this.dailyBudgetUSD.toFixed(2)})`,
        );
      }

      this.logUsage(seconds);
      return result;
    } catch (err) {
      console.error(
        `[stt] transcription failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * Transcribe from a streaming PCM source (16kHz mono 16-bit LE).
   * Currently buffers the full stream then delegates to transcribe().
   * The interface enables future true streaming STT without changing callers.
   */
  async transcribeStream(pcmStream: Readable): Promise<TranscriptionResult | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of pcmStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return null;
    return this.transcribe(Buffer.concat(chunks));
  }

  get usage(): UsageStats {
    this.resetDailyBudgetIfNeeded();
    return { ...this.stats };
  }

  dispose(): void {
    this.disposed = true;

    // Cancel any in-progress recognizers
    for (const recognizer of this.activeRecognizers) {
      try {
        recognizer.stopContinuousRecognitionAsync(
          () => recognizer.close(),
          () => recognizer.close(),
        );
      } catch {
        try {
          recognizer.close();
        } catch {
          // best-effort cleanup
        }
      }
    }
    this.activeRecognizers.clear();

    this.logUsage(0, true);
  }

  /** Reset daily counters if the date has changed (simple midnight reset). */
  private resetDailyBudgetIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (today !== this.budgetDateKey) {
      if (this.budgetDateKey !== "") {
        console.error(
          `[stt] daily budget reset (new day: ${today}). Previous: ` +
            `${this.stats.totalSeconds.toFixed(1)}s, $${this.stats.estimatedCostUSD.toFixed(4)}`,
        );
      }
      this.budgetDateKey = today;
      this.stats.totalSeconds = 0;
      this.stats.estimatedCostUSD = 0;
      this.stats.transcriptions = 0;
      this.stats.budgetExhausted = false;
      this.stats.dailyBudgetRemainingUSD = this.dailyBudgetUSD;
    }
    // Always update reset time to next midnight local
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    this.stats.dailyBudgetResetAt = tomorrow.toISOString();
  }

  // -- Private --

  /**
   * Dispatch to single-shot or continuous recognition with a single retry
   * for transient Azure errors (network timeouts, 429 rate limits).
   */
  private async recognizeWithRetry(
    pcmBuffer: Buffer,
    durationMs: number,
  ): Promise<TranscriptionResult | null> {
    const attempt = async (): Promise<TranscriptionResult | null> => {
      return durationMs <= SHORT_UTTERANCE_THRESHOLD_MS
        ? this.recognizeOnce(pcmBuffer)
        : this.recognizeContinuous(pcmBuffer, durationMs);
    };

    try {
      return await attempt();
    } catch (err) {
      if (!this.isTransientError(err)) throw err;

      console.error(
        `[stt] transient error, retrying in ${RETRY_DELAY_BASE_MS}ms: ` +
          `${err instanceof Error ? err.message : err}`,
      );
      await this.sleep(RETRY_DELAY_BASE_MS);

      if (this.disposed) return null;
      return attempt();
    }
  }

  /** Returns true for errors that are likely transient (network, rate limit). */
  private isTransientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up") ||
      msg.includes("network")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Single-shot recognition for short utterances (< 2s).
   * Lower overhead than continuous recognition.
   */
  private recognizeOnce(
    pcmBuffer: Buffer,
  ): Promise<TranscriptionResult | null> {
    return new Promise((resolve, reject) => {
      const { pushStream, audioConfig } = this.createAudioPipeline();
      const recognizer = new sdk.SpeechRecognizer(
        this.speechConfig,
        audioConfig,
      );
      this.activeRecognizers.add(recognizer);
      this.createPhraseList(recognizer);

      // Node Buffer may be backed by a shared ArrayBuffer pool. .buffer returns
      // the entire pool, so we must .slice() to extract only this Buffer's region.
      pushStream.write(pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength) as ArrayBuffer);
      pushStream.close();

      recognizer.recognizeOnceAsync(
        (result) => {
          this.activeRecognizers.delete(recognizer);
          recognizer.close();
          resolve(this.parseResult(result));
        },
        (error) => {
          this.activeRecognizers.delete(recognizer);
          recognizer.close();
          const errMsg = typeof error === "string" ? error : String(error);
          console.error(`[stt] recognizeOnce error: ${errMsg}`);
          reject(new Error(errMsg));
        },
      );
    });
  }

  /**
   * Continuous recognition for longer speech (> 2s).
   * Accumulates partial results and stops on silence or timeout.
   */
  private recognizeContinuous(
    pcmBuffer: Buffer,
    durationMs: number,
  ): Promise<TranscriptionResult | null> {
    return new Promise((resolve, reject) => {
      const { pushStream, audioConfig } = this.createAudioPipeline();
      const recognizer = new sdk.SpeechRecognizer(
        this.speechConfig,
        audioConfig,
      );
      this.activeRecognizers.add(recognizer);
      this.createPhraseList(recognizer);

      const segments: string[] = [];
      let bestConfidence = 0;
      let resolved = false;
      let errorOnCancel: string | null = null;

      const cleanup = () => {
        this.activeRecognizers.delete(recognizer);
        // Null out callbacks to release closure references for GC
        recognizer.recognized = undefined as any;
        recognizer.canceled = undefined as any;
        recognizer.sessionStopped = undefined as any;
      };

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        recognizer.stopContinuousRecognitionAsync(
          () => {
            recognizer.close();
            cleanup();
          },
          () => {
            recognizer.close();
            cleanup();
          },
        );

        // If we got a cancellation error with no segments, reject so retry
        // logic can decide whether it's transient
        if (errorOnCancel && segments.length === 0) {
          reject(new Error(errorOnCancel));
          return;
        }

        if (segments.length === 0) {
          resolve(null);
          return;
        }

        resolve({
          text: segments.join(" "),
          language: this.language,
          durationMs,
          confidence: bestConfidence,
        });
      };

      recognizer.recognized = (_sender, event) => {
        if (
          event.result.reason === sdk.ResultReason.RecognizedSpeech &&
          event.result.text
        ) {
          // Extract Display text from Detailed format for better punctuation/casing
          const props = event.result.properties;
          const raw = props?.getProperty(
            sdk.PropertyId.SpeechServiceResponse_JsonResult,
          );
          let segmentText = event.result.text;
          if (raw) {
            try {
              const json = JSON.parse(raw);
              const best = json?.NBest?.[0];
              if (best?.Display) {
                segmentText = best.Display;
              }
              const conf = best?.Confidence ?? json?.Confidence ?? 0;
              if (conf > bestConfidence) bestConfidence = conf;
            } catch {
              // ignore parse errors
            }
          }
          segments.push(segmentText);
        }
      };

      // Safety timeout — force stop after max duration + buffer
      const timeout = setTimeout(finish, durationMs + 2000);

      recognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.Error) {
          errorOnCancel = event.errorDetails ?? "unknown cancellation error";
          console.error(
            `[stt] continuous recognition canceled: ${errorOnCancel}`,
          );
        }
        clearTimeout(timeout);
        finish();
      };

      recognizer.sessionStopped = () => {
        clearTimeout(timeout);
        finish();
      };

      // Push all audio then close the stream.
      // Node Buffer may be backed by a shared ArrayBuffer pool. .buffer returns
      // the entire pool, so we must .slice() to extract only this Buffer's region.
      pushStream.write(pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength) as ArrayBuffer);
      pushStream.close();

      recognizer.startContinuousRecognitionAsync(
        () => {
          // started successfully
        },
        (error) => {
          clearTimeout(timeout);
          cleanup();
          const errMsg = typeof error === "string" ? error : String(error);
          console.error(`[stt] startContinuous error: ${errMsg}`);
          recognizer.close();
          reject(new Error(errMsg));
        },
      );
    });
  }

  private createAudioPipeline(): {
    pushStream: sdk.PushAudioInputStream;
    audioConfig: sdk.AudioConfig;
  } {
    const format = sdk.AudioStreamFormat.getWaveFormatPCM(
      SAMPLE_RATE,
      16,
      1,
    );
    const pushStream = sdk.AudioInputStream.createPushStream(format);
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    return { pushStream, audioConfig };
  }

  private parseResult(
    result: sdk.SpeechRecognitionResult,
  ): TranscriptionResult | null {
    if (
      result.reason !== sdk.ResultReason.RecognizedSpeech ||
      !result.text
    ) {
      console.error(
        `[stt] parseResult: reason=${sdk.ResultReason[result.reason]}, ` +
          `text="${result.text ?? ''}", errorDetails="${result.errorDetails ?? ''}"`,
      );
      return null;
    }

    let confidence = 0;
    const durationMs = result.duration / 10000; // SDK returns ticks (100ns units)
    const raw = result.properties?.getProperty(
      sdk.PropertyId.SpeechServiceResponse_JsonResult,
    );
    if (raw) {
      try {
        // Detailed format: { NBest: [{ Confidence, Lexical, ITN, MaskedITN, Display }] }
        // Use the Display text (proper casing/punctuation) instead of result.text
        const json = JSON.parse(raw);
        if (json?.NBest?.[0]) {
          const best = json.NBest[0];
          confidence = best.Confidence ?? 0;
          // Use Display text if available (better formatting than raw result.text)
          if (best.Display) {
            return {
              text: best.Display,
              language: this.language,
              durationMs,
              confidence,
            };
          }
        }
      } catch {
        // ignore parse errors, fall through to result.text
      }
    }

    return {
      text: result.text,
      language: this.language,
      durationMs,
      confidence,
    };
  }

  private logUsage(secondsJustSent: number, final = false): void {
    const label = final ? "FINAL" : "update";
    console.error(
      `[stt] usage ${label}: ` +
        `${this.stats.totalSeconds.toFixed(1)}s total, ` +
        `$${this.stats.estimatedCostUSD.toFixed(4)} est. cost, ` +
        `${this.stats.transcriptions} transcriptions` +
        (secondsJustSent > 0
          ? ` (+${secondsJustSent.toFixed(1)}s)`
          : ""),
    );
  }
}
