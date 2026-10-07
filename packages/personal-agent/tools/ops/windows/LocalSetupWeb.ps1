# Run this bounded helper with powershell.exe -NoProfile -NonInteractive -File.
# The launcher owns hidden-process startup. Only safe receipts and DPAPI ciphertext
# are persisted; request bodies, credentials, and the CSRF token stay in memory.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProfilePath,
    [Parameter(Mandatory)][string]$ConfigPath,
    [string]$ProfileId='owner-v1',
    [ValidateRange(1024,65535)][int]$Port=18761
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'LocalCredentials.ps1')

function Send-SetupResponse {
    param($Context,[int]$Status,[string]$Html)
    $response=$Context.Response
    $response.StatusCode=$Status; $response.ContentType='text/html; charset=utf-8'
    $response.Headers['Cache-Control']='no-store, max-age=0'
    $response.Headers['Pragma']='no-cache'
    $response.Headers['Content-Security-Policy']="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    $response.Headers['X-Frame-Options']='DENY'
    $response.Headers['X-Content-Type-Options']='nosniff'
    # Browser form POSTs retain their same-origin Origin under this policy.
    # no-referrer makes that Origin opaque ("null") and breaks the strict gate.
    $response.Headers['Referrer-Policy']='same-origin'
    $bytes=[Text.Encoding]::UTF8.GetBytes($Html); $response.ContentLength64=$bytes.Length
    try { $response.OutputStream.Write($bytes,0,$bytes.Length) } finally { $response.Close() }
}

function Write-SetupReceipt {
    param([string]$Path,[hashtable]$Receipt)
    $null=Assert-NeurobroCredentialPath $Path
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Receipt|ConvertTo-Json -Compress))
    $stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
}

$listener=$null; $submitted=$null; $token=$null; $context=$null; $readyPath=$null
try {
    $binding=Get-NeurobroCredentialBinding $ProfilePath $ConfigPath $ProfileId
    Assert-NeurobroCredentialInitializationAllowed $binding -RequireFreshState:(-not [IO.File]::Exists($binding.Vault))
    # This form initializes a fresh vault. Existing ciphertext requires an explicit
    # recovery route, rather than silently ignoring newly pasted values.
    if ([IO.File]::Exists($binding.Vault)) { throw 'Credential vault already exists.' }
    $readyPath=Assert-NeurobroCredentialPath ([IO.Path]::Combine($binding.Profile,'local-setup-web-ready.json'))
    $resultPath=Assert-NeurobroCredentialPath ([IO.Path]::Combine($binding.Profile,'local-setup-web-result.json'))
    if ([IO.File]::Exists($readyPath) -or [IO.File]::Exists($resultPath)) { throw 'A prior setup receipt exists.' }
    $authority='127.0.0.1:'+$Port; $origin='http://'+$authority; $url=$origin+'/'
    $tokenBytes=[byte[]]::new(32);$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($tokenBytes);$token=([BitConverter]::ToString($tokenBytes)).Replace('-','').ToLowerInvariant() }
    finally { $rng.Dispose();[Array]::Clear($tokenBytes,0,$tokenBytes.Length) }
    $form=@"
