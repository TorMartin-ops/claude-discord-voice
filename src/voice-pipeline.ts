/**
 * Voice pipeline orchestrator: Discord audio receive -> STT -> notification -> TTS -> playback.
 *
 * This module wires together audio-utils (VAD + downsampling), stt (Azure Speech),
 * and tts (Edge TTS) into a per-user streaming pipeline attached to a Discord voice
 * channel. It does NOT call the Claude API directly -- transcribed speech is delivered
 * via a callback, and responses are played back via `playResponse()`.
 *
 * Cost-saving measures:
 *   - Per-user SpeechBuffer with client-side VAD + adaptive noise floor
 *   - Bot audio is ignored (prevents transcribing our own TTS output)
 *   - Direct WebM Opus playback (no ffmpeg transcoding — eliminates ~200-500ms latency)
 *   - 500ms cooldown after TTS playback + audio pause during playback
 *   - Per-user rate limit: max 10 STT requests/minute (prevents music/noise floods)
 *   - Global concurrent STT cap: max 2 simultaneous transcriptions (queues extras)
 *   - Daily cost cap in SpeechToText ($1/day default, auto-resets at midnight)
 *   - Inactivity timeout auto-disconnects after 10 minutes of silence
 *   - Periodic STT usage logging
 *   - Barge-in: user speech interrupts TTS playback for natural conversation flow
 *   - Latest-wins: new transcription replaces stale pending ones during TTS playback
 *   - Utterance accumulation: 1500ms timer merges fragmented speech across VAD pauses
 *   - Streaming TTS: sentence-by-sentence playback via synthesizeChunked() for long texts
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import {
  Client,
  type VoiceChannel,
  type StageChannel,
  type GuildMember,
} from "discord.js";
import { Readable } from "stream";
import { appendFile } from "fs";
import { createOpusDecoder, createDownsampler, SpeechBuffer, calculateRMS } from "./audio-utils.js";
import { SpeechToText } from "./stt.js";
import { TextToSpeech } from "./tts.js";

const DEBUG_LOG = "/tmp/discord-voice-debug.log";
function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFile(DEBUG_LOG, line, () => {}); // async — never block the audio pipeline
  process.stderr.write(`discord-voice-debug: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_VOICE = "en-US-JennyNeural";
// DEFAULT_SILENCE_THRESHOLD removed — Silero VAD handles speech detection
const DEFAULT_INACTIVITY_TIMEOUT_MS = 600_000; // 10 minutes
const TTS_COOLDOWN_MS = 200; // echo guard — slightly longer to avoid echo artifacts
const USAGE_LOG_INTERVAL_MS = 60_000; // log STT usage every minute
const STT_TIMEOUT_MS = 8_000; // timeout for Azure STT calls — F0 tier: 3-8s typical, fail fast on hangs

// Barge-in: RMS threshold for detecting real speech during TTS playback.
// Must be above typical silence/noise (~200-500 RMS) and TTS echo (~500-800 RMS).
// Reduced from 1500 to 1000 — normal speech volume should trigger interrupt.
const BARGE_IN_RMS_THRESHOLD = 1000;
// Short cooldown after barge-in interruption (ms) — just enough to avoid echo artifacts
const BARGE_IN_COOLDOWN_MS = 100;
// Grace period after TTS starts playing — ignore barge-in for this duration
// Reduced from 1500ms — users need to interrupt short responses
const BARGE_IN_GRACE_MS = 600;

// Utterance accumulation: wait this long after the last VAD chunk before sending to STT.
// Captures multi-part speech across VAD pauses as a single utterance.
// Reduced from 400ms — logs show 99% of utterances have 1 chunk, so the wait is wasted.
// Silero VAD handles pause-tolerance within the SpeechBuffer.
const UTTERANCE_ACCUMULATE_MS = 150;

// Streaming TTS: texts longer than this threshold use sentence-by-sentence synthesis.
// Shorter texts use single-shot synthesis for lower latency.
const STREAMING_TTS_CHAR_THRESHOLD = 2000; // raised from 150 — Edge TTS handles long text natively with correct punctuation pauses; sentence splitting causes audible gaps between chunks

// Cost safeguard constants
const MAX_STT_REQUESTS_PER_MINUTE_PER_USER = 10;
const MAX_CONCURRENT_STT = 1; // F0 free tier allows only 1 concurrent request
const MAX_STT_QUEUE_SIZE = 5;

/**
 * A 20ms silent Opus frame (mono, 48kHz).
 * Discord requires the bot to transmit audio before it will forward
 * incoming audio from other users. We play this immediately on join.
 */
