# claude-discord-voice

> **Status: Early alpha** — This plugin works but has known issues. Contributions welcome!

Discord voice channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Speak to Claude via Discord voice chat — speech is transcribed via Azure Speech-to-Text and responses are spoken back via Edge TTS.

## Features

- **Speech-to-Text** — Azure Speech with client-side VAD (Silero v5), daily budget caps, and rate limiting
- **Text-to-Speech** — Free Edge TTS endpoint with persistent WebSocket, in-memory caching, and streaming playback
- **Barge-in** — Interrupt Claude mid-speech by talking over it
- **Cost controls** — Per-user rate limits, global concurrent STT cap, configurable daily budget ($1/day default)
- **Auto-disconnect** — Leaves the channel after 10 minutes of silence

## Known Issues

These are the main problems that need fixing. If you want to contribute, these are great places to start:

### Notification delivery is unreliable
MCP notifications (`notifications/claude/channel`) are sometimes silently dropped by Claude Code. The plugin has a `poll_queue` fallback that writes transcriptions to disk, but Claude Code doesn't always poll it. This means spoken messages can get lost.

### Azure F0 free tier limitations
The free Azure Speech tier only allows 1 concurrent STT request and 5 hours/month. The plugin works around this with a concurrent request cap, but heavy use will hit the monthly limit fast. When Azure reports the quota as exhausted, the plugin tells Claude so instead of silently dropping speech.

### Anti-echo can still cause dead zones
After TTS playback, there is a short (200ms) cooldown where user speech is ignored to prevent the bot from transcribing its own output. This sometimes causes the first word of a user's response to be clipped. A smarter approach (e.g., audio fingerprinting or stream-level echo cancellation) would improve conversation flow.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js 20+
- A Discord bot with voice permissions ([setup guide](https://discord.com/developers/docs/getting-started))
- An Azure Speech resource ([create one](https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices)) — the free F0 tier works but has limitations (see above)

## Installation

1. Clone this repo into your Claude Code local plugins directory:

```bash
git clone https://github.com/TorMartin-ops/claude-discord-voice.git ~/.claude/plugins/local/discord-voice
```

2. Install dependencies and build:

```bash
cd ~/.claude/plugins/local/discord-voice
npm install
npm run build
```

3. Enable the plugin:

```bash
claude plugins enable discord-voice@local
```

4. Configure credentials:

```bash
# In a Claude Code session:
/discord-voice:configure azure <your-azure-key> <region>
```

The Discord bot token is shared with the [text Discord plugin](https://github.com/anthropics/claude-code). Set it up with `/discord:configure <token>` if you haven't already.

## Configuration

Credentials are stored in `~/.claude/channels/discord-voice/.env`:

```
AZURE_SPEECH_KEY=your-key
AZURE_SPEECH_REGION=eastus
VOICE_DEFAULT_LANGUAGE=en-US          # optional
VOICE_DEFAULT_VOICE=en-US-JennyNeural # optional
VOICE_STT_TIMEOUT_MS=15000            # optional, max wait for one Azure STT call
VOICE_DEBUG=1                         # optional, verbose debug logging to stderr
```

See `.env.example` for a template.

## Usage

Once configured, use these tools in Claude Code:

| Tool | Description |
|------|-------------|
| `voice_join` | Join a Discord voice channel |
| `voice_leave` | Leave the current channel |
| `voice_reply` | Speak text via TTS |
| `voice_text_reply` | Send a text message to the guild while in voice |
| `voice_interrupt` | Stop current TTS playback |
| `voice_status` | Connection status and STT usage stats |
| `voice_costs` | Detailed cost breakdown |
| `voice_set_language` | Change STT language (e.g. `en-US`, `de-DE`) |
| `voice_set_voice` | Change TTS voice |
| `voice_list_channels` | List available voice channels |

## Architecture

```
Discord audio (Opus 48kHz) -> SafeOpusDecoder -> Downsampler (16kHz mono)
-> Silero VAD -> Azure STT -> MCP notification -> Claude Code
                                                      |
Discord playback <- WebM Opus <- Edge TTS <- Claude response
```

### Source files

| File | Purpose |
|------|---------|
| `src/server.ts` | MCP server — tool definitions, credential loading, Discord client setup |
| `src/voice-pipeline.ts` | Orchestrator — wires audio receive, STT, TTS, and playback into a per-channel pipeline |
| `src/debug.ts` | Opt-in debug logging (`VOICE_DEBUG=1`) |
| `src/stt.ts` | Azure Speech-to-Text wrapper with cost tracking, budget caps, and retry logic |
| `src/tts.ts` | Edge TTS WebSocket client with DRM auth, SSML generation, and streaming |
| `src/audio-utils.ts` | Opus decoding, downsampling (48kHz -> 16kHz), VAD (Silero v5), noise floor calibration |

## Contributing

This plugin is in early alpha and needs help! Here's how to get started:

1. Fork the repo and clone it
2. `npm install` to get dependencies
3. `npm run build` to compile TypeScript
4. Make your changes in `src/`
5. Test by enabling the plugin in Claude Code and joining a voice channel
6. Open a PR with a description of what you fixed

### Priority areas for contribution

- **Improve notification reliability** — investigate why MCP notifications get dropped and find a better delivery mechanism
- **Better echo cancellation** — replace the cooldown timer with something smarter
- **Multi-user support** — test and fix issues with multiple people in the same voice channel
- **Error messages** — better user-facing errors when Azure credentials are wrong
- **Tests** — there are currently no tests; adding even basic unit tests for STT/TTS would be valuable

## License

Apache-2.0
