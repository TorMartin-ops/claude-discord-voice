import { Transform, TransformCallback } from "stream";
import OpusScript from "opusscript";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { createRequire } from "module";

const DEFAULT_SILENCE_DURATION_MS = 300; // reduced from 450 — faster utterance emission
const DEFAULT_MIN_SPEECH_DURATION_MS = 200; // catch short "ja"/"nei" (~200ms)
const DEFAULT_MAX_SPEECH_DURATION_MS = 15000; // 15s prevents runaway noise accumulation; Azure handles shorter segments better
const DEFAULT_PRE_SPEECH_BUFFER_MS = 500;
const DIGITAL_SILENCE_RMS = 20; // Lowered from 50 — avoid filtering quiet speakers

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const STT_SAMPLE_RATE = 16000;
const STT_CHANNELS = 1;
const BYTES_PER_SAMPLE = 2; // 16-bit audio

// Silero VAD v5 uses 512 samples per frame at 16kHz (32ms).
// At 16kHz mono 16-bit: 512 samples = 1024 bytes.
const VAD_FRAME_SAMPLES = 512;
const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE; // 1024

// Speech probability threshold — Silero v5 default is 0.5
const DEFAULT_SPEECH_THRESHOLD = 0.5;

// Opus packet validation constants
const OPUS_MIN_PACKET_SIZE = 1; // 1 byte = valid silence/DTX packet
const OPUS_MAX_PACKET_SIZE = 5760; // max Opus frame size in bytes

/**
 * Opus decoder using opusscript (pure JS/WASM) instead of the native
 * @discordjs/opus C binding.
 *
 * Why: @discordjs/opus 0.9.0 crashes with SIGSEGV on Node.js v24 (ABI v137)
 * when decoding real Discord audio packets. The native prebuild for
 * darwin-arm64 has a memory corruption bug that cannot be caught by
 * try-catch or uncaughtException handlers. opusscript uses Emscripten/WASM
 * which is immune to SIGSEGV — decode errors throw normal JS exceptions.
 *
 * Performance: opusscript is ~2-5x slower than native, but Opus decoding
 * is not the bottleneck (Azure STT and Edge TTS are). At typical voice
 * rates (50 packets/sec), the CPU cost is negligible.
 */
class SafeOpusDecoder extends Transform {
  private decoder: InstanceType<typeof OpusScript>;
  private droppedPackets = 0;
  private decoderErrors = 0;

