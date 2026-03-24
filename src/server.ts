/**
 * Discord voice channel for Claude Code.
 *
 * MCP server that joins Discord voice channels, transcribes speech via Azure
 * STT, and speaks responses via Edge TTS. Transcriptions arrive in Claude Code
 * as channel notifications — the same mechanism the text Discord plugin uses.
 *
 * Delegates all audio pipeline work to VoicePipeline, which handles:
 *   - Per-user Opus decode -> downsample -> VAD -> Azure STT
 *   - TTS queuing with echo prevention (cooldown after playback)
 *   - Direct OggOpus playback (no ffmpeg transcoding needed)
 *   - Inactivity auto-disconnect (10 min default)
 *   - Silence trick so Discord forwards incoming audio
 *
 * Credentials:
 *   - DISCORD_BOT_TOKEN from ~/.claude/channels/discord/.env (shared with text plugin)
 *   - AZURE_SPEECH_KEY + AZURE_SPEECH_REGION from env or ~/.claude/channels/discord-voice/.env
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type VoiceBasedChannel,
  type VoiceChannel,
  type StageChannel,
} from 'discord.js'
import { readFileSync, writeFileSync, chmodSync, appendFileSync, mkdirSync, readdirSync, rmSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { VoicePipeline, type VoicePipelineConfig } from './voice-pipeline.js'

// ---------------------------------------------------------------------------
// Environment loading
// ---------------------------------------------------------------------------

const DISCORD_STATE_DIR = join(homedir(), '.claude', 'channels', 'discord')
const VOICE_STATE_DIR = join(homedir(), '.claude', 'channels', 'discord-voice')
const DISCORD_ENV_FILE = join(DISCORD_STATE_DIR, '.env')
const VOICE_ENV_FILE = join(VOICE_STATE_DIR, '.env')

function loadEnvFile(path: string): void {
  try {
    chmodSync(path, 0o600)
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {
    // File doesn't exist or isn't readable — that's fine.
  }
}

// Shared Discord token from the text plugin's .env
loadEnvFile(DISCORD_ENV_FILE)
// Voice-specific credentials (Azure Speech)
loadEnvFile(VOICE_ENV_FILE)

const TOKEN = process.env.DISCORD_BOT_TOKEN
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION

if (!TOKEN) {
  process.stderr.write(
    `discord-voice: DISCORD_BOT_TOKEN required\n` +
    `  set in ${DISCORD_ENV_FILE}\n` +
    `  format: DISCORD_BOT_TOKEN=MTIz...\n`,
  )
  process.exit(1)
}

if (!AZURE_SPEECH_KEY?.trim() || !AZURE_SPEECH_REGION?.trim()) {
  process.stderr.write(
    `discord-voice: Azure Speech credentials required (must be non-empty)\n` +
    `  set in ${VOICE_ENV_FILE} or env vars:\n` +
    `  AZURE_SPEECH_KEY=...\n` +
    `  AZURE_SPEECH_REGION=swedencentral\n`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// File-based message queue (poll_queue fallback)
// ---------------------------------------------------------------------------
// Workaround for notifications/claude/channel delivery: messages are persisted
// to disk so poll_queue can retrieve them even if the MCP notification never
// reaches the conversation. Mirrors the text plugin's approach.

const QUEUE_DIR = join(VOICE_STATE_DIR, 'queue')

type QueuedMessage = {
  content: string
  channel_id: string
  user: string
  user_id: string
  ts: string
  language: string
  delivered: boolean
}

let enqueueCounter = 0

// ---------------------------------------------------------------------------
// Latest-wins message queue
// ---------------------------------------------------------------------------

/**
 * Enqueue a voice message using latest-wins semantics:
 * purge all existing queue files (stale), write only the new message.
 */
function enqueueVoiceMessage(entry: QueuedMessage): void {
  mkdirSync(QUEUE_DIR, { recursive: true })

  // Purge stale queue files
  try {
    for (const f of readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'))) {
      try { rmSync(join(QUEUE_DIR, f), { force: true }) } catch { /* best-effort */ }
    }
  } catch { /* queue dir may not exist yet */ }

  const ts = Date.now()
  const filename = `${ts}-${entry.user_id}-${enqueueCounter++}.json`
  const path = join(QUEUE_DIR, filename)
  const tmpPath = path + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(entry, null, 2) + '\n')
  renameSync(tmpPath, path)

  const line = `[${new Date().toISOString()}] ENQUEUE: user=${entry.user}, text="${entry.content}"\n`
  try { appendFileSync('/tmp/discord-voice-debug.log', line) } catch {}
  process.stderr.write(`discord-voice: ENQUEUE: user=${entry.user}, text="${entry.content}"\n`)
}

