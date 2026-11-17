/**
 * Plays queued spoken replies through a Discord audio player.
 *
 * The next reply is synthesized while the current one plays, so consecutive
 * replies join without a gap. interrupt() cancels everything in flight and
 * fades the current audio out over a few milliseconds instead of cutting it.
 */

import { AudioPlayerStatus, createAudioResource, StreamType, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import { debugLog } from "./debug.js";
import { isTtsAbort, type SpeechStream, type TextToSpeech } from "./tts.js";

const FADE_STEPS = 3;
const FADE_STEP_MS = 4;

interface Reply {
  text: string;
  /** Short filler such as "mm"; never reported as an interrupted reply. */
  filler: boolean;
  speech?: SpeechStream;
}

interface Playing {
  reply: Reply;
  speech: SpeechStream;
  resource: AudioResource;
}

export interface InterruptedReply {
  text: string;
  spokenChars: number;
}

export class Playback {
  private readonly queue: Reply[] = [];
  private current: Playing | null = null;
  /** performance.now() of the user's last end of speech, for latency logging. */
  turnEndedAt = 0;

  constructor(
    private readonly player: AudioPlayer,
    private readonly tts: TextToSpeech,
  ) {
    player.on(AudioPlayerStatus.Idle, () => this.advance());
    player.on("error", (err) => {
      console.error(`[playback] audio player error: ${err.message}`);
      this.advance();
    });
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  enqueue(text: string, filler = false): void {
    this.queue.push({ text, filler });
    this.prefetch();
    if (!this.current) this.playNext();
  }

  /**
   * Stop speaking now. Returns what was being said, or null when nothing was
   * playing or only a filler was.
   */
  interrupt(): InterruptedReply | null {
    const playing = this.current;
    const interrupted =
      playing && !playing.reply.filler
        ? { text: playing.reply.text, spokenChars: playing.speech.spokenChars() }
        : null;

    this.queue.length = 0;
    this.current = null;
    this.tts.abort();
    if (playing) this.fadeOutAndStop(playing.resource);
    return interrupted;
  }

  private advance(): void {
    if (!this.current) return; // idle caused by interrupt() or the join silence
    this.current = null;
    this.playNext();
    if (!this.current) this.tts.warmUp();
  }

  private prefetch(): void {
    const next = this.queue[0];
    if (next) next.speech ??= this.tts.speak(next.text);
  }

  private playNext(): void {
    const reply = this.queue.shift();
    if (!reply) return;
    const speech = reply.speech ?? this.tts.speak(reply.text);
    this.prefetch();

    speech.done.catch((err) => {
      if (!isTtsAbort(err)) console.error(`[playback] speech synthesis failed: ${err instanceof Error ? err.message : err}`);
    });

    const resource = createAudioResource(speech, { inputType: StreamType.Raw, inlineVolume: true });
    this.current = { reply, speech, resource };
    this.player.play(resource);

    const logLatency = () => {
      if (this.turnEndedAt > 0) {
        debugLog(`TURN_LATENCY: ${(performance.now() - this.turnEndedAt).toFixed(0)}ms from end of speech to first audio`);
        this.turnEndedAt = 0;
      }
    };
    if (speech.hasAudio) logLatency();
    else speech.once("firstAudio", logLatency);
  }

  private fadeOutAndStop(resource: AudioResource): void {
    let step = 0;
    const timer = setInterval(() => {
      step++;
      resource.volume?.setVolume(1 - step / FADE_STEPS);
      if (step < FADE_STEPS) return;
      clearInterval(timer);
      // A newer reply may already own the player; only stop our own audio.
      if (this.player.state.status !== AudioPlayerStatus.Idle && this.player.state.resource === resource) {
        this.player.stop(true);
      }
    }, FADE_STEP_MS);
  }
}

/** Describe an interrupted reply so Claude can continue the conversation naturally. */
export function describeInterruption({ text, spokenChars }: InterruptedReply): string {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  let end = 0;
  let index = sentences.length - 1;
  for (let i = 0; i < sentences.length; i++) {
    end += sentences[i].length;
    if (spokenChars <= end) {
      index = i;
      break;
    }
  }
  const unheard = sentences.slice(index + 1).join("").trim();
  const parts = [
    spokenChars === 0
      ? "The user interrupted before your reply was heard."
      : `The user interrupted your spoken reply during sentence ${index + 1} of ${sentences.length}: "${sentences[index].trim()}".`,
  ];
  if (unheard) parts.push(`They did not hear: "${unheard}".`);
  return `[${parts.join(" ")}]`;
}
