/**
 * Opt-in debug logging, stderr only (nothing is written to disk).
 *   VOICE_DEBUG=1  timings and lengths only
 *   VOICE_DEBUG=2  also logs transcript text (may contain private speech)
 */
const level = process.env.VOICE_DEBUG === "2" ? 2 : process.env.VOICE_DEBUG === "1" ? 1 : 0;

export const debugEnabled = level >= 1;

export function debugLog(msg: string): void {
  if (level < 1) return;
  process.stderr.write(`discord-voice-debug: ${msg}\n`);
}

/** Log content only at VOICE_DEBUG=2; otherwise just its length. */
export function debugText(label: string, text: string): string {
  return level >= 2 ? `${label}="${text}"` : `${label}_chars=${text.length}`;
}
