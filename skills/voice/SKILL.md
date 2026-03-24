---
name: configure
description: Configure Discord voice bot — set Azure Speech credentials and voice settings
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /discord-voice:configure — Voice Channel Setup

Sets up Azure Speech credentials and voice/language preferences for the
Discord voice bot. The server reads credentials at boot from env vars or
`~/.claude/channels/discord-voice/.env`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read all state files and give the user a complete picture:

1. **Discord token** — check `~/.claude/channels/discord/.env` for
   `DISCORD_BOT_TOKEN`. Show set/not-set; if set, show first 6 chars masked.
   This token is shared with the text Discord plugin. If missing, point the
   user to `/discord:configure <token>`.

2. **Azure Speech credentials** — check `~/.claude/channels/discord-voice/.env`
   for `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`. Show:
   - Key: set/not-set (show first 4 chars masked if set)
   - Region: the configured region (e.g. `swedencentral`)
   - If missing, explain they need an Azure Speech resource:
     *"Create one at portal.azure.com > Speech Services. Keys are under
     Resource Management > Keys and Endpoint."*

3. **Voice settings** — check for optional vars in the same `.env`:
   - `VOICE_DEFAULT_LANGUAGE` (default: `en-US`)
   - `VOICE_DEFAULT_VOICE` (default: `en-US-JennyNeural`)
   - List available English voices:
     - `en-US-JennyNeural` (female, default)
     - `en-US-GuyNeural` (male)
     - `en-US-AriaNeural` (female)
   - For other languages, see [Edge TTS voice list](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)

4. **STT usage** — if the voice server is currently running, mention that
   `voice_status` can be called to see live usage and cost tracking.

5. **What next** — end with a concrete next step:
   - No Discord token -> *"Set up the Discord bot first with `/discord:configure <token>`."*
   - No Azure credentials -> *"Run `/discord-voice:configure azure <key> <region>` to set credentials."*
   - Everything configured -> *"Ready. Use `voice_list_channels` to find a channel, then `voice_join` to connect."*

### `azure <key> <region>` — save Azure Speech credentials

1. Parse `$ARGUMENTS`: first token after "azure" is the key, second is the region.
   Common regions: `swedencentral`, `northeurope`, `westeurope`, `eastus`.
2. `mkdir -p ~/.claude/channels/discord-voice`
3. Read existing `.env` if present; update/add `AZURE_SPEECH_KEY=` and
   `AZURE_SPEECH_REGION=` lines, preserve other keys. Write back, no quotes.
4. `chmod 600 ~/.claude/channels/discord-voice/.env` — credentials are sensitive.
5. Confirm, then show the no-args status so the user sees where they stand.
6. Remind: *"Restart the voice plugin or run `/reload-plugins` for changes to take effect."*

### `language <lang>` — set default STT language

1. Parse `$ARGUMENTS`: token after "language" is the BCP-47 tag (e.g. `nb-NO`, `en-US`).
2. Read `~/.claude/channels/discord-voice/.env`, update/add `VOICE_DEFAULT_LANGUAGE=`.
3. Write back and confirm.
4. Note: *"For the current session, also call `voice_set_language` to apply immediately."*

### `voice <name>` — set default TTS voice

1. Parse `$ARGUMENTS`: token after "voice" is the voice name (e.g. `en-US-JennyNeural`).
2. Read `~/.claude/channels/discord-voice/.env`, update/add `VOICE_DEFAULT_VOICE=`.
3. Write back and confirm.
4. Note: *"For the current session, also call `voice_set_voice` to apply immediately."*

### `clear` — remove Azure credentials

Delete `AZURE_SPEECH_KEY=` and `AZURE_SPEECH_REGION=` lines from the `.env`
file. Keep other settings (`VOICE_DEFAULT_LANGUAGE`, `VOICE_DEFAULT_VOICE`).

### `stats` — show STT cost breakdown

If the voice plugin is running, call the `voice_status` tool and format the
STT usage section:
- Total audio processed (seconds)
- Estimated cost ($1/hour of audio)
- Number of transcriptions
- TTS cache hit rate

If the plugin is not running, say so and suggest joining a voice channel first.

---

## Implementation notes

- The voice `.env` dir might not exist on first run. Missing file = not
  configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session
  restart or `/reload-plugins`. Say so after saving.
- The Discord bot token is shared with the text plugin — never duplicate it
  into the voice `.env`. Point the user to `/discord:configure` for token setup.
- Azure Speech pricing: STT is ~$1/hour of audio (pay-as-you-go S0 tier).
  The voice bot uses client-side VAD to minimize audio sent to Azure.
- TTS uses the free Edge TTS endpoint (no Azure credentials needed for
  synthesis). The `voice` setting controls which neural voice is used.
- GDPR note: audio is processed by Azure Speech in the configured region.
  For EU compliance, use `swedencentral`, `northeurope`, or `westeurope`.
