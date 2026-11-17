/**
 * Speaker allowlist.
 *
 * Only Discord users on the allowlist are ever listened to. Audio from anyone
 * else is neither subscribed to nor sent to ElevenLabs. With no allowlist
 * configured, nobody is allowed (deny by default).
 *
 * Sources, merged:
 *   - VOICE_ALLOWED_USERS: comma-separated Discord user IDs (env or the voice .env)
 *   - ~/.claude/channels/discord/access.json written by the Discord text plugin
 *     (its `allowFrom` list of user IDs). Unknown or malformed files are ignored.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const SNOWFLAKE = /^\d{17,20}$/;

const ACCESS_FILE = join(homedir(), ".claude", "channels", "discord", "access.json");
const CACHE_MS = 5_000;

export interface AllowlistInfo {
  ids: string[];
  fromEnv: number;
  fromAccessFile: number;
  accessFilePath: string;
}

let cache: { at: number; info: AllowlistInfo } | null = null;

function parseIds(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (SNOWFLAKE.test(s)) out.push(s);
  }
  return out;
}

function readAccessFile(): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(ACCESS_FILE, "utf8"));
    if (data && typeof data === "object" && Array.isArray((data as { allowFrom?: unknown }).allowFrom)) {
      return parseIds((data as { allowFrom: unknown[] }).allowFrom);
    }
  } catch {
    // missing or unreadable: no entries
  }
  return [];
}

export function loadAllowlist(): AllowlistInfo {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.info;
  const env = parseIds((process.env.VOICE_ALLOWED_USERS ?? "").split(/[,\s]+/));
  const file = readAccessFile();
  const info: AllowlistInfo = {
    ids: [...new Set([...env, ...file])],
    fromEnv: env.length,
    fromAccessFile: file.length,
    accessFilePath: ACCESS_FILE,
  };
  cache = { at: now, info };
  return info;
}

export function isAllowedSpeaker(userId: string): boolean {
  return SNOWFLAKE.test(userId) && loadAllowlist().ids.includes(userId);
}

export function allowlistHelp(): string {
  return (
    "No allowed speakers are configured, so voice input is ignored. Add Discord user IDs to " +
    "VOICE_ALLOWED_USERS (comma-separated) in ~/.claude/channels/discord-voice/.env, or allow users " +
    "with the Discord text plugin (~/.claude/channels/discord/access.json, allowFrom)."
  );
}
