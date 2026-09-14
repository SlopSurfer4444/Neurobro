[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('account1', 'account2')]
    [string]$Account,

    [switch]$ReplaceSession
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $projectRoot ("config-{0}.json" -f $Account)
$npmLauncher = (Get-Command npm.cmd -ErrorAction Stop).Source
$accountNumber = if ($Account -eq 'account1') { '1' } else { '2' }

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Config not found: $configPath"
}
if (-not (Test-Path -LiteralPath $npmLauncher)) {
    throw "Machine npm launcher not found: $npmLauncher"
}

Write-Host ''
Write-Host ("=== Telegram account {0}: guarded local authorization ===" -f $accountNumber) -ForegroundColor Cyan
Write-Host 'Secrets stay in this PowerShell process and are cleared when the wizard exits.'
Write-Host 'This tool is read-only and must only access your own or explicitly authorized chats.'
Write-Host 'Telegram API Terms: https://core.telegram.org/api/terms'
Write-Host ''

$acceptance = Read-Host 'If you accept the terms, own/are authorized for the data, and will not use it for AI/ML training/development/deployment, type ACCEPT'
if ($acceptance -cne 'ACCEPT') {
    throw 'Terms/compliance confirmation was not provided. Nothing was authorized.'
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$config.compliance.ownOrAuthorizedChatsOnly = $true
$config.compliance.noAiMlTrainingDevelopmentOrDeployment = $true
$config.compliance.acceptedTelegramApiTerms = $true
$temporaryConfig = "{0}.tmp-{1}" -f $configPath, $PID
$json = $config | ConvertTo-Json -Depth 20
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($temporaryConfig, $json + [Environment]::NewLine, $utf8NoBom)
Move-Item -LiteralPath $temporaryConfig -Destination $configPath -Force

Write-Host ''
Write-Host 'A browser page will open. Sign in there with THIS account.' -ForegroundColor Yellow
Write-Host ("Create/open API development tools. Suggested app title: Guarded Archive A{0}; platform: Desktop." -f $accountNumber)
Write-Host 'Copy api_id and api_hash from that page into this terminal. Do not paste them into chat.'
Start-Process 'https://my.telegram.org/apps'

$apiId = (Read-Host ("Account {0} api_id" -f $accountNumber)).Trim()
if ($apiId -notmatch '^\d+$' -or [int64]$apiId -le 0) {
    throw 'api_id must be a positive integer.'
}

$secureApiHash = Read-Host ("Account {0} api_hash (input hidden)" -f $accountNumber) -AsSecureString
$apiHashPointer = [IntPtr]::Zero
$apiHash = $null
$apiIdEnv = [string]$config.account.apiIdEnv
$apiHashEnv = [string]$config.account.apiHashEnv

try {
    $apiHashPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiHash)
    $apiHash = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiHashPointer)
    if ($apiHash -notmatch '^[a-fA-F0-9]{32}$') {
        throw 'api_hash must contain exactly 32 hexadecimal characters.'
    }

    [Environment]::SetEnvironmentVariable($apiIdEnv, $apiId, 'Process')
    [Environment]::SetEnvironmentVariable($apiHashEnv, $apiHash, 'Process')

    Push-Location $projectRoot
    try {
        $authArguments = @('run', 'auth', '--', '--config', $configPath)
        if ($ReplaceSession) {
            $authArguments += '--replace-session'
        }
        & $npmLauncher @authArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Authorization command failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    $sessionPath = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $configPath) ([string]$config.account.sessionFile)))
    if (-not (Test-Path -LiteralPath $sessionPath)) {
        throw "Authorization returned success but the encrypted session was not found: $sessionPath"
    }
    Write-Host ''
    Write-Host ("ACCOUNT {0} LOGIN READY" -f $accountNumber) -ForegroundColor Green
    Write-Host "Encrypted session: $sessionPath"
    Write-Host 'Close this window and tell Codex: ready account 1/2.'
}
finally {
    [Environment]::SetEnvironmentVariable($apiIdEnv, $null, 'Process')
    [Environment]::SetEnvironmentVariable($apiHashEnv, $null, 'Process')
    $apiHash = $null
    if ($apiHashPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiHashPointer)
    }
    $secureApiHash = $null
}

Read-Host 'Press Enter to close this window'
