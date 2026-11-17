# claude-discord-voice

> **Status: Early alpha** — This plugin works but has known issues. Contributions welcome!

Discord voice channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Speak to Claude via Discord voice chat — speech is transcribed live with ElevenLabs Scribe and responses are spoken back with ElevenLabs text-to-speech. One API key, no other services.

## Features

- **Low latency** — realtime STT streams audio while you talk and commits on end of speech; TTS uses the Flash model over a pre-opened websocket and starts playing on the first audio chunk
- **Barge-in like a person** — start talking and Claude's voice fades out within milliseconds, queued sentences are dropped, and your first word is never clipped (300 ms pre-roll). Claude is told where it was interrupted
- **Incremental replies** — Claude speaks sentence by sentence; the next sentence is synthesized while the current one plays
- **Languages** — Norwegian works out of the box (`VOICE_DEFAULT_LANGUAGE=nb-NO`), or leave it unset to detect the language per utterance
- **Cost controls** — client-side VAD (Silero v5) keeps silence out of STT, per-user rate limit, daily caps on STT audio seconds and TTS characters, short phrases cached in memory
- **Optional backchannel** — a short filler ("mm") if Claude is slow to answer, off by default
- **Auto-disconnect** — Leaves the channel after 10 minutes of silence

## Known Issues

These are the main problems that need fixing. If you want to contribute, these are great places to start:

### Notification delivery is unreliable
MCP notifications (`notifications/claude/channel`) are sometimes silently dropped by Claude Code. The plugin has a `poll_queue` fallback that writes transcriptions to disk, but Claude Code doesn't always poll it. This means spoken messages can get lost.

### ElevenLabs plan limits
Usage is billed per hour of audio (STT) and per character (TTS) against your ElevenLabs plan, and plans have concurrency limits. The plugin caps daily usage (3600 s of audio, 50000 characters) and tells Claude when ElevenLabs reports the quota as exhausted instead of silently dropping speech. See the [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) for current rates.

### Speakers instead of headphones
Discord gives the bot each user's own microphone stream, so the bot never hears itself. If a user plays the bot's voice through speakers and their microphone picks it up, Discord's own echo cancellation has to handle it; otherwise the bot may interrupt itself. Headphones avoid this.

### Untested against the live API
The ElevenLabs integration was written against the API documentation and verified with a mocked server only. Please report anything that behaves differently on a real account.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js 20+
- A Discord bot with voice permissions ([setup guide](https://discord.com/developers/docs/getting-started))
- An [ElevenLabs](https://elevenlabs.io) account and API key (Speech to Text and Text to Speech access)

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
/discord-voice:configure key <your-elevenlabs-key>
```

The Discord bot token is shared with the [text Discord plugin](https://github.com/anthropics/claude-code). Set it up with `/discord:configure <token>` if you haven't already.

## Configuration

Credentials are stored in `~/.claude/channels/discord-voice/.env`:

```
ELEVENLABS_API_KEY=your-key
ELEVENLABS_STT_MODEL=scribe_v2_realtime  # optional
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5   # optional, lowest latency
VOICE_DEFAULT_VOICE=JBFqnCBsd6RMkjVDRZzb # optional, an ElevenLabs voice_id
VOICE_DEFAULT_LANGUAGE=nb-NO             # optional, unset = detect automatically
VOICE_BACKCHANNEL=mm                     # optional filler if Claude is slow, off by default
VOICE_BACKCHANNEL_DELAY_MS=1500          # optional
VOICE_STT_TIMEOUT_MS=10000               # optional, max wait for a transcript after end of speech
VOICE_DEBUG=1                            # optional, verbose logging incl. per-turn latency
```

See `.env.example` for a template.

## Usage

Once configured, use these tools in Claude Code:

| Tool | Description |
|------|-------------|
| `voice_join` | Join a Discord voice channel |
| `voice_leave` | Leave the current channel |
| `voice_reply` | Speak text; repeated calls queue, so Claude can speak sentence by sentence |
| `voice_text_reply` | Send a text message to the guild while in voice |
| `voice_interrupt` | Stop current TTS playback |
| `voice_status` | Connection status and STT/TTS usage |
| `voice_costs` | Usage report for the session |
| `voice_set_language` | Change language (e.g. `nb-NO`, `en-US`, or `auto`) |
| `voice_set_voice` | Change TTS voice |
| `voice_list_channels` | List available voice channels |

## Architecture

```
Discord audio (Opus 48kHz) -> SafeOpusDecoder -> Downsampler (16kHz mono)
-> Silero VAD -> ElevenLabs realtime STT -> MCP notification -> Claude Code
                                                                    |
Discord playback <- 48kHz PCM <- ElevenLabs streaming TTS <- voice_reply
```

With `VOICE_DEBUG=1` every turn logs end of speech to transcript, and end of speech to first audio.

### Source files

| File | Purpose |
|------|---------|
| `src/server.ts` | MCP server — tool definitions, credential loading, Discord client setup |
| `src/voice-pipeline.ts` | Orchestrator — wires audio receive, STT, TTS, and playback into a per-channel pipeline |
| `src/debug.ts` | Opt-in debug logging (`VOICE_DEBUG=1`) |
| `src/stt.ts` | ElevenLabs realtime Speech-to-Text sessions with reconnect, replay, and daily budget |
| `src/tts.ts` | ElevenLabs streaming Text-to-Speech over a warm websocket, cache, and daily budget |
| `src/speech-stream.ts` | Audio of one reply, with playback progress mapped back to the spoken text |
| `src/playback.ts` | Reply queue, prefetching, fade-out on interrupt, interruption reports |
| `src/elevenlabs.ts` | Shared websocket connection and error types |
| `src/usage-budget.ts` | Daily usage cap |
| `src/audio-utils.ts` | Opus decoding, resampling, streaming speech segmenter (Silero v5 VAD, pre-roll, confirmation window) |

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
- **Error messages** — better user-facing errors when the ElevenLabs key is wrong
- **Tests** — there are currently no tests; adding even basic unit tests for STT/TTS would be valuable

## License

Apache-2.0
