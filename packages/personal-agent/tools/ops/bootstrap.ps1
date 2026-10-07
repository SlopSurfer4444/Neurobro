param(
    [Parameter(Mandatory)][string]$GitExe,
    [Parameter(Mandatory)][string]$UvExe,
    [Parameter(Mandatory)][string]$PythonExe,
    [string]$NodeExe,
    [switch]$FetchTdlib
)
$ErrorActionPreference = 'Stop'
# Opt-in repo-local dependency preparation. Never invoked by doctor or application start.
# This script does not authenticate, start a gateway, change PATH, or register a service.
$taskPackageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskRuntimeRoot = Join-Path $taskPackageRoot '.runtime'
$taskManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json
foreach ($taskExe in @($GitExe, $UvExe, $PythonExe)) {
    if (-not [IO.Path]::IsPathFullyQualified($taskExe) -or -not (Test-Path -LiteralPath $taskExe -PathType Leaf)) { throw 'absolute_existing_executable_required' }
}
if (Test-Path -LiteralPath $taskRuntimeRoot) { throw 'runtime_destination_already_exists' }
New-Item -ItemType Directory -Path $taskRuntimeRoot | Out-Null
$taskEmptyConfig = Join-Path $taskRuntimeRoot 'empty-git-config'
Set-Content -LiteralPath $taskEmptyConfig -Value '' -NoNewline
$taskGitGlobalBefore = $env:GIT_CONFIG_GLOBAL
$taskGitSystemBefore = $env:GIT_CONFIG_NOSYSTEM
$taskGitPromptBefore = $env:GIT_TERMINAL_PROMPT
$taskManagedPythonBefore = $env:UV_NO_MANAGED_PYTHON
$taskPythonDownloadsBefore = $env:UV_PYTHON_DOWNLOADS
try {
    $env:GIT_CONFIG_GLOBAL = $taskEmptyConfig
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:UV_NO_MANAGED_PYTHON = '1'
    $env:UV_PYTHON_DOWNLOADS = 'never'
    function Get-PinnedSource([string]$Name, [string]$Repository, [string]$Commit) {
        $taskSource = Join-Path $taskRuntimeRoot $Name
        & $GitExe init --quiet $taskSource
        if ($LASTEXITCODE -ne 0) { throw 'git_init_failed' }
        & $GitExe -C $taskSource remote add origin $Repository
        if ($LASTEXITCODE -ne 0) { throw 'git_remote_failed' }
        & $GitExe -C $taskSource -c credential.helper= -c core.hooksPath= fetch --quiet --depth 1 origin $Commit
        if ($LASTEXITCODE -ne 0) { throw 'git_fetch_failed' }
        & $GitExe -C $taskSource -c core.hooksPath= checkout --quiet --detach $Commit
        if ($LASTEXITCODE -ne 0) { throw 'git_checkout_failed' }
        $taskHead = (& $GitExe -C $taskSource rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $taskHead -ne $Commit) { throw 'source_commit_mismatch' }
        return $taskSource
    }
    $taskHermes = Get-PinnedSource 'hermes-agent' $taskManifest.hermes.repository $taskManifest.hermes.commit
    $taskLockHash = (Get-FileHash -LiteralPath (Join-Path $taskHermes 'uv.lock') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($taskLockHash -ne $taskManifest.hermes.lockfileSha256) { throw 'hermes_dependency_lock_mismatch' }
    & $UvExe sync --project $taskHermes --locked --no-dev --extra web --extra mcp --extra cron --python $PythonExe
    if ($LASTEXITCODE -ne 0) { throw 'hermes_repo_local_sync_failed' }
    if ($FetchTdlib) {
        $taskTdlib = Get-PinnedSource 'tdlib' $taskManifest.tdlib.repository $taskManifest.tdlib.commit
        $taskSchemaHash = (Get-FileHash -LiteralPath (Join-Path $taskTdlib 'td/generate/scheme/td_api.tl') -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($taskSchemaHash -ne $taskManifest.tdlib.schemaSha256) { throw 'tdlib_schema_hash_mismatch' }
    }
    Write-Output 'repo_local_sources_and_hermes_environment_prepared_no_service_started'
} finally {
    $env:GIT_CONFIG_GLOBAL = $taskGitGlobalBefore
    $env:GIT_CONFIG_NOSYSTEM = $taskGitSystemBefore
    $env:GIT_TERMINAL_PROMPT = $taskGitPromptBefore
    $env:UV_NO_MANAGED_PYTHON = $taskManagedPythonBefore
    $env:UV_PYTHON_DOWNLOADS = $taskPythonDownloadsBefore
}