function readUndelivered(limit: number): { path: string; msg: QueuedMessage }[] {
  let files: string[]
  try {
    files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json')).sort()
  } catch {
    return []
  }
  const results: { path: string; msg: QueuedMessage }[] = []
  for (const f of files) {
    if (results.length >= limit) break
    const path = join(QUEUE_DIR, f)
    try {
      const raw = readFileSync(path, 'utf8')
      const msg = JSON.parse(raw) as QueuedMessage
      if (!msg.delivered) results.push({ path, msg })
    } catch {
      // Corrupt file — skip
    }
  }
  return results
}

function countUndelivered(): number {
  let files: string[]
  try {
    files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return 0
  }
  let count = 0
  for (const f of files) {
    try {
      const raw = readFileSync(join(QUEUE_DIR, f), 'utf8')
      const msg = JSON.parse(raw) as QueuedMessage
      if (!msg.delivered) count++
    } catch {
      // Corrupt file — skip
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Crash logging — stderr is captured by the MCP host and invisible after
// a crash.  Write a durable log file so we can diagnose post-mortem.
// ---------------------------------------------------------------------------

const CRASH_LOG = join(VOICE_STATE_DIR, 'crash.log')
try { mkdirSync(VOICE_STATE_DIR, { recursive: true }) } catch { /* exists */ }

function crashLog(label: string, err: unknown): void {
  const ts = new Date().toISOString()
  const msg = err instanceof Error
    ? `${err.message}\n${err.stack}`
    : String(err)
  const line = `[${ts}] ${label}: ${msg}\n`
  process.stderr.write(`discord-voice: ${label}: ${msg}\n`)
  try { appendFileSync(CRASH_LOG, line) } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Error safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  crashLog('unhandled rejection', err)
})
process.on('uncaughtException', err => {
  crashLog('uncaught exception', err)

  // Instead of killing the entire MCP process (which makes all tools
  // unavailable), try to recover by tearing down only the audio pipeline.
  // The MCP server stays alive so voice_join can create a fresh pipeline.
  if (pipeline) {
    try {
      pipeline.destroy()
    } catch (destroyErr) {
      crashLog('pipeline destroy during recovery', destroyErr)
    }
    pipeline = null
    process.stderr.write('discord-voice: pipeline destroyed after uncaught exception — MCP server still alive\n')
  }
  // NOTE: Node.js docs warn against continuing after uncaughtException, but
  // for an audio pipeline the dangerous state is in the native audio code
  // (now destroyed).  The MCP server + Discord client are pure JS and safe
  // to keep running.  If the same exception recurs, the handler fires again
  // and the pipeline is already null, so it's a no-op.
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sttLanguage = process.env.VOICE_DEFAULT_LANGUAGE ?? 'en-US'
let ttsVoice = process.env.VOICE_DEFAULT_VOICE ?? 'en-US-JennyNeural'

// Session-level tracking for voice_costs (survives pipeline recreation)
let sessionStartedAt: number | null = null

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
})

// ---------------------------------------------------------------------------
// Voice pipeline
// ---------------------------------------------------------------------------

function makePipelineConfig(): VoicePipelineConfig {
  return {
    azureSttKey: AZURE_SPEECH_KEY!,
    azureSttRegion: AZURE_SPEECH_REGION!,
    sttLanguage,
    ttsVoice,
  }
}

let pipeline: VoicePipeline | null = null

function ensurePipeline(): VoicePipeline {
  // Recreate the pipeline if the previous instance was destroyed or is in a
  // bad state (e.g. after a voice connection crash or TTS WebSocket failure).
  if (pipeline && pipeline.isDestroyed) {
    process.stderr.write('discord-voice: previous pipeline was destroyed, creating a new one\n')
    pipeline = null
  }

  if (!pipeline) {
    pipeline = new VoicePipeline(client, makePipelineConfig())

    // Track session start time for cost calculations
    if (!sessionStartedAt) {
      sessionStartedAt = Date.now()
    }

    // When transcription arrives, dispatch MCP notification immediately so
    // Claude Code sees it in real-time. File queue remains as fallback.
    pipeline.onTranscription(async (userId, username, text, channelId) => {
      const debugLine = (msg: string) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`
        try { appendFileSync('/tmp/discord-voice-debug.log', line) } catch {}
        process.stderr.write(`discord-voice: ${msg}\n`)
      }

      const ts = new Date().toISOString()
      enqueueVoiceMessage({
        content: text,
        channel_id: channelId,
        user: username,
        user_id: userId,
        ts,
        language: sttLanguage,
        delivered: false,
      })

      // Fire MCP notification immediately
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: text,
          meta: {
            chat_id: channelId,
            user: username,
            user_id: userId,
            ts: new Date().toISOString(),
            source: 'discord-voice',
            language: sttLanguage,
          },
        },
      }).catch(err => {
        debugLine(`NOTIFY_FAILED: ${err instanceof Error ? err.message : err} — message is in queue for poll_queue`)
      })
    })
  }
  return pipeline
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'discord-voice', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Voice channel plugin for Discord. Works alongside the text Discord plugin.',
      '',
      'Two channel sources deliver Discord messages:',
      '  - <channel source="discord"> — text messages from the text plugin',
      '  - <channel source="discord-voice"> — transcribed speech from this voice plugin',
      '',
      'Response routing:',
      '  - When a voice user speaks (source="discord-voice"), respond with voice_reply (TTS) so they hear the answer.',
      '  - When a text user writes (source="discord"), respond with reply (from the text plugin) so they read the answer.',
      '  - Use voice_text_reply to send a TEXT message to the guild\'s text channel while in a voice call — useful for sharing links, code snippets, formatted text, or long responses that are better read than heard.',
      '',
      'Voice interruption:',
      '  - If the user speaks during TTS playback, the bot automatically pauses incoming audio processing and resumes after playback finishes.',
      '  - Use the voice_interrupt tool to manually stop TTS playback immediately (e.g. when the user wants to cut off a long response).',
      '',
      'The user speaks in the configured STT language (check voice_status for current setting).',
      '',
      'Voice personality & style (IMPORTANT — follow strictly for all voice_reply output):',
      '  - Channel Jarvis: crisp, confident, dry wit. Never robotic, never rambling.',
      '  - Be concise but complete — give the full answer, just without the fluff.',
      '  - Lead with the answer, not the reasoning. Skip filler ("La meg se...", "Selvfølgelig...", "Jeg skal...").',
      '  - Use natural spoken language — contractions, rhythm. Not written-text-read-aloud.',
      '  - Dense, not sparse: pack information tight. "Tre feil i auth-modulen, to type-feil og en manglende import" — not five sentences saying the same.',
      '  - For long output (tables, code, lists): give the summary via voice, full details via voice_text_reply.',
      '  - Gentle humor when it fits — a raised eyebrow, not a comedy routine.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'voice_join',
      description:
        'Join a Discord voice channel and start listening. Requires guild_id and channel_id.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          guild_id: { type: 'string', description: 'Discord guild (server) ID' },
          channel_id: { type: 'string', description: 'Voice channel ID to join' },
        },
        required: ['guild_id', 'channel_id'],
      },
    },
    {
      name: 'voice_leave',
      description: 'Leave the current voice channel and stop listening.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'voice_reply',
      description:
        'Speak text aloud in the current voice channel via TTS. The bot must already be in a voice channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Text to speak aloud' },
        },
        required: ['text'],
      },
    },
    {
      name: 'voice_text_reply',
      description:
        'Send a TEXT message to a guild text channel while in a voice call. Useful for sharing links, code snippets, formatted text, or long responses that are better read than heard. The bot must be in a voice channel. Optionally specify a channel_id; defaults to the guild\'s system channel or first available text channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Text message to send' },
          channel_id: { type: 'string', description: 'Target text channel ID. If omitted, uses the guild\'s system channel or first text channel.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'voice_interrupt',
      description: 'Interrupt current TTS playback immediately. Use when the user tries to speak over the bot.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'voice_costs',
      description: 'Get detailed cost analysis for the current voice session.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'voice_status',
      description: 'Get current voice connection status, active users, and STT usage stats.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'voice_set_language',
      description:
        'Change the STT recognition language. Examples: nb-NO, en-US, nn-NO, sv-SE.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          language: { type: 'string', description: "BCP-47 language tag, e.g. 'nb-NO', 'en-US'" },
        },
        required: ['language'],
      },
    },
    {
      name: 'voice_set_voice',
      description:
        'Change the TTS voice. English voices: en-US-JennyNeural, en-US-GuyNeural, en-US-AriaNeural. See Edge TTS docs for other languages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          voice: { type: 'string', description: "TTS voice name, e.g. 'en-US-JennyNeural'" },
        },
        required: ['voice'],
      },
    },
    {
      name: 'voice_list_channels',
      description: 'List voice channels the bot can see. Optionally filter by guild.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          guild_id: { type: 'string', description: 'Optional: filter to a specific guild' },
        },
      },
    },
    // ── Queue & diagnostics ───────────────────────────────────────────
    {
      name: 'poll_queue',
      description: 'Poll the file-based message queue for undelivered voice transcriptions. Use this to retrieve transcribed speech that may not have been delivered via MCP notifications.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max messages to return (default 10).' },
        },
      },
    },
    {
      name: 'voice_latest',
      description: 'Get the latest undelivered voice transcription. Returns the most recent speech, discarding older messages. Simpler alternative to poll_queue.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'voice_debug_status',
      description: 'Get diagnostic info: bot connection, pipeline status, queued messages, STT usage.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    // -----------------------------------------------------------------
    // voice_join
    // -----------------------------------------------------------------
    case 'voice_join': {
      if (!client.isReady()) {
        return { content: [{ type: 'text', text: 'Discord gateway is not connected yet. Wait a moment and try again.' }] }
      }

      const guildId = (args as Record<string, string>).guild_id
      const channelId = (args as Record<string, string>).channel_id

      const guild = client.guilds.cache.get(guildId)
      if (!guild) {
        return { content: [{ type: 'text', text: `Guild ${guildId} not found. Is the bot invited to this server?` }] }
      }

      const channel = guild.channels.cache.get(channelId)
      if (!channel || !channel.isVoiceBased()) {
        return { content: [{ type: 'text', text: `Channel ${channelId} not found or is not a voice channel.` }] }
      }

      try {
        const p = ensurePipeline()
        await p.join(channel as VoiceChannel | StageChannel)

        const voiceChannel = channel as VoiceBasedChannel
        const members = voiceChannel.members.filter(m => !m.user.bot).map(m => m.displayName)

        return {
          content: [{
            type: 'text',
            text: `Joined voice channel "${channel.name}" in ${guild.name}.\n` +
              `Listening for speech (${sttLanguage}), TTS voice: ${ttsVoice}.\n` +
              `Users in channel: ${members.length > 0 ? members.join(', ') : '(empty)'}`,
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Failed to join voice channel: ${err instanceof Error ? err.message : String(err)}`,
          }],
        }
      }
    }

    // -----------------------------------------------------------------
    // voice_leave
    // -----------------------------------------------------------------
    case 'voice_leave': {
      if (!pipeline || !pipeline.status.connected) {
        return { content: [{ type: 'text', text: 'Not currently in a voice channel.' }] }
      }

      const status = pipeline.status
      pipeline.leave()

      return {
        content: [{
          type: 'text',
          text: `Left voice channel.\n` +
            `STT session: ${status.sttUsage.totalSeconds.toFixed(1)}s audio processed, ` +
            `$${status.sttUsage.estimatedCostUSD.toFixed(4)} est. cost.`,
        }],
      }
    }

    // -----------------------------------------------------------------
    // voice_reply (TTS)
    // -----------------------------------------------------------------
    case 'voice_reply': {
      const debugLine = (msg: string) => {
        const line = `[${new Date().toISOString()}] ${msg}
`
        try { appendFileSync('/tmp/discord-voice-debug.log', line) } catch {}
        process.stderr.write(`discord-voice: ${msg}
`)
      }

      const text = (args as Record<string, string>).text
      if (!text) {
        return { content: [{ type: 'text', text: 'No text provided.' }] }
      }

      if (!pipeline || !pipeline.status.connected) {
        return { content: [{ type: 'text', text: 'Not in a voice channel. Use voice_join first.' }] }
      }

      // Interrupt any current playback
      pipeline.interrupt()

      const isChunked = text.length > 200

      // Fire-and-forget — don't await, so Claude can process new transcriptions
      pipeline.playResponse(text).catch(err => {
        debugLine(`TTS background error: ${err instanceof Error ? err.message : err}`)
      })

      const preview = text.length > 100 ? text.slice(0, 100) + '...' : text
      const chunkedNote = isChunked
        ? ` (${text.length} chars, using chunked synthesis)`
        : ''

      debugLine(`voice_reply: fire-and-forget TTS started for ${text.length} chars`)

      return {
        content: [{
          type: 'text',
          text: `Spoke: "${preview}"${chunkedNote}`,
        }],
      }
    }

    // -----------------------------------------------------------------
    // voice_text_reply (send text message to guild channel)
    // -----------------------------------------------------------------
    case 'voice_text_reply': {
      const text = (args as Record<string, string>).text
      const channelId = (args as Record<string, string | undefined>).channel_id
      if (!text) {
        return { content: [{ type: 'text', text: 'No text provided.' }] }
      }

      if (!pipeline || !pipeline.status.connected || !pipeline.status.channelId) {
        return { content: [{ type: 'text', text: 'Not in a voice channel. Use voice_join first.' }] }
      }

      try {
        // Find the guild from the current voice channel
        let guild = null
        for (const g of client.guilds.cache.values()) {
          if (g.channels.cache.has(pipeline.status.channelId)) {
            guild = g
            break
          }
        }
        if (!guild) {
          return { content: [{ type: 'text', text: 'Could not resolve the guild for the current voice channel.' }] }
        }

        // Resolve target text channel
        let targetChannel
        if (channelId) {
          const ch = guild.channels.cache.get(channelId)
          if (!ch || !ch.isTextBased()) {
            return { content: [{ type: 'text', text: `Channel ${channelId} not found or is not a text channel in this guild.` }] }
          }
          targetChannel = ch
        } else {
          // Default: system channel, or first text channel we can send to
          targetChannel = guild.systemChannel
          if (!targetChannel) {
            const textCh = guild.channels.cache.find(
              c => c.type === ChannelType.GuildText && c.permissionsFor(guild!.members.me!)?.has('SendMessages'),
            )
            if (!textCh || !textCh.isTextBased()) {
              return { content: [{ type: 'text', text: 'No suitable text channel found in this guild. Specify a channel_id.' }] }
            }
            targetChannel = textCh
          }
        }

        if (!('send' in targetChannel)) {
          return { content: [{ type: 'text', text: 'Target channel does not support sending messages.' }] }
        }

        await targetChannel.send(text)
        return {
          content: [{
            type: 'text',
            text: `Sent text message to #${targetChannel.name ?? targetChannel.id}: "${text.length > 100 ? text.slice(0, 100) + '...' : text}"`,
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Failed to send text message: ${err instanceof Error ? err.message : String(err)}`,
          }],
        }
      }
    }

    // -----------------------------------------------------------------
    // voice_interrupt
    // -----------------------------------------------------------------
    case 'voice_interrupt': {
      if (!pipeline || !pipeline.status.connected) {
        return { content: [{ type: 'text', text: 'Not in a voice channel. Nothing to interrupt.' }] }
      }

      try {
        const wasPlaying = pipeline.interrupt()

        return {
          content: [{
            type: 'text',
            text: wasPlaying
              ? 'TTS playback interrupted. The bot is now listening for speech.'
              : 'No TTS was playing. The bot is already listening.',
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Failed to interrupt: ${err instanceof Error ? err.message : String(err)}`,
          }],
        }
      }
    }

    // -----------------------------------------------------------------
    // voice_costs
    // -----------------------------------------------------------------
    case 'voice_costs': {
      const pipelineStatus = pipeline?.status

      if (!pipelineStatus) {
        return {
          content: [{
            type: 'text',
            text: 'No active voice session. Use voice_join to connect first.',
          }],
        }
      }

      const stt = pipelineStatus.sttUsage
      const tts = pipelineStatus.ttsCache

      // Calculate session duration
      const sessionDurationMs = sessionStartedAt ? Date.now() - sessionStartedAt : 0
      const sessionDurationMin = sessionDurationMs / 60_000
      const sessionDurationHrs = sessionDurationMs / 3_600_000

      // STT cost details: Azure charges $1/hr of audio
      const sttCostPerHour = 1.0
      const sttMinutesUsed = stt.totalSeconds / 60

      // Projected monthly cost based on current usage rate
      let projectedMonthlyUSD = 0
      if (sessionDurationHrs > 0) {
        const costPerHourOfSession = stt.estimatedCostUSD / sessionDurationHrs
        // Assume 8 hours/day active use, 22 working days/month
        projectedMonthlyUSD = costPerHourOfSession * 8 * 22
      }

      // TTS details: Edge TTS is free but rate-limited
      const ttsTotalRequests = tts.hits + tts.misses
      const ttsCacheHitRate = ttsTotalRequests > 0
        ? ((tts.hits / ttsTotalRequests) * 100).toFixed(1)
        : '0.0'

      const lines = [
        '=== Voice Session Cost Report ===',
        '',
        `Session duration: ${sessionDurationMin.toFixed(1)} min (${sessionDurationHrs.toFixed(2)} hrs)`,
        '',
        '--- STT (Azure Speech-to-Text) ---',
        `Audio processed: ${stt.totalSeconds.toFixed(1)}s (${sttMinutesUsed.toFixed(2)} min)`,
        `Rate: $${sttCostPerHour.toFixed(2)}/hr of audio`,
        `Cost today: $${stt.estimatedCostUSD.toFixed(4)}`,
        `Daily budget: $${stt.dailyBudgetUSD.toFixed(2)}`,
        `Budget remaining: $${stt.dailyBudgetRemainingUSD.toFixed(4)} (${((stt.dailyBudgetRemainingUSD / stt.dailyBudgetUSD) * 100).toFixed(1)}%)`,
        `Budget resets: ${stt.dailyBudgetResetAt || 'N/A'}`,
        stt.budgetExhausted ? '*** BUDGET EXHAUSTED — transcription paused ***' : '',
        '',
        '--- TTS (Edge TTS) ---',
        `Total synthesis requests: ${ttsTotalRequests}`,
        `Cache hits: ${tts.hits} / misses: ${tts.misses} (${ttsCacheHitRate}% hit rate)`,
        `Cost: FREE (Edge TTS has rate limits but no per-request cost)`,
        '',
        '--- Projections ---',
        `Monthly estimate (8hr/day, 22 days): $${projectedMonthlyUSD.toFixed(2)}`,
        `Daily estimate at current rate: $${(sessionDurationHrs > 0 ? (stt.estimatedCostUSD / sessionDurationHrs) * 8 : 0).toFixed(4)}`,
      ]

      return {
        content: [{
          type: 'text',
          text: lines.filter(l => l !== undefined).join('\n'),
        }],
      }
    }

    // -----------------------------------------------------------------
    // voice_status
    // -----------------------------------------------------------------
    case 'voice_status': {
      if (!pipeline) {
        return {
          content: [{
            type: 'text',
            text: 'Pipeline not initialized. Use voice_join to connect to a channel first.',
          }],
        }
      }

      const status = pipeline.status
      let channelInfo = 'Not connected'
      let userList = ''

      if (status.connected && status.channelId) {
        // Resolve channel name from cache
        for (const guild of client.guilds.cache.values()) {
          const ch = guild.channels.cache.get(status.channelId)
          if (ch && ch.isVoiceBased()) {
            const voiceChannel = ch as VoiceBasedChannel
            channelInfo = `${guild.name} / ${ch.name}`
            const members = voiceChannel.members.filter(m => !m.user.bot)
            userList = members.map(m => `  - ${m.displayName} (${m.id})`).join('\n')
            break
          }
        }
      }

      const budgetPct = status.sttUsage.dailyBudgetUSD > 0
        ? ((status.sttUsage.estimatedCostUSD / status.sttUsage.dailyBudgetUSD) * 100).toFixed(1)
        : '0.0'
      const budgetWarnings: string[] = []
      if (status.sttUsage.budgetExhausted) {
        budgetWarnings.push('*** STT BUDGET EXHAUSTED — transcription paused until reset ***')
      } else if (parseFloat(budgetPct) >= 80) {
        budgetWarnings.push('*** WARNING: Approaching daily STT budget limit ***')
      }

      return {
        content: [{
          type: 'text',
          text: [
            `Connected: ${status.connected}`,
            `Channel: ${channelInfo}`,
            `STT language: ${sttLanguage}`,
            `TTS voice: ${ttsVoice}`,
            `Active listeners: ${status.activeUsers.length}`,
            userList ? `Users in channel:\n${userList}` : '',
            '',
            '--- STT Usage & Budget ---',
            `Audio sent today: ${status.sttUsage.totalSeconds.toFixed(1)}s (${(status.sttUsage.totalSeconds / 60).toFixed(1)} min)`,
            `Est. cost today: $${status.sttUsage.estimatedCostUSD.toFixed(4)}`,
            `Daily budget: $${status.sttUsage.dailyBudgetUSD.toFixed(2)}`,
            `Budget remaining: $${status.sttUsage.dailyBudgetRemainingUSD.toFixed(4)} (${(100 - parseFloat(budgetPct)).toFixed(1)}%)`,
            `Budget usage: ${budgetPct}%`,
            `Budget reset: ${status.sttUsage.dailyBudgetResetAt || 'N/A'}`,
            ...budgetWarnings,
            '',
            '--- TTS Cache ---',
            `Hits: ${status.ttsCache.hits}`,
            `Misses: ${status.ttsCache.misses}`,
          ].filter(Boolean).join('\n'),
        }],
      }
    }

    // -----------------------------------------------------------------
    // voice_set_language
    // -----------------------------------------------------------------
    case 'voice_set_language': {
      const language = (args as Record<string, string>).language
      if (!language) {
        return { content: [{ type: 'text', text: 'No language provided.' }] }
      }

      const oldLanguage = sttLanguage
      sttLanguage = language

      if (pipeline) {
        pipeline.setLanguage(language)
      }

      return {
        content: [{
          type: 'text',
          text: `STT language changed: ${oldLanguage} -> ${sttLanguage}\n` +
            (pipeline?.status.connected
              ? 'Note: reconnect (voice_leave + voice_join) for STT language change to fully take effect.'
              : ''),
        }],
      }
    }

    // -----------------------------------------------------------------
    // voice_set_voice
    // -----------------------------------------------------------------
    case 'voice_set_voice': {
      const voice = (args as Record<string, string>).voice
      if (!voice) {
        return { content: [{ type: 'text', text: 'No voice provided.' }] }
      }

      const oldVoice = ttsVoice
      ttsVoice = voice

      if (pipeline) {
        pipeline.setVoice(voice)
      }

      return {
        content: [{
          type: 'text',
          text: `TTS voice changed: ${oldVoice} -> ${ttsVoice}`,
        }],
      }
    }

    // -----------------------------------------------------------------
    // voice_list_channels
    // -----------------------------------------------------------------
    case 'voice_list_channels': {
      if (!client.isReady()) {
        return { content: [{ type: 'text', text: 'Discord gateway is not connected yet. Wait a moment and try again.' }] }
      }

      const filterGuildId = (args as Record<string, string | undefined>).guild_id

      const guilds = filterGuildId
        ? [client.guilds.cache.get(filterGuildId)].filter(Boolean)
        : [...client.guilds.cache.values()]

      if (guilds.length === 0) {
        return {
          content: [{
            type: 'text',
            text: filterGuildId
              ? `Guild ${filterGuildId} not found.`
              : 'Bot is not in any guilds.',
          }],
        }
      }

      const lines: string[] = []
      for (const guild of guilds) {
        if (!guild) continue
        const voiceChannels = guild.channels.cache.filter(
          c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice,
        )
        if (voiceChannels.size === 0) continue

        lines.push(`**${guild.name}** (${guild.id}):`)
        for (const [id, ch] of voiceChannels) {
          const vc = ch as VoiceBasedChannel
          const memberCount = vc.members.filter(m => !m.user.bot).size
          lines.push(`  ${ch.name} — id: ${id}, users: ${memberCount}`)
        }
      }

      return {
        content: [{
          type: 'text',
          text: lines.length > 0
            ? lines.join('\n')
            : 'No voice channels found.',
        }],
      }
    }

    // -----------------------------------------------------------------
    // poll_queue
    // -----------------------------------------------------------------
    case 'poll_queue': {
      const limit = Math.max(1, Math.min((args as Record<string, number>).limit || 10, 100))
      const entries = readUndelivered(limit)
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: '(no undelivered voice messages in queue)' }] }
      }
      const lines: string[] = []
      for (const { path, msg } of entries) {
        lines.push(
          `<channel source="discord-voice" chat_id="${msg.channel_id}" user="${msg.user}" user_id="${msg.user_id}" ts="${msg.ts}" language="${msg.language}">\n` +
          `${msg.content}\n` +
          `</channel>`,
        )
        // Mark as delivered by removing the file
        try { rmSync(path, { force: true }) } catch {}
      }
      return { content: [{ type: 'text', text: lines.join('\n\n') }] }
    }

    // -----------------------------------------------------------------
    // voice_latest — simplified single-message retrieval
    // -----------------------------------------------------------------
    case 'voice_latest': {
      const entries = readUndelivered(1)
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: '(no undelivered voice messages)' }] }
      }
      const { path, msg } = entries[0]
      // Remove the file (delivered)
      try { rmSync(path, { force: true }) } catch {}
      return {
        content: [{
          type: 'text',
          text:
            `<channel source="discord-voice" chat_id="${msg.channel_id}" user="${msg.user}" user_id="${msg.user_id}" ts="${msg.ts}" language="${msg.language}">\n` +
            `${msg.content}\n` +
            `</channel>`,
        }],
      }
    }

    // -----------------------------------------------------------------
    // voice_debug_status
    // -----------------------------------------------------------------
    case 'voice_debug_status': {
      const queued = countUndelivered()
      const pipelineStatus = pipeline?.status
      const lines = [
        `bot_connected: ${client.isReady()}`,
        `gateway_ping: ${client.ws.ping}ms`,
        `guilds: ${client.guilds.cache.size}`,
        `pipeline_active: ${!!pipeline && !pipeline.isDestroyed}`,
        `pipeline_connected: ${pipelineStatus?.connected ?? false}`,
        `channel_id: ${pipelineStatus?.channelId ?? '(none)'}`,
        `active_listeners: ${pipelineStatus?.activeUsers.length ?? 0}`,
        `queued_undelivered: ${queued}`,
        `stt_language: ${sttLanguage}`,
        `tts_voice: ${ttsVoice}`,
        `stt_audio_today: ${pipelineStatus?.sttUsage.totalSeconds.toFixed(1) ?? '0.0'}s`,
        `stt_cost_today: $${pipelineStatus?.sttUsage.estimatedCostUSD.toFixed(4) ?? '0.0000'}`,
        `stt_budget_exhausted: ${pipelineStatus?.sttUsage.budgetExhausted ?? false}`,
      ]
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  }
})

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())

client.once('ready', c => {
  process.stderr.write(`discord-voice: gateway connected as ${c.user.tag}\n`)
})

client.login(TOKEN).catch(err => {
  process.stderr.write(`discord-voice: login failed: ${err}\n`)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('discord-voice: shutting down\n')

  if (pipeline) {
    pipeline.destroy()
    pipeline = null
  }

  // Hard deadline: if client.destroy() hangs (e.g. TTS WebSocket mid-synthesis,
  // stuck gateway close), force exit after 5 seconds.
  const forceExit = setTimeout(() => {
    process.stderr.write('discord-voice: shutdown timed out, forcing exit\n')
    process.exit(1)
  }, 5000)
  forceExit.unref()

  void Promise.resolve(client.destroy())
    .catch(err => {
      process.stderr.write(`discord-voice: error during client destroy: ${err}\n`)
    })
    .finally(() => process.exit(0))
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.on('error', err => {
  process.stderr.write(
    `discord-voice: client error: ${err}\n` +
    `discord-voice: MCP servers do not auto-restart — the parent process must relaunch this server.\n`,
  )
})
