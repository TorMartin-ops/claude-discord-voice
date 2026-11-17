# One-time setup of claude-discord-voice on Windows.
# Run in PowerShell:  powershell -ExecutionPolicy Bypass -File setup-windows.ps1
# Secrets are typed into hidden prompts and written only to %USERPROFILE%\.claude\channels\...
$ErrorActionPreference = 'Stop'

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd not found. $hint" }
}
Need git  'Install Git for Windows: https://git-scm.com/download/win'
Need node 'Install Node.js 20 or newer: https://nodejs.org'
Need npm  'npm comes with Node.js.'
Need claude 'Install Claude Code: https://code.claude.com'

function ReadSecret($prompt) {
    $s = Read-Host -Prompt $prompt -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function WriteEnv($path, [hashtable]$values) {
    $dir = Split-Path $path
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $existing = @{}
    if (Test-Path $path) {
        foreach ($line in Get-Content $path) {
            $line = $line.TrimEnd("`r")
            if ($line -match '^(\w+)=(.*)$') { $existing[$Matches[1]] = $Matches[2] }
        }
    }
    foreach ($k in $values.Keys) { if ($values[$k]) { $existing[$k] = $values[$k] } }
    # Write with LF line endings and no BOM (Set-Content would emit CRLF, leaving a stray \r in values).
    $lines = $existing.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }
    $text = (($lines -join "`n") + "`n")
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
    # Windows has no chmod: restrict the file to the current user only with icacls.
    icacls $path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

$repo = Join-Path $HOME 'discord-voice'
if (Test-Path (Join-Path $repo '.git')) {
    Write-Host "Updating $repo"
    git -C $repo pull --ff-only
} else {
    Write-Host "Cloning into $repo"
    git clone https://github.com/TorMartin-ops/claude-discord-voice.git $repo
}

Push-Location $repo
try {
    npm install
    npm run build
} finally { Pop-Location }

$channels = Join-Path $HOME '.claude\channels'
$discordEnv = Join-Path $channels 'discord\.env'
$voiceEnv = Join-Path $channels 'discord-voice\.env'

$haveToken = (Test-Path $discordEnv) -and ((Get-Content $discordEnv) -match '^DISCORD_BOT_TOKEN=.+')
if (-not $haveToken) {
    $token = ReadSecret 'Discord bot token (hidden)'
    WriteEnv $discordEnv @{ DISCORD_BOT_TOKEN = $token }
} else {
    Write-Host 'Discord bot token found in the Discord plugin config.'
}

$key = ReadSecret 'ElevenLabs API key (hidden)'
$userIds = Read-Host 'Your Discord user ID (Developer Mode > right-click yourself > Copy User ID)'
if ($userIds -notmatch '^\d{17,20}(,\d{17,20})*$') { throw "That does not look like a Discord user ID: $userIds" }

WriteEnv $voiceEnv @{
    ELEVENLABS_API_KEY     = $key
    VOICE_ALLOWED_USERS    = $userIds
    VOICE_DEFAULT_LANGUAGE = 'nb-NO'
    VOICE_DEBUG            = '1'
}

$server = Join-Path $repo 'dist\server.js'
claude mcp remove -s user discord-voice 2>$null | Out-Null
claude mcp add -s user discord-voice -- node $server

Write-Host ''
Write-Host 'Done. Start Claude Code with the voice channel enabled:' -ForegroundColor Green
Write-Host '  claude --dangerously-load-development-channels server:discord-voice'
Write-Host 'Then say: "Join my voice channel and speak Norwegian with me."'
