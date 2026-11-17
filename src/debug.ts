/**
 * Opt-in debug logging. Enabled by setting VOICE_DEBUG=1.
 * Output goes to stderr only; nothing is written to disk, because debug lines
 * can contain transcribed speech.
 */
const enabled = process.env.VOICE_DEBUG === "1";

export function debugLog(msg: string): void {
  if (!enabled) return;
  process.stderr.write(`discord-voice-debug: ${msg}\n`);
}
