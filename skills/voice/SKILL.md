---
name: configure
description: Configure Discord voice bot — set the ElevenLabs API key and voice settings
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /discord-voice:configure — Voice Channel Setup

Sets up the ElevenLabs API key and voice/language preferences for the
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

2. **ElevenLabs API key** — check `~/.claude/channels/discord-voice/.env`
   for `ELEVENLABS_API_KEY`. Show set/not-set (first 4 chars masked if set).
   If missing, explain: *"Create a key at elevenlabs.io > Developers > API Keys.
   It needs access to Speech to Text and Text to Speech."*

3. **Voice settings** — check for optional vars in the same `.env`:
   - `VOICE_DEFAULT_LANGUAGE` (default: unset = detect automatically; e.g. `nb-NO`, `en-US`)
   - `VOICE_DEFAULT_VOICE` (an ElevenLabs `voice_id`; default `JBFqnCBsd6RMkjVDRZzb`)
   - `ELEVENLABS_STT_MODEL` (default `scribe_v2_realtime`) and
     `ELEVENLABS_TTS_MODEL` (default `eleven_flash_v2_5`, the lowest-latency model)
   - `VOICE_BACKCHANNEL` (optional filler such as `mm`, spoken if Claude has not
     started answering after `VOICE_BACKCHANNEL_DELAY_MS`, default 1500; off by default)
   - Voice ids come from the voice library in the user's ElevenLabs account
     (https://elevenlabs.io/app/voice-library).

4. **Usage** — if the voice server is currently running, mention that
   `voice_status` can be called to see today's STT seconds and TTS characters.

5. **What next** — end with a concrete next step:
   - No Discord token -> *"Set up the Discord bot first with `/discord:configure <token>`."*
   - No ElevenLabs key -> *"Run `/discord-voice:configure key <your-elevenlabs-key>` to set it."*
   - Everything configured -> *"Ready. Use `voice_list_channels` to find a channel, then `voice_join` to connect."*

### `key <api-key>` — save the ElevenLabs API key

1. Parse `$ARGUMENTS`: the token after "key" is the API key.
2. `mkdir -p ~/.claude/channels/discord-voice`
3. Read existing `.env` if present; update/add the `ELEVENLABS_API_KEY=` line,
   preserve other keys. Write back, no quotes.
4. `chmod 600 ~/.claude/channels/discord-voice/.env` — credentials are sensitive.
5. Confirm, then show the no-args status so the user sees where they stand.
6. Remind: *"Restart the voice plugin or run `/reload-plugins` for changes to take effect."*

### `language <lang>` — set default language

1. Parse `$ARGUMENTS`: token after "language" is the BCP-47 tag (e.g. `nb-NO`, `en-US`), or `auto` to remove the setting.
2. Read `~/.claude/channels/discord-voice/.env`, update/add `VOICE_DEFAULT_LANGUAGE=`.
3. Write back and confirm.
4. Note: *"For the current session, also call `voice_set_language` to apply immediately."*

### `voice <name>` — set default TTS voice

1. Parse `$ARGUMENTS`: token after "voice" is the ElevenLabs voice_id.
2. Read `~/.claude/channels/discord-voice/.env`, update/add `VOICE_DEFAULT_VOICE=`.
3. Write back and confirm.
4. Note: *"For the current session, also call `voice_set_voice` to apply immediately."*

### `clear` — remove the ElevenLabs API key

Delete the `ELEVENLABS_API_KEY=` line from the `.env` file. Keep other settings (`VOICE_DEFAULT_LANGUAGE`, `VOICE_DEFAULT_VOICE`).

### `stats` — show usage

If the voice plugin is running, call the `voice_status` tool and format the
usage sections:
- STT audio transcribed today (seconds) against the daily budget
- TTS characters spoken today against the daily budget
- Number of transcriptions and TTS cache hit rate

If the plugin is not running, say so and suggest joining a voice channel first.

---

## Implementation notes

- The voice `.env` dir might not exist on first run. Missing file = not
  configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session
  restart or `/reload-plugins`. Say so after saving.
- The Discord bot token is shared with the text plugin — never duplicate it
  into the voice `.env`. Point the user to `/discord:configure` for token setup.
- ElevenLabs bills speech-to-text per hour of audio and text-to-speech per
  character, at the rates of the user's plan. The plugin caps both per day
  (3600 s of audio, 50000 characters) and the client-side VAD keeps silence
  out of the STT stream.
- One key covers both directions; there is no region setting.
- Privacy note: audio and text are processed by ElevenLabs. Check the
  account's data retention settings if that matters for the user's use case.