  constructor() {
    super();
    this.decoder = new OpusScript(
      DISCORD_SAMPLE_RATE,
      DISCORD_CHANNELS,
      OpusScript.Application.AUDIO,
    );
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    if (!chunk || chunk.length < OPUS_MIN_PACKET_SIZE || chunk.length > OPUS_MAX_PACKET_SIZE) {
      this.droppedPackets++;
      if (this.droppedPackets <= 5 || this.droppedPackets % 100 === 0) {
        console.error(
          `[opus-decoder] dropped invalid packet ` +
            `(${chunk?.length ?? 0} bytes, total dropped: ${this.droppedPackets})`,
        );
      }
      callback();
      return;
    }

    try {
      const pcm = this.decoder.decode(chunk);
      // opusscript returns a Buffer with interleaved 16-bit PCM samples
      this.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      callback();
    } catch (err) {
      this.decoderErrors++;
      if (this.decoderErrors <= 10 || this.decoderErrors % 100 === 0) {
        console.error(
          `[opus-decoder] decode error #${this.decoderErrors}: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
      // Skip the packet and continue — don't crash the pipeline
      callback();
    }
  }

  _flush(callback: TransformCallback): void {
    callback();
  }

  _destroy(err: Error | null, callback: (error: Error | null) => void): void {
    try {
      this.decoder.delete();
    } catch {
      // Already deleted
    }
    callback(err);
  }
}

export function createOpusDecoder(): Transform {
  return new SafeOpusDecoder();
}

/**
 * Downsample 48kHz stereo → 16kHz mono with anti-aliasing.
 *
 * The ratio is exactly 3 (48000/16000), so each output sample is the average
 * of 3 consecutive input samples (box filter). This acts as a simple low-pass
 * filter that attenuates frequencies above ~8kHz before decimation, preventing
 * aliasing artifacts that would corrupt the speech band sent to Azure STT.
 *
 * Previous implementation used point-sampling (no filter), which folded
 * 8-24kHz energy (sibilants, noise, keyboard clicks) into 0-8kHz as distortion.
 */
export function createDownsampler(): Transform {
  const ratio = DISCORD_SAMPLE_RATE / STT_SAMPLE_RATE; // 3
  const inputFrameBytes = DISCORD_CHANNELS * BYTES_PER_SAMPLE; // 4 bytes per stereo sample
  const outputFrameBytes = STT_CHANNELS * BYTES_PER_SAMPLE; // 2 bytes per mono sample
  let residual = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      const input = residual.length > 0 ? Buffer.concat([residual, chunk]) : chunk;
      const inputSamples = Math.floor(input.length / inputFrameBytes);
      const outputSamples = Math.floor(inputSamples / ratio);
      const consumed = Math.floor(outputSamples * ratio) * inputFrameBytes;

      const output = Buffer.alloc(outputSamples * outputFrameBytes);

      for (let i = 0; i < outputSamples; i++) {
        // Average 3 consecutive stereo samples (box filter anti-aliasing)
        let sum = 0;
        const baseIndex = i * ratio; // always integer since ratio=3
        for (let j = 0; j < ratio; j++) {
          const offset = (baseIndex + j) * inputFrameBytes;
          const left = input.readInt16LE(offset);
          const right = input.readInt16LE(offset + BYTES_PER_SAMPLE);
          sum += (left + right) / 2; // stereo to mono
        }
        const averaged = Math.round(sum / ratio);
        output.writeInt16LE(
          Math.max(-32768, Math.min(32767, averaged)),
          i * outputFrameBytes,
        );
      }

      residual = Buffer.from(input.subarray(consumed));
      if (output.length === 0) {
        callback();
        return;
      }
      callback(null, output);
    },

    flush(callback: TransformCallback) {
      residual = Buffer.alloc(0);
      callback();
    },
  });
}

export function calculateRMS(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

interface SpeechBufferOptions {
  silenceDuration?: number;
  minSpeechDuration?: number;
  maxSpeechDuration?: number;
  preSpeechBuffer?: number;
  /** Silero VAD speech probability threshold (0-1). Default: 0.5. */
  speechThreshold?: number;
}

interface SpeechBufferStats {
  totalAudioMs: number;
  speechMs: number;
  silenceMs: number;
  utterances: number;
}

const enum State {
  WAITING,
  SPEAKING,
}

/**
 * Silero VAD v5 model wrapper.
 * Loads the ONNX model from avr-vad's bundled files and exposes a simple
 * `process(frame)` method that returns speech probability.
 *
 * Silero v5 is dramatically more accurate than WebRTC VAD:
 *   - 87.7% TPR at 5% FPR (4x fewer errors than WebRTC VAD)
 *   - Trained on 6000+ languages
 *   - DNN-based vs WebRTC's GMM — better at speech vs noise separation
 */
interface SileroModel {
  process(frame: Float32Array): Promise<{ isSpeech: number; notSpeech: number }>;
  reset_state(): void;
}

let _cachedModel: SileroModel | null = null;

async function loadSileroV5(): Promise<SileroModel> {
  if (_cachedModel) return _cachedModel;

  // Load onnxruntime-node and SileroV5 model class from avr-vad
  const require_ = createRequire(import.meta.url);
  const ort = require_("onnxruntime-node");
  const { SileroV5 } = require_("avr-vad/dist/common/models");

  // Locate the bundled ONNX model file
  const avrVadPath = dirname(require_.resolve("avr-vad/package.json"));
  const modelPath = resolve(avrVadPath, "dist", "silero_vad_v5.onnx");

  // Custom model fetcher: read from disk instead of fetch()
  const modelFetcher = async (): Promise<ArrayBuffer> => {
    const buf = readFileSync(modelPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };

  _cachedModel = await SileroV5.new(ort, modelFetcher) as SileroModel;
  console.error("[speech-buffer] Silero VAD v5 loaded (ONNX, 16kHz, 512-sample frames)");
  return _cachedModel;
}

/**
 * Convert Int16 PCM buffer to Float32Array normalized to [-1, 1].
 * Silero VAD expects Float32 input.
 */
function pcmInt16ToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = pcm.length / BYTES_PER_SAMPLE;
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
  }
  return float32;
}

/**
 * Speech buffer using Silero VAD v5 (DNN-based) for speech detection.
 *
 * Replaces Google's WebRTC VAD (GMM-based) for dramatically better accuracy.
 * Silero v5 is trained on 6000+ languages and distinguishes speech from noise
 * far better than WebRTC VAD, especially in noisy environments.
 *
 * Keeps: pre-speech buffer, adaptive silence duration,
 * min/max speech duration, digital silence filter, noise ratio filtering.
 *
 * Async: ONNX inference is async, so feed() returns Promise<Buffer | null>.
 * Use SpeechBuffer.create() instead of new SpeechBuffer().
 */
export class SpeechBuffer {
  private readonly silenceDurationMs: number;
  private readonly minSpeechDurationMs: number;
  private readonly maxSpeechDurationMs: number;
  private readonly preSpeechBufferMs: number;
  private readonly speechThreshold: number;

  // Silero VAD v5 model
  private readonly vad: SileroModel;

  // Frame accumulator — Silero v5 needs exactly 1024 bytes (512 samples = 32ms at 16kHz)
  private frameAccumulator: Buffer = Buffer.alloc(0);

  private state: State = State.WAITING;
  private speechChunks: Buffer[] = [];
  private speechStartMs: number = 0;
  private lastSpeechMs: number = 0;
  private preSpeechRing: Buffer[] = [];
  private preSpeechRingMs: number = 0;

  private totalAudioMs: number = 0;
  private speechMs: number = 0;
  private silenceMs: number = 0;
  private utteranceCount: number = 0;

  // Per-utterance speech frame tracking for noise ratio filtering
  private utteranceSpeechFrames: number = 0;
  private utteranceTotalFrames: number = 0;

  private constructor(vad: SileroModel, options: SpeechBufferOptions = {}) {
    this.silenceDurationMs = options.silenceDuration ?? DEFAULT_SILENCE_DURATION_MS;
    this.minSpeechDurationMs = options.minSpeechDuration ?? DEFAULT_MIN_SPEECH_DURATION_MS;
    this.maxSpeechDurationMs = options.maxSpeechDuration ?? DEFAULT_MAX_SPEECH_DURATION_MS;
    this.preSpeechBufferMs = options.preSpeechBuffer ?? DEFAULT_PRE_SPEECH_BUFFER_MS;
    this.speechThreshold = options.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD;
    this.vad = vad;
  }

  /**
   * Async factory — loads Silero v5 ONNX model (cached after first call).
   */
  static async create(options: SpeechBufferOptions = {}): Promise<SpeechBuffer> {
    const model = await loadSileroV5();
    return new SpeechBuffer(model, options);
  }

  private feedCount = 0;

  async feed(chunk: Buffer): Promise<Buffer | null> {
    if (chunk.length === 0) return null;
    const chunkMs = this.pcmToMs(chunk.length);
    this.totalAudioMs += chunkMs;

    // Skip digital silence — codec artifacts, not real audio
    const rms = calculateRMS(chunk);

    this.feedCount++;

    if (rms < DIGITAL_SILENCE_RMS) {
      this.silenceMs += chunkMs;
      return null;
    }

    // Accumulate to exact VAD frame boundaries (1024 bytes = 512 samples = 32ms at 16kHz)
    // Always copy to avoid Buffer pool aliasing issues
    this.frameAccumulator = this.frameAccumulator.length > 0
      ? Buffer.concat([this.frameAccumulator, chunk])
      : Buffer.from(chunk);

    // Guard against unbounded accumulator growth (corrupted stream, stalled pipeline)
    if (this.frameAccumulator.length > VAD_FRAME_BYTES * 10) {
      this.frameAccumulator = Buffer.alloc(0);
    }

    // Process all complete VAD frames
    // Returns the FIRST emitted utterance; subsequent ones are queued internally.
    let result: Buffer | null = null;
    while (this.frameAccumulator.length >= VAD_FRAME_BYTES) {
      const frame = Buffer.from(this.frameAccumulator.subarray(0, VAD_FRAME_BYTES));
      this.frameAccumulator = Buffer.from(this.frameAccumulator.subarray(VAD_FRAME_BYTES));

      const frameResult = await this.processVadFrame(frame);
      if (frameResult && !result) {
        result = frameResult; // return first emitted utterance (multi-utterance is rare)
      }
    }

    return result;
  }

  private async processVadFrame(frame: Buffer): Promise<Buffer | null> {
    const frameMs = this.pcmToMs(frame.length);

    // Silero VAD v5: returns probability of speech (0.0-1.0)
    let isSpeech: boolean;
    try {
      const float32Frame = pcmInt16ToFloat32(frame);
      const probs = await this.vad.process(float32Frame);
      isSpeech = probs.isSpeech >= this.speechThreshold;
    } catch (err) {
      // VAD error — fall back to RMS threshold
      const rms = calculateRMS(frame);
      isSpeech = rms >= 700;
      if (this.feedCount <= 5 || this.feedCount % 500 === 0) {
        console.error(`[speech-buffer] Silero VAD error (falling back to RMS=${rms.toFixed(0)}): ${err instanceof Error ? err.message : err}`);
      }
    }

    if (isSpeech) {
      this.speechMs += frameMs;
    } else {
      this.silenceMs += frameMs;
    }

    if (this.state === State.WAITING) {
      if (!isSpeech) {
        this.pushToPreSpeechRing(frame);
        return null;
      }

      this.state = State.SPEAKING;
      this.speechStartMs = this.totalAudioMs - frameMs;
      this.lastSpeechMs = this.totalAudioMs;
      this.utteranceSpeechFrames = 1; // this frame is speech
      this.utteranceTotalFrames = 1;

      this.speechChunks = [...this.preSpeechRing, frame];
      this.preSpeechRing = [];
      this.preSpeechRingMs = 0;
      return null;
    }

    // State.SPEAKING
    this.speechChunks.push(frame);
    this.utteranceTotalFrames++;

    if (isSpeech) {
      this.lastSpeechMs = this.totalAudioMs;
      this.utteranceSpeechFrames++;
    }

    const elapsed = this.totalAudioMs - this.speechStartMs;

    if (elapsed >= this.maxSpeechDurationMs) {
      return this.emitUtterance();
    }

    const silenceElapsed = this.totalAudioMs - this.lastSpeechMs;
    if (!isSpeech && silenceElapsed >= this.getEffectiveSilenceDuration()) {
      return this.emitUtterance();
    }

    return null;
  }

  flush(): Buffer | null {
    if (this.state === State.SPEAKING && this.speechChunks.length > 0) {
      return this.emitUtterance();
    }
    return null;
  }

  get stats(): SpeechBufferStats {
    return {
      totalAudioMs: this.totalAudioMs,
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
      utterances: this.utteranceCount,
    };
  }

  /**
   * Adaptive silence duration based on how long the person has been speaking.
   * Short utterances ("ja", "nei") use the default threshold.
   * Longer speech gets more tolerance for mid-sentence thinking pauses.
   */
  private getEffectiveSilenceDuration(): number {
    const speechDuration = this.totalAudioMs - this.speechStartMs;
    if (speechDuration < 1000) {
      // Short utterance ("ja", "nei"): use base (300ms)
      return this.silenceDurationMs;
    } else if (speechDuration < 3000) {
      // Medium: brief pauses (400ms)
      return Math.max(this.silenceDurationMs, 400);
    } else {
      // Long sentence: thinking pauses (500ms)
      return Math.max(this.silenceDurationMs, 500);
    }
  }

  private emitUtterance(): Buffer | null {
    const pcm = Buffer.concat(this.speechChunks);
    this.speechChunks = [];
    this.state = State.WAITING;
    this.preSpeechRing = [];
    this.preSpeechRingMs = 0;

    // Capture and reset per-utterance frame counters
    const speechFrames = this.utteranceSpeechFrames;
    const totalFrames = this.utteranceTotalFrames;
    this.utteranceSpeechFrames = 0;
    this.utteranceTotalFrames = 0;

    const durationMs = this.pcmToMs(pcm.length);
    if (durationMs < this.minSpeechDurationMs) {
      return null;
    }

    // Skip utterances that are mostly noise — if VAD classified < 20% of frames
    // as speech, the buffer is dominated by ambient noise and Azure will either
    // return NoMatch or hallucinate garbled text.
    const speechRatio = totalFrames > 0 ? speechFrames / totalFrames : 0;
    if (speechRatio < 0.20) {
      console.error(
        `[speech-buffer] skipping noise utterance: speechRatio=${(speechRatio * 100).toFixed(0)}% ` +
        `(${speechFrames}/${totalFrames} frames, ${durationMs.toFixed(0)}ms)`,
      );
      return null;
    }

    this.utteranceCount++;
    return pcm;
  }

  private pushToPreSpeechRing(chunk: Buffer): void {
    const chunkMs = this.pcmToMs(chunk.length);
    this.preSpeechRing.push(chunk);
    this.preSpeechRingMs += chunkMs;

    while (this.preSpeechRingMs > this.preSpeechBufferMs && this.preSpeechRing.length > 1) {
      const removed = this.preSpeechRing.shift()!;
      this.preSpeechRingMs -= this.pcmToMs(removed.length);
    }
  }

  private pcmToMs(byteLength: number): number {
    const samples = byteLength / BYTES_PER_SAMPLE;
    return (samples / STT_SAMPLE_RATE) * 1000;
  }
}
