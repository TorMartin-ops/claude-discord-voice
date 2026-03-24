# claude-discord-voice

Discord voice channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Speak to Claude via Discord voice chat — speech is transcribed via Azure Speech-to-Text and responses are spoken back via Edge TTS.

## Features

- **Speech-to-Text** — Azure Speech with client-side VAD (Silero v5), daily budget caps, and rate limiting
- **Text-to-Speech** — Free Edge TTS endpoint with persistent WebSocket, in-memory caching, and streaming playback
- **Barge-in** — Interrupt Claude mid-speech by talking over it
- **Cost controls** — Per-user rate limits, global concurrent STT cap, configurable daily budget ($1/day default)
- **Auto-disconnect** — Leaves the channel after 10 minutes of silence

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js 20+
- A Discord bot with voice permissions ([setup guide](https://discord.com/developers/docs/getting-started))
- An Azure Speech resource ([create one](https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices))

## Installation

1. Clone this repo into your Claude Code local plugins directory:

```bash
git clone https://github.com/TorMartin-ops/claude-discord-voice.git ~/.claude/plugins/local/discord-voice
```

2. Enable the plugin:

```bash
claude plugins enable discord-voice@local
```

3. Configure credentials:

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
Discord audio (Opus 48kHz) → SafeOpusDecoder → Downsampler (16kHz mono)
→ Silero VAD → Azure STT → MCP notification → Claude Code
                                                    ↓
Discord playback ← WebM Opus ← Edge TTS ← Claude response
```

## License

Apache-2.0