<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Telegram API — Neurobro</title>
<style>body{font:17px system-ui;background:white;color:#111827;max-width:560px;margin:60px auto;padding:24px}label{display:block;margin-top:24px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;margin-top:8px;border-radius:8px;border:1px solid #9ca3af}button{background:#2563eb;color:white;cursor:pointer}p{line-height:1.5;color:#475569}</style>
<h1>Telegram API</h1><p>Вставьте api_id и api_hash. Они сохранятся локально в защищённом хранилище Windows для этого профиля.</p>
<form method="post" action="/save" autocomplete="off"><input type="hidden" name="csrf" value="$token">
<label>api_id<input name="api_id" inputmode="numeric" pattern="[1-9][0-9]{0,9}" maxlength="10" required autocomplete="off"></label>
<label>api_hash<input name="api_hash" type="password" pattern="[a-fA-F0-9]{32}" minlength="32" maxlength="32" required autocomplete="off" spellcheck="false"></label>
<button type="submit">Сохранить</button></form><p>После сохранения вернитесь в Codex.</p></html>
"@
    $listener=[Net.HttpListener]::new();$listener.Prefixes.Add($url);$listener.Start()
    $deadline=[DateTime]::UtcNow.AddMinutes(15)
    Write-SetupReceipt $readyPath @{schemaVersion=1;profileId=$ProfileId;pid=$PID;url=$url;expiresAt=$deadline.ToString('o');credentialsReady=$false}
    while ([DateTime]::UtcNow -lt $deadline) {
        $pending=$listener.BeginGetContext($null,$null)
        if (-not $pending.AsyncWaitHandle.WaitOne([int][Math]::Max(1,($deadline-[DateTime]::UtcNow).TotalMilliseconds))) { break }
        $context=$listener.EndGetContext($pending);$request=$context.Request
        if (-not [Net.IPAddress]::IsLoopback($request.RemoteEndPoint.Address) -or $request.Headers['Host'] -cne $authority) {
            $context.Response.Headers['X-Neurobro-Rejection']='host'
            Send-SetupResponse $context 403 '<h1>Request rejected</h1>'; $context=$null;continue
        }
        if ($request.HttpMethod -ceq 'GET' -and $request.RawUrl -ceq '/') {
            Send-SetupResponse $context 200 $form; $context=$null;continue
        }
        if ($request.HttpMethod -cne 'POST' -or $request.RawUrl -cne '/save') {
            Send-SetupResponse $context 404 '<h1>Page unavailable</h1>'; $context=$null;continue
        }
        if ($request.Headers['Origin'] -cne $origin) {
            $context.Response.Headers['X-Neurobro-Rejection']='origin'
            Send-SetupResponse $context 403 '<h1>Request rejected</h1>'; $context=$null;continue
        }
        if ($request.ContentType -notmatch '^application/x-www-form-urlencoded(?:;\s*charset=UTF-8)?$' -or $request.ContentLength64 -lt 1 -or $request.ContentLength64 -gt 2048 -or $request.Headers['Transfer-Encoding']) {
            $context.Response.Headers['X-Neurobro-Rejection']='envelope'
            Send-SetupResponse $context 403 '<h1>Request rejected</h1>'; $context=$null;continue
        }
        $bodyBytes=[byte[]]::new([int]$request.ContentLength64);$offset=0;$readFailed=$false
        try {
            while ($offset -lt $bodyBytes.Length) {
                $read=$request.InputStream.ReadAsync($bodyBytes,$offset,$bodyBytes.Length-$offset)
                if (-not $read.Wait(5000) -or $read.Result -eq 0) { $readFailed=$true;break }
                $offset+=$read.Result
            }
            if ($readFailed) { Send-SetupResponse $context 408 '<h1>Request timed out</h1>'; $context=$null;continue }
            $body=[Text.UTF8Encoding]::new($false,$true).GetString($bodyBytes)
            $submitted=@{};$invalid=$false
            foreach ($pair in $body.Split('&')) {
                $parts=$pair.Split([char[]]'=',2)
                if ($parts.Length -ne 2 -or $parts[0] -cnotin @('csrf','api_id','api_hash') -or $submitted.ContainsKey($parts[0]) -or $parts[1] -match '%(?![a-fA-F0-9]{2})') { $invalid=$true;break }
                $submitted[$parts[0]]=[Uri]::UnescapeDataString($parts[1].Replace('+',' '))
            }
            $body=$null
            if ($invalid -or $submitted.Count -ne 3 -or $submitted.csrf -cne $token) {
                $context.Response.Headers['X-Neurobro-Rejection']='csrf'
                Send-SetupResponse $context 403 '<h1>Request rejected</h1>'; $context=$null;continue
            }
            if ($submitted.api_id -notmatch '^[1-9][0-9]{0,9}$' -or [long]$submitted.api_id -gt 2147483647 -or $submitted.api_hash -notmatch '^[a-fA-F0-9]{32}$') {
                Send-SetupResponse $context 400 '<h1>Invalid API ID or API hash</h1><p>Return to the form and check both values.</p>'; $context=$null;continue
            }
            $apiId=$submitted.api_id;$apiHash=$submitted.api_hash
            $reader={param([string]$Name) if ($Name -ceq 'NEUROBRO_TG_API_ID') {return $apiId};if ($Name -ceq 'NEUROBRO_TG_API_HASH') {return $apiHash};throw 'Unexpected credential name.'}.GetNewClosure()
            Initialize-NeurobroCredentials -ProfilePath $binding.Profile -ConfigPath $binding.Config -ProfileId $ProfileId -CredentialReader $reader
            $vault=Read-NeurobroCredentialVault $binding
            try { if ($vault.Values.Count -ne 5 -or $vault.Values.NEUROBRO_TG_API_ID -cne $apiId -or $vault.Values.NEUROBRO_TG_API_HASH -cne $apiHash) { throw 'Credential readback failed.' } }
            finally { if ($vault) {$vault.Values.Clear()};$vault=$null }
            Write-SetupReceipt $resultPath @{schemaVersion=1;profileId=$ProfileId;pid=$PID;credentialsReady=$true;completedAt=[DateTime]::UtcNow.ToString('o')}
            Send-SetupResponse $context 200 '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Сохранено</title><h1>Сохранено</h1><p>Telegram API сохранён в защищённом хранилище Windows. Вернитесь в Codex.</p></html>'
            $context=$null;break
        } finally { [Array]::Clear($bodyBytes,0,$bodyBytes.Length);$body=$null;if ($submitted) {$submitted.Clear()};$submitted=$null;$apiId=$null;$apiHash=$null;$reader=$null }
    }
} catch {
    if ($context) { try { Send-SetupResponse $context 500 '<h1>Setup stopped</h1><p>Return to Codex.</p>' } catch {} }
    # Never propagate request/parser/credential exceptions containing input.
    throw 'Local Neurobro setup stopped; no credential values are included in diagnostics.'
} finally {
    if ($listener) { $listener.Close() };$token=$null;$form=$null
}