const SILENT_OPUS_FRAME = Buffer.from([
  0xf8, 0xff, 0xfe,
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoicePipelineConfig {
  azureSttKey: string;
  azureSttRegion: string;
  sttLanguage?: string;
  ttsVoice?: string;
  inactivityTimeoutMs?: number;
}

export type TranscriptionCallback = (
  userId: string,
  username: string,
  text: string,
  channelId: string,
) => void;

interface UserPipeline {
  speechBuffer: SpeechBuffer;
  decoder: ReturnType<typeof createOpusDecoder>;
  downsampler: ReturnType<typeof createDownsampler>;
  audioStream: Readable | null;
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// VoicePipeline
// ---------------------------------------------------------------------------

export class VoicePipeline {
  private readonly client: Client;
  private readonly config: VoicePipelineConfig;

  // Core audio services
  private readonly stt: SpeechToText;
  private readonly tts: TextToSpeech;
  private readonly player: AudioPlayer;

  // Connection state
  private connection: VoiceConnection | null = null;
  private channelId: string | null = null;
  private guildId: string | null = null;

  // Per-user pipelines keyed by Discord user ID
  private readonly users = new Map<string, UserPipeline>();

  // TTS playback queue (avoid overlapping audio)
  private readonly ttsQueue: string[] = [];
  private isPlaying = false;
  private ttsCooldownUntil = 0;

  // Settings
  private language: string;
  private voice: string;
  // silenceThreshold removed — Silero VAD handles speech detection
  private muted = false;

  // Inactivity
  private readonly inactivityTimeoutMs: number;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private lastGlobalActivity = Date.now();

  // Usage logging
  private usageLogTimer: ReturnType<typeof setInterval> | null = null;

  // Callback
  private transcriptionCb: TranscriptionCallback | null = null;

  // Lifecycle
  private destroyed = false;

  // Per-user rate limiting: userId -> array of timestamps (epoch ms)
  private readonly userSttTimestamps = new Map<string, number[]>();

  // Global concurrent STT limiting
  private activeSttCount = 0;
  private readonly sttQueue: Array<{
    userId: string;
    pcmBuffer: Buffer;
    resolve: () => void;
  }> = [];

  // TTS playback state for anti-echo: true while TTS audio is playing
  private ttsIsPlaying = false;
  // Pause flag: when true, incoming audio is buffered but not sent to STT
  private audioPaused = false;

  // Latest-wins transcription delivery: when TTS is playing and a new transcription
  // arrives, store it here. Only the most recent one matters — older ones are stale.
  private latestPendingTranscription: {
    userId: string;
    username: string;
    text: string;
    channelId: string;
  } | null = null;

  // Utterance accumulation: collect PCM chunks across VAD pauses so that
  // multi-part speech ("Kan du... gå på... issues?") is sent as one STT request.
  private pendingUtteranceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUtteranceUserId: string | null = null;
  private pendingUtteranceChunks: Buffer[] = [];

  // Set to true when interruptTts() is called, checked by streaming TTS loop
  private ttsInterrupted = false;
  // True during streaming TTS — prevents global Idle handler from interfering
  private isStreamingTts = false;
  // Timestamp when TTS playback started — used for barge-in grace period
  private ttsPlaybackStartedAt = 0;

  constructor(client: Client, config: VoicePipelineConfig) {
    this.client = client;
    this.config = config;
    this.language = config.sttLanguage ?? DEFAULT_LANGUAGE;
    this.voice = config.ttsVoice ?? DEFAULT_VOICE;
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;

    this.stt = new SpeechToText({
      subscriptionKey: config.azureSttKey,
      region: config.azureSttRegion,
      language: this.language,
    });

    this.tts = new TextToSpeech({ voice: this.voice });
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    // When the player finishes or errors, advance the TTS queue.
    // Skip reset during streaming TTS — the streaming loop manages its own state.
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.isStreamingTts) return; // streaming loop handles its own lifecycle
      this.ttsIsPlaying = false;
      this.audioPaused = false;
      this.ttsCooldownUntil = Date.now() + TTS_COOLDOWN_MS;
      this.isPlaying = false;
      this.drainTtsQueue();
    });

    this.player.on("error", (err) => {
      console.error(`[voice-pipeline] audio player error: ${err.message}`);
      if (this.isStreamingTts) return; // streaming loop handles errors
      this.ttsIsPlaying = false;
      this.audioPaused = false;
      this.ttsCooldownUntil = Date.now() + TTS_COOLDOWN_MS;
      this.isPlaying = false;
      this.drainTtsQueue();
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Register a callback to receive transcribed speech. */
  onTranscription(cb: TranscriptionCallback): void {
    this.transcriptionCb = cb;
  }

  /** Join a Discord voice or stage channel. */
  async join(channel: VoiceChannel | StageChannel): Promise<void> {
    if (this.destroyed) throw new Error("Pipeline has been destroyed");

    // Clean up any existing connection
    if (this.connection) {
      this.leave();
    }

    this.channelId = channel.id;
    this.guildId = channel.guild.id;

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must not be deaf to receive audio
      selfMute: false,
      debug: process.env.VOICE_DEBUG === '1',
    });

    // Wait for the connection to be ready
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.connection.destroy();
      this.connection = null;
      this.channelId = null;
      this.guildId = null;
      throw new Error("Failed to join voice channel within 20 seconds");
    }

    // Subscribe the audio player to the connection
    this.connection.subscribe(this.player);

    // Play silence so Discord starts forwarding audio to us
    this.playSilence();

    // Listen for users speaking
    const receiver = this.connection.receiver;

    // Track consecutive SPEAKING_START events for barge-in debounce
    let bargeInSpeakCount = 0;
    let bargeInResetTimer: ReturnType<typeof setTimeout> | null = null;

    receiver.speaking.on("start", (userId: string) => {
      if (this.destroyed || this.muted) return;

      // Barge-in via SPEAKING_START debounce: require 5 events within 2s during TTS
      // AND respect grace period — don't interrupt during first 1.5s of playback
      if (this.ttsIsPlaying) {
        const sincePlaybackStart = Date.now() - this.ttsPlaybackStartedAt;
        if (sincePlaybackStart < BARGE_IN_GRACE_MS) {
          // Grace period — let the user hear the response before accepting interrupts
          return;
        }

        bargeInSpeakCount++;
        if (bargeInResetTimer) clearTimeout(bargeInResetTimer);
        bargeInResetTimer = setTimeout(() => { bargeInSpeakCount = 0; }, 2000);

        if (bargeInSpeakCount >= 5) {
          debugLog(`BARGE_IN_SPEAKING: ${bargeInSpeakCount} events in 2s, interrupting TTS`);
          bargeInSpeakCount = 0;
          this.interruptTts();
        }
      }

      this.subscribeToUser(userId).catch((err) => {
        console.error(
          `[voice-pipeline] error subscribing to user ${userId}: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      });
    });

    // Handle disconnections — re-subscribe player after reconnect
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed || !this.connection) return;

      try {
        // Try to reconnect
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Wait for Ready state after reconnection
        await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
        // Re-subscribe player and play silence to resume audio flow
        this.connection.subscribe(this.player);
        this.playSilence();
        debugLog("RECONNECTED: player re-subscribed after disconnect");
      } catch {
        // Could not reconnect -- clean up
        console.error("[voice-pipeline] disconnected and could not reconnect");
        this.leave();
      }
    });

    // Handle DAVE E2EE errors gracefully
    this.connection.on("error" as any, (err: Error) => {
      if (err.message?.includes("DAVE") || err.message?.includes("E2EE") || err.message?.includes("encryption")) {
        console.warn(
          "[voice-pipeline] DAVE E2EE error detected. Audio receive may not work " +
            "in servers with end-to-end encryption enabled. Consider using a Stage " +
            "Channel instead, which does not enforce DAVE.",
        );
      } else {
        console.error(`[voice-pipeline] connection error: ${err.message}`);
      }
    });

    // Start inactivity timer and usage logging
    this.resetInactivityTimer();
    this.startUsageLogging();

    console.error(
      `[voice-pipeline] joined channel ${channel.name} (${channel.id}) ` +
        `in guild ${channel.guild.name}`,
    );
  }

  /** Leave the current voice channel and clean up all user pipelines. */
  leave(): void {
    this.stopUsageLogging();
    this.clearInactivityTimer();

    // Tear down all user pipelines
    for (const [userId, pipeline] of this.users) {
      this.teardownUserPipeline(userId, pipeline);
    }
    this.users.clear();

    // Stop any playing audio
    this.player.stop(true);
    this.ttsQueue.length = 0;
    this.isPlaying = false;
    this.ttsInterrupted = true;

    // Clear pending utterance accumulation
    if (this.pendingUtteranceTimer !== null) {
      clearTimeout(this.pendingUtteranceTimer);
      this.pendingUtteranceTimer = null;
    }
    this.pendingUtteranceUserId = null;
    this.pendingUtteranceChunks = [];

    // Clear pending transcription
    this.latestPendingTranscription = null;

    // Destroy the voice connection
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        // Already destroyed
      }
      this.connection = null;
    }

    const prevChannel = this.channelId;
    this.channelId = null;
    this.guildId = null;

    if (prevChannel) {
      console.error(`[voice-pipeline] left channel ${prevChannel}`);
    }
  }

  /**
   * Play a TTS response through the voice channel.
   * Called by the MCP server when Claude produces a text response.
   * Queues if another response is already playing.
   */
  async playResponse(text: string): Promise<void> {
    if (this.destroyed || !this.connection || this.muted) {
      debugLog(`PLAY_RESPONSE_SKIPPED: destroyed=${this.destroyed} connection=${!!this.connection} muted=${this.muted} text="${text.slice(0, 50)}..."`);
      return;
    }

    // Latest-wins: clear stale queue and interrupt current playback
    if (this.ttsQueue.length > 0 || this.ttsIsPlaying) {
      debugLog(`TTS_LATEST_WINS: clearing ${this.ttsQueue.length} queued + interrupting current`);
      this.interruptTts();
    }
    this.ttsQueue.push(text);
    this.drainTtsQueue();
  }

  /** Current pipeline status. */
  get status(): {
    connected: boolean;
    channelId: string | null;
    activeUsers: string[];
    sttUsage: {
      totalSeconds: number;
      estimatedCostUSD: number;
      dailyBudgetUSD: number;
      dailyBudgetRemainingUSD: number;
      dailyBudgetResetAt: string;
      budgetExhausted: boolean;
    };
    ttsCache: { hits: number; misses: number };
  } {
    const sttUsage = this.stt.usage;
    const ttsCache = this.tts.cacheStats;
    return {
      connected: this.connection !== null,
      channelId: this.channelId,
      activeUsers: Array.from(this.users.keys()),
      sttUsage: {
        totalSeconds: sttUsage.totalSeconds,
        estimatedCostUSD: sttUsage.estimatedCostUSD,
        dailyBudgetUSD: sttUsage.dailyBudgetUSD,
        dailyBudgetRemainingUSD: sttUsage.dailyBudgetRemainingUSD,
        dailyBudgetResetAt: sttUsage.dailyBudgetResetAt,
        budgetExhausted: sttUsage.budgetExhausted,
      },
      ttsCache: {
        hits: ttsCache.hits,
        misses: ttsCache.misses,
      },
    };
  }

  /** Change STT language at runtime. */
  setLanguage(lang: string): void {
    this.language = lang;
    // STT instances are per-utterance, so the next transcription will use the new language.
    // We need to recreate the STT to change language though -- SpeechConfig is immutable.
    // For simplicity, we accept the existing SpeechToText will continue with its original
    // language. A full reconnect is needed for language changes to take effect on STT.
    console.error(`[voice-pipeline] language set to ${lang} (reconnect for STT change)`);
  }

  /** Change TTS voice at runtime. */
  setVoice(voice: string): void {
    this.voice = voice;
    this.tts.setVoice(voice);
    console.error(`[voice-pipeline] voice set to ${voice}`);
  }

  /** Mute/unmute the pipeline. When muted, ignores incoming audio and TTS playback. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      // Flush all user buffers
      for (const [, pipeline] of this.users) {
        pipeline.speechBuffer.flush();
      }
    }
    console.error(`[voice-pipeline] muted: ${muted}`);
  }

  /** Whether destroy() has been called. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Externally interrupt TTS playback (e.g. from server.ts).
   * Returns true if TTS was playing and was interrupted, false otherwise.
   */
  interrupt(): boolean {
    if (!this.ttsIsPlaying) return false;
    this.interruptTts();
    return true;
  }

  /** Tear down everything. Cannot be reused after calling this. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.leave();
    this.sttQueue.length = 0; // prevent queued STT from running on disposed instance
    this.tts.close();
    this.stt.dispose();
    this.transcriptionCb = null;

    console.error("[voice-pipeline] destroyed");
  }

  // -------------------------------------------------------------------------
  // Barge-in / TTS interruption
  // -------------------------------------------------------------------------

  /**
   * Immediately stop TTS playback and resume listening.
   * Called when a user speaks during TTS output (barge-in).
   */
  private interruptTts(): void {
    debugLog("INTERRUPT_TTS: stopping playback, clearing queue, aborting synthesis");
    this.player.stop(true);
    this.ttsQueue.length = 0;
    this.isPlaying = false;
    this.ttsIsPlaying = false;
    this.ttsInterrupted = true;
    this.isStreamingTts = false; // prevent stale streaming finally from re-draining
    this.audioPaused = false;
    this.ttsCooldownUntil = Date.now() + BARGE_IN_COOLDOWN_MS;
    // Abort any in-progress TTS synthesis (cancels pending WebSocket requests)
    this.tts.abort();
    // Flush any pending utterance accumulation to avoid mixing stale audio with new barge-in speech
    if (this.pendingUtteranceTimer !== null) {
      clearTimeout(this.pendingUtteranceTimer);
      this.pendingUtteranceTimer = null;
    }
    this.pendingUtteranceUserId = null;
    this.pendingUtteranceChunks = [];
  }

  // -------------------------------------------------------------------------
  // User audio subscription
  // -------------------------------------------------------------------------

  private async subscribeToUser(userId: string): Promise<void> {
    // Don't subscribe to bot users
    const member = this.resolveGuildMember(userId);
    if (member?.user?.bot) return;

    // If we already have a pipeline for this user, skip
    if (this.users.has(userId)) return;

    const receiver = this.connection?.receiver;
    if (!receiver) return;

    // Try to subscribe to the user's audio
    let audioStream: Readable;
    try {
      audioStream = receiver.subscribe(userId, {
        end: { behavior: "afterSilence" as any, duration: 500 },
      }) as unknown as Readable;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // DAVE E2EE may cause this to fail
      if (msg.includes("DAVE") || msg.includes("E2EE") || msg.includes("encryption") || msg.includes("decrypt")) {
        console.warn(
          `[voice-pipeline] cannot receive audio from user ${userId} -- ` +
            "likely DAVE E2EE. Try using a Stage Channel.",
        );
      } else {
        console.error(`[voice-pipeline] failed to subscribe to user ${userId}: ${msg}`);
      }
      return;
    }

    const decoder = createOpusDecoder();
    const downsampler = createDownsampler();
    const speechBuffer = await SpeechBuffer.create();

    const pipeline: UserPipeline = {
      speechBuffer,
      decoder,
      downsampler,
      audioStream,
      lastActivity: Date.now(),
    };

    this.users.set(userId, pipeline);

    // IMPORTANT: register error handlers BEFORE pipe() to avoid uncaught
    // errors if a stream emits synchronously during pipe setup.
    const teardownOnError = (source: string) => (err: Error) => {
      console.error(`[voice-pipeline] ${source} error for user ${userId}: ${err.message}`);
      this.teardownUserPipeline(userId, pipeline);
      this.users.delete(userId);
    };

    audioStream.on("error", teardownOnError("audio stream"));
    decoder.on("error", teardownOnError("decoder"));
    downsampler.on("error", teardownOnError("downsampler"));

    // Wire: audioStream -> opusDecoder -> downsampler -> speechBuffer -> STT
    audioStream.pipe(decoder).pipe(downsampler);

    // Promise chain ensures audio chunks are processed in order despite async VAD.
    // ONNX inference is <1ms, chunks arrive every ~20ms, so we never fall behind.
    let processChain = Promise.resolve();
    let chunkCount = 0;
    downsampler.on("data", (chunk: Buffer) => {
      processChain = processChain.then(async () => {
        try {
          chunkCount++;
          if (this.destroyed || this.muted) return;

          // During TTS playback, check if incoming audio has significant energy
          // (barge-in detection). Respect grace period to avoid interrupting before user hears anything.
          if (this.ttsIsPlaying) {
            const sincePlaybackStart = Date.now() - this.ttsPlaybackStartedAt;
            if (sincePlaybackStart < BARGE_IN_GRACE_MS) {
              // Grace period — silently drop audio, let TTS play
              return;
            }
            const rms = calculateRMS(chunk);
            if (rms >= BARGE_IN_RMS_THRESHOLD) {
              debugLog(`BARGE_IN_AUDIO: user=${userId} RMS=${rms.toFixed(0)} >= ${BARGE_IN_RMS_THRESHOLD}, interrupting TTS`);
              this.interruptTts();
              // Feed the triggering chunk directly — don't let cooldown drop it
              const utterance = await speechBuffer.feed(chunk);
              if (utterance) {
                pipeline.lastActivity = Date.now();
                this.lastGlobalActivity = Date.now();
                this.resetInactivityTimer();
                this.handleUtterance(userId, utterance);
              }
              return; // Skip the normal flow which would hit the cooldown gate
            } else {
              // Low energy during TTS — ignore (probably echo)
              return;
            }
          }

          // During cooldown or pause (but not TTS playing — handled above), skip audio
          if (this.audioPaused || Date.now() < this.ttsCooldownUntil) {
            return;
          }

          const utterance = await speechBuffer.feed(chunk);
          if (utterance) {
            debugLog(`UTTERANCE_DETECTED: ${utterance.length} bytes (${(utterance.length / 32000 * 1000).toFixed(0)}ms), user=${userId}`);
            pipeline.lastActivity = Date.now();
            this.lastGlobalActivity = Date.now();
            this.resetInactivityTimer();
            this.handleUtterance(userId, utterance);
          }
        } catch (err) {
          console.error(
            `[voice-pipeline] data handler error for user ${userId}: ` +
              `${err instanceof Error ? err.message : err}`,
          );
          // Tear down this user's pipeline to avoid repeating the error
          this.teardownUserPipeline(userId, pipeline);
          this.users.delete(userId);
        }
      });
    });

    // When the audio stream ends, clean up
    audioStream.on("end", () => {
      try {
        // Flush any remaining speech from the VAD buffer
        const remaining = speechBuffer.flush();
        if (remaining) {
          this.handleUtterance(userId, remaining);
        }

        // If this user has pending accumulated utterance chunks, flush them now
        if (this.pendingUtteranceUserId === userId) {
          this.flushPendingUtterance();
        }
      } catch (err) {
        console.error(
          `[voice-pipeline] end handler error for user ${userId}: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }

      this.teardownUserPipeline(userId, pipeline);
      this.users.delete(userId);
    });

    const username = member?.displayName ?? member?.user?.username ?? userId;
    console.error(`[voice-pipeline] subscribed to user ${username} (${userId})`);
  }

  private teardownUserPipeline(userId: string, pipeline: UserPipeline): void {
    try {
      pipeline.audioStream?.destroy();
      pipeline.decoder.destroy();
      pipeline.downsampler.destroy();
    } catch {
      // Streams may already be closed
    }

    // Clean up rate limit timestamps to prevent memory leak when users leave
    this.userSttTimestamps.delete(userId);
  }

  private resolveGuildMember(userId: string): GuildMember | undefined {
    if (!this.guildId) return undefined;
    const guild = this.client.guilds.cache.get(this.guildId);
    return guild?.members.cache.get(userId);
  }

  // -------------------------------------------------------------------------
  // Speech handling
  // -------------------------------------------------------------------------

  /**
   * Handle a VAD utterance. Instead of sending to STT immediately, accumulate
   * PCM chunks across short pauses so that multi-part speech like
   * "Kan du... gå på... issues?" is captured as one utterance.
   *
   * If a DIFFERENT user speaks while we are accumulating, the pending user's
   * buffer is flushed immediately so their partial speech is not lost.
   */
  private handleUtterance(userId: string, pcmBuffer: Buffer): void {
    // Different user speaking? Flush the pending user's accumulated buffer first.
    if (
      this.pendingUtteranceUserId !== null &&
      this.pendingUtteranceUserId !== userId &&
      this.pendingUtteranceChunks.length > 0
    ) {
      debugLog(`UTTERANCE_FLUSH: different user ${userId} interrupted pending user ${this.pendingUtteranceUserId}`);
      this.flushPendingUtterance();
    }

    // Accumulate this chunk
    this.pendingUtteranceUserId = userId;
    this.pendingUtteranceChunks.push(pcmBuffer);

    // Reset the accumulation timer
    if (this.pendingUtteranceTimer !== null) {
      clearTimeout(this.pendingUtteranceTimer);
    }

    this.pendingUtteranceTimer = setTimeout(() => {
      this.flushPendingUtterance();
    }, UTTERANCE_ACCUMULATE_MS);
  }

  /**
   * Flush accumulated PCM chunks for the pending user and send to STT.
   */
  private flushPendingUtterance(): void {
    if (this.pendingUtteranceTimer !== null) {
      clearTimeout(this.pendingUtteranceTimer);
      this.pendingUtteranceTimer = null;
    }

    const userId = this.pendingUtteranceUserId;
    const chunks = this.pendingUtteranceChunks;

    // Reset accumulation state
    this.pendingUtteranceUserId = null;
    this.pendingUtteranceChunks = [];

    if (!userId || chunks.length === 0) return;

    const combinedBuffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    debugLog(`UTTERANCE_ACCUMULATED: user=${userId}, ${chunks.length} chunk(s), ${combinedBuffer.length} bytes (${(combinedBuffer.length / 32000 * 1000).toFixed(0)}ms)`);

    this.dispatchToStt(userId, combinedBuffer);
  }

  /**
   * Send a PCM buffer to STT, respecting rate limits and concurrency caps.
   */
  private dispatchToStt(userId: string, pcmBuffer: Buffer): void {
    // Skip buffers too short for Azure STT (< 500ms = 16000 bytes at 16kHz mono 16-bit).
    // Azure returns NoMatch on sub-500ms audio, wasting an API call and latency.
    const MIN_STT_BYTES = 16000; // 500ms at 16kHz mono 16-bit
    if (pcmBuffer.length < MIN_STT_BYTES) {
      debugLog(`STT_TOO_SHORT: ${pcmBuffer.length} bytes (${(pcmBuffer.length / 32000 * 1000).toFixed(0)}ms) < 500ms minimum, skipping`);
      return;
    }

    // Per-user rate limit: max N STT requests per minute
    if (!this.checkUserRateLimit(userId)) {
      debugLog(`RATE_LIMIT: user=${userId}, dropping utterance`);
      return;
    }

    // Global concurrent STT limit: latest-wins — replace entire queue with just this utterance
    if (this.activeSttCount >= MAX_CONCURRENT_STT) {
      if (this.sttQueue.length > 0) {
        debugLog(`STT_QUEUE_REPLACE: dropping ${this.sttQueue.length} stale entries for latest utterance`);
        this.sttQueue.length = 0;
      }
      this.sttQueue.push({
        userId,
        pcmBuffer,
        resolve: () => {},
      });
      debugLog(`STT_QUEUED: latest-wins, ${this.activeSttCount} active`);
      this.drainSttQueue();
      return;
    }

    this.executeTranscription(userId, pcmBuffer);
  }

  private executeTranscription(userId: string, pcmBuffer: Buffer): void {
    const member = this.resolveGuildMember(userId);
    const username = member?.displayName ?? member?.user?.username ?? userId;
    const channelId = this.channelId ?? "unknown";

    this.activeSttCount++;

    debugLog(`STT_START: user=${username}, pcm=${pcmBuffer.length} bytes (${(pcmBuffer.length / 32000 * 1000).toFixed(0)}ms), active=${this.activeSttCount}`);

    // Wrap STT in a timeout to prevent hung Azure calls from permanently blocking
    const sttPromise = this.stt.transcribe(pcmBuffer);
    let sttTimeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<null>((_, reject) => {
      sttTimeoutId = setTimeout(() => reject(new Error(`STT timeout after ${STT_TIMEOUT_MS}ms`)), STT_TIMEOUT_MS);
    });

    Promise.race([sttPromise, timeoutPromise])
      .then((result) => {
        debugLog(`STT_RESULT: user=${username}, result=${result ? JSON.stringify({text: result.text, confidence: result.confidence, durationMs: result.durationMs, budgetExhausted: result.budgetExhausted}) : 'NULL'}`);
        if (result?.budgetExhausted) {
          console.error("[voice-pipeline] STT daily budget exhausted, stopping transcription");
          this.transcriptionCb?.(
            userId,
            "system",
            "[STT budget reached for today. Voice transcription paused until midnight.]",
            channelId,
          );
          return;
        }

        if (!result || !result.text.trim()) {
          debugLog(`STT_EMPTY: user=${username}, result was null or empty text — Azure returned NoMatch or silence`);
          return;
        }

        debugLog(`STT_SUCCESS: user=${username}, text="${result.text}", conf=${result.confidence.toFixed(2)}`);
        console.error(
          `[voice-pipeline] ${username}: "${result.text}" ` +
            `(${result.durationMs.toFixed(0)}ms, conf=${result.confidence.toFixed(2)})`,
        );

        debugLog(`CALLBACK: transcriptionCb exists=${!!this.transcriptionCb}, ttsIsPlaying=${this.ttsIsPlaying}`);

        // Latest-wins delivery: if TTS is currently playing, interrupt it and
        // replace any stale pending transcription with this new one.
        if (this.ttsIsPlaying) {
          debugLog(`LATEST_WINS: TTS playing, storing transcription and interrupting`);
          this.latestPendingTranscription = { userId, username, text: result.text, channelId };
          this.interruptTts();
          // Deliver after interrupt so the callback sees the pipeline in a clean state
          const pending = this.latestPendingTranscription;
          if (pending) {
            this.latestPendingTranscription = null;
            this.transcriptionCb?.(pending.userId, pending.username, pending.text, pending.channelId);
          }
        } else {
          // No TTS playing — deliver immediately
          this.transcriptionCb?.(userId, username, result.text, channelId);
        }
      })
      .catch((err) => {
        console.error(
          `[voice-pipeline] transcription error for ${username}: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      })
      .finally(() => {
        clearTimeout(sttTimeoutId!);
        this.activeSttCount--;
        this.drainSttQueue();
      });
  }

  private checkUserRateLimit(userId: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    let timestamps = this.userSttTimestamps.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.userSttTimestamps.set(userId, timestamps);
    }

    // Evict entries older than 1 minute
    while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
      timestamps.shift();
    }

    if (timestamps.length >= MAX_STT_REQUESTS_PER_MINUTE_PER_USER) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  private drainSttQueue(): void {
    while (this.activeSttCount < MAX_CONCURRENT_STT && this.sttQueue.length > 0) {
      const queued = this.sttQueue.shift()!;
      this.executeTranscription(queued.userId, queued.pcmBuffer);
    }
  }

  // -------------------------------------------------------------------------
  // TTS playback
  // -------------------------------------------------------------------------

  private drainTtsQueue(): void {
    if (this.isPlaying || this.ttsQueue.length === 0) return;
    if (this.destroyed || !this.connection) {
      debugLog(`DRAIN_TTS_SKIPPED: destroyed=${this.destroyed} connection=${!!this.connection}, clearing ${this.ttsQueue.length} queued`);
      this.ttsQueue.length = 0;
      return;
    }

    const text = this.ttsQueue.shift()!;
    this.isPlaying = true;

    // Wrap in async IIFE to catch both sync throws and async rejections
    (async () => {
      await this.synthesizeAndPlay(text);
    })().catch((err) => {
      console.error(
        `[voice-pipeline] TTS playback error: ${err instanceof Error ? err.message : err}`,
      );
      this.ttsIsPlaying = false;
      this.audioPaused = false;
      this.ttsCooldownUntil = Date.now() + TTS_COOLDOWN_MS;
      this.isPlaying = false;
      this.drainTtsQueue();
    });
  }

  private async synthesizeAndPlay(text: string): Promise<void> {
    debugLog(`TTS_SYNTHESIZE_START: ${text.length} chars, "${text.slice(0, 60)}..."`);

    // Reset interrupt flag before starting
    this.ttsInterrupted = false;

    // Pause audio processing during playback to prevent echo
    // but keep pipelines alive to preserve calibrated noise floor
    this.ttsIsPlaying = true;
    this.audioPaused = true;
    this.ttsPlaybackStartedAt = Date.now();

    // For short texts, use single-shot synthesis for lower latency.
    // For longer texts, use sentence-by-sentence streaming so the bot
    // starts talking sooner and can be interrupted between sentences.
    if (text.length <= STREAMING_TTS_CHAR_THRESHOLD) {
      try {
        await this.synthesizeAndPlaySingleShot(text);
      } finally {
        // Single-shot has no finally of its own — ensure flags always reset
        // even if synthesis throws, playback is interrupted, or early-exit hits.
        // The streaming path has its own finally block at synthesizeAndPlayStreaming().
        this.ttsIsPlaying = false;
        this.audioPaused = false;
        this.ttsCooldownUntil = Date.now() + TTS_COOLDOWN_MS;
        this.isPlaying = false;
        this.drainTtsQueue();
      }
    } else {
      await this.synthesizeAndPlayStreaming(text);
    }
  }

  /**
   * Single-shot synthesis + playback for short texts (≤ STREAMING_TTS_CHAR_THRESHOLD chars).
   * Lower latency because there is no sentence-splitting overhead.
   */
  private async synthesizeAndPlaySingleShot(text: string): Promise<void> {
    const webmBuffer = await this.tts.synthesize(text);
    debugLog(`TTS_SYNTHESIZED: ${webmBuffer.length} bytes, first4=${webmBuffer.subarray(0, 4).toString('hex')}`);

    if (this.destroyed || !this.connection || this.ttsInterrupted) return;

    await this.playAudioBuffer(webmBuffer);
    debugLog(`TTS_PLAYED: single-shot complete`);
  }

  /**
   * Streaming sentence-by-sentence synthesis + playback for longer texts.
   * Uses synthesizeChunked() to start playing the first sentence while
   * subsequent ones are still being synthesized. Checks for interruption
   * between each sentence.
   */
  private async synthesizeAndPlayStreaming(text: string): Promise<void> {
    debugLog(`TTS_STREAMING: starting chunked synthesis for ${text.length} chars`);
    this.isStreamingTts = true;

    try {
      const generator = this.tts.synthesizeChunked(text);
      let prefetched: IteratorResult<Buffer, void> | null = null;

      // Kick off the first sentence synthesis immediately
      prefetched = await generator.next();

      while (prefetched && !prefetched.done) {
        // Check if we were interrupted between sentences
        if (this.ttsInterrupted || this.destroyed || !this.connection) {
          debugLog("TTS_STREAMING: interrupted between sentences, stopping");
          return;
        }

        const currentBuffer = prefetched.value;
        prefetched = null;

        // Assert playback state before each sentence
        this.ttsIsPlaying = true;
        this.audioPaused = true;
        this.isPlaying = true;

        debugLog(`TTS_SENTENCE: playing ${currentBuffer.length} bytes`);

        // Start prefetching next sentence while current one plays
        const prefetchPromise = generator.next();
        await this.playAudioBuffer(currentBuffer);

        // Check again after playback
        if (this.ttsInterrupted || this.destroyed || !this.connection) {
          debugLog("TTS_STREAMING: interrupted after sentence playback, stopping");
          return;
        }

        // Await the prefetched next sentence (should already be ready or nearly ready)
        prefetched = await prefetchPromise;
      }
    } catch (err) {
      // "Aborted" errors are expected when interruptTts() calls tts.abort()
      if (err instanceof Error && err.message === "Aborted") {
        debugLog("TTS_STREAMING: synthesis aborted (expected after interrupt)");
        return;
      }
      throw err;
    } finally {
      this.isStreamingTts = false;
      this.ttsIsPlaying = false;
      this.audioPaused = false;
      this.ttsCooldownUntil = Date.now() + TTS_COOLDOWN_MS;
      this.isPlaying = false;
      this.drainTtsQueue();
    }
  }

  /**
   * Play a single WebM Opus audio buffer through the Discord audio player.
   * Returns a promise that resolves when the player goes idle (finished
   * playing) or encounters an error.
   */
  private async playAudioBuffer(webmBuffer: Buffer): Promise<void> {
    // Early exit if already interrupted (e.g. barge-in between synthesis and play)
    if (this.ttsInterrupted) return;

    const stream = Readable.from(webmBuffer);
    const resource = createAudioResource(stream, {
      inputType: StreamType.WebmOpus,
    });

    // Wait for it to finish (or error/timeout)
    // IMPORTANT: Register listeners BEFORE play() to avoid race condition
    // where very short audio transitions Idle→Playing→Idle before listeners attach
    await new Promise<void>((resolve) => {
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off("error", onError);
      };

      this.player.on(AudioPlayerStatus.Idle, onIdle);
      this.player.on("error", onError);

      this.player.play(resource);

      // If already idle after play (synchronous transition), resolve immediately
      if (this.player.state.status === AudioPlayerStatus.Idle) {
        cleanup();
        resolve();
        return;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Silence trick
  // -------------------------------------------------------------------------

  /**
   * Play a very short silent Opus frame.
   * Discord requires the bot to transmit audio before it will forward
   * incoming audio from other participants.
   */
  private playSilence(): void {
    try {
      // Create a stream with a few silent Opus frames
      const silenceStream = new Readable({
        read() {
          // Push several copies to ensure Discord picks it up
          for (let i = 0; i < 5; i++) {
            this.push(SILENT_OPUS_FRAME);
          }
          this.push(null);
        },
      });

      silenceStream.on("error", (err: Error) => {
        console.warn(`[voice-pipeline] silence stream error: ${err.message}`);
      });

      const resource = createAudioResource(silenceStream, {
        inputType: StreamType.Arbitrary,
      });

      this.player.play(resource);

      // Handle player error specifically during silence playback -- this is
      // non-critical so we only warn (the main player error handler will also fire)
      const onSilenceError = (err: Error) => {
        console.warn(`[voice-pipeline] player error during silence: ${err.message}`);
        this.player.off("error", onSilenceError);
      };
      this.player.once("error", onSilenceError);
    } catch (err) {
      console.warn(
        `[voice-pipeline] failed to play silence: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Inactivity timeout
  // -------------------------------------------------------------------------

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    this.lastGlobalActivity = Date.now();

    this.inactivityTimer = setTimeout(() => {
      // Safety guard: if leave() was already called (e.g. by a concurrent event),
      // channelId will be null and there is nothing to disconnect from
      if (!this.channelId) return;

      const elapsed = Date.now() - this.lastGlobalActivity;
      if (elapsed >= this.inactivityTimeoutMs) {
        console.error(
          `[voice-pipeline] no speech activity for ${Math.round(elapsed / 1000)}s, ` +
            "auto-disconnecting to save resources",
        );
        this.leave();
      }
    }, this.inactivityTimeoutMs);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Usage logging
  // -------------------------------------------------------------------------

  private startUsageLogging(): void {
    this.stopUsageLogging();
    this.usageLogTimer = setInterval(() => {
      const usage = this.stt.usage;
      if (usage.transcriptions > 0) {
        console.error(
          `[voice-pipeline] STT usage: ${usage.totalSeconds.toFixed(1)}s total, ` +
            `$${usage.estimatedCostUSD.toFixed(4)} est. cost, ` +
            `${usage.transcriptions} transcriptions | ` +
            `TTS cache: ${this.tts.cacheStats.hits} hits, ${this.tts.cacheStats.misses} misses`,
        );
      }
    }, USAGE_LOG_INTERVAL_MS);
  }

  private stopUsageLogging(): void {
    if (this.usageLogTimer) {
      clearInterval(this.usageLogTimer);
      this.usageLogTimer = null;
    }
  }
}
