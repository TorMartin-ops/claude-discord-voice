# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
("Security" tab, "Report a vulnerability") on this repository, or email the
maintainer at Tmkohle@uia.no. Include steps to reproduce and the affected version.
You can expect an initial reply within a few days.

## Trust model

Claude Code has tool access to your machine, so anything that reaches Claude is
effectively a command. This plugin therefore enforces:

- **Only allowlisted speakers reach Claude.** The allowlist is the union of
  `VOICE_ALLOWED_USERS` (comma-separated Discord user IDs, set in
  `~/.claude/channels/discord-voice/.env`) and the `allowFrom` list in the Discord
  text plugin's `~/.claude/channels/discord/access.json`. If neither is set, every
  speaker is ignored. Audio from non-allowed users is not subscribed to, decoded,
  transcribed or sent to ElevenLabs.
- **Transcripts are untrusted input.** Display names and transcript text are
  escaped before being placed in `<channel>` tags, so they cannot forge tag
  structure. The numeric user ID is the identity; display names are informational.
- **Secrets stay local.** The Discord bot token and ElevenLabs API key are read
  from `~/.claude/channels/...` files, which the plugin sets to mode `600`. The
  ElevenLabs key is sent only in a request header, never in a URL. Known secrets
  are redacted from logs, crash logs and tool results.
- **Privacy.** Debug logging (`VOICE_DEBUG=1`) records timings and lengths only;
  `VOICE_DEBUG=2` also logs transcript text to stderr. Nothing is logged to disk
  except crash logs (redacted) and the short-lived message queue (mode `600`).

Out of scope: a malicious allowlisted user, a compromised Discord account of an
allowed user, or a compromised machine. Allowlist only people you would trust to
type commands into your terminal.
