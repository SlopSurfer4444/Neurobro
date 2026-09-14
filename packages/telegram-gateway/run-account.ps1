[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('account1', 'account2')]
    [string]$Account,

    [Parameter(Mandatory = $true)]
    [ValidateSet('probe', 'discover', 'find-dialog', 'export-range', 'view-export', 'purge-expired')]
    [string]$Action,

    [string]$Title,
    [string]$Source,
    [string]$From,
    [string]$To = 'now',
    [string]$File
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $projectRoot ("config-{0}.json" -f $Account)
$npmLauncher = (Get-Command npm.cmd -ErrorAction Stop).Source
$connectedActions = @('probe', 'discover', 'find-dialog', 'export-range')

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Config not found: $configPath"
}
if (-not (Test-Path -LiteralPath $npmLauncher)) {
    throw "Machine npm launcher not found: $npmLauncher"
}
if ($Action -eq 'find-dialog' -and [string]::IsNullOrWhiteSpace($Title)) {
    throw '-Title is required for find-dialog.'
}
if ($Action -eq 'export-range') {
    if ([string]::IsNullOrWhiteSpace($Source)) { throw '-Source is required for export-range.' }
    if ([string]::IsNullOrWhiteSpace($From)) { throw '-From is required for export-range.' }
}
if ($Action -eq 'view-export' -and [string]::IsNullOrWhiteSpace($File)) {
    throw '-File is required for view-export.'
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$arguments = @('run', $Action, '--', '--config', $configPath)
switch ($Action) {
    'find-dialog' { $arguments += @('--title', $Title) }
    'export-range' { $arguments += @('--source', $Source, '--from', $From, '--to', $To) }
    'view-export' { $arguments += @('--file', $File) }
}

$apiHashPointer = [IntPtr]::Zero
$secureApiHash = $null
$apiHash = $null
$apiIdEnv = [string]$config.account.apiIdEnv
$apiHashEnv = [string]$config.account.apiHashEnv

try {
    if ($Action -ne 'purge-expired') {
        Push-Location $projectRoot
        try {
            & $npmLauncher @('run', 'purge-expired', '--', '--config', $configPath)
            if ($LASTEXITCODE -ne 0) {
                throw "Retention purge failed with exit code $LASTEXITCODE; requested action was not started."
            }
        }
        finally {
            Pop-Location
        }
    }

    if ($connectedActions -contains $Action) {
        Write-Host 'API credentials and passphrases stay only in this process. Hidden input will not be echoed.' -ForegroundColor Cyan
        $apiId = (Read-Host ("{0} api_id" -f $Account)).Trim()
        if ($apiId -notmatch '^\d+$' -or [int64]$apiId -le 0) {
            throw 'api_id must be a positive integer.'
        }
        $secureApiHash = Read-Host ("{0} api_hash (input hidden)" -f $Account) -AsSecureString
        $apiHashPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiHash)
        $apiHash = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiHashPointer)
        if ($apiHash -notmatch '^[a-fA-F0-9]{32}$') {
            throw 'api_hash must contain exactly 32 hexadecimal characters.'
        }
        [Environment]::SetEnvironmentVariable($apiIdEnv, $apiId, 'Process')
        [Environment]::SetEnvironmentVariable($apiHashEnv, $apiHash, 'Process')
    }

    if ($Action -eq 'view-export') {
        Write-Host 'LOCAL VIEW: decrypted text will appear only in this terminal. Do not pipe or redirect it.' -ForegroundColor Yellow
    }
    Push-Location $projectRoot
    try {
        & $npmLauncher @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Action $Action failed with exit code $LASTEXITCODE. Do not retry repeatedly."
        }
    }
    finally {
        Pop-Location
    }
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
