param([switch]$BrowserSubmission,[ValidateRange(1024,65535)][int]$BrowserPort=18762)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'LocalCredentials.ps1')
function Assert-WebFixture {param([bool]$Condition,[string]$Reason) if(-not $Condition){throw $Reason}}
$root=Join-Path ([IO.Path]::GetTempPath()) ('neurobro-web-fixture-'+[Guid]::NewGuid().ToString())
$profile=Join-Path $root 'profile';$null=[IO.Directory]::CreateDirectory($profile)
$configPath=Join-Path $profile 'config.json';$marker=@{schemaVersion=1;profileId='webfixture';stateDirectory=$profile}
foreach($field in @('hermesHome','telegramDatabase','telegramFiles','workspaces','artifacts','logs','temp')){$marker[$field]=Join-Path $profile $field;$null=[IO.Directory]::CreateDirectory($marker[$field])}
[IO.File]::WriteAllText((Join-Path $profile '.neurobro-profile.json'),($marker|ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $profile 'STOP'),'Synthetic stopped fixture')
[IO.File]::WriteAllText($configPath,(@{schemaVersion=1;stateDirectory=$profile;encryptionKeyEnv='NEUROBRO_STATE_KEY';hermes=@{apiKeyEnv='NEUROBRO_HERMES_API_KEY';registrationKeyEnv='NEUROBRO_BRIDGE_REGISTRATION_KEY'};telegram=@{apiIdEnv='NEUROBRO_TG_API_ID';apiHashEnv='NEUROBRO_TG_API_HASH'}}|ConvertTo-Json))
$portProbe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$portProbe.Start();$port=$portProbe.LocalEndpoint.Port;$portProbe.Stop()
if($BrowserSubmission){$port=$BrowserPort}
$url='http://127.0.0.1:'+$port
$process=$null
function Invoke-FixtureRequest {
 param([string]$Method,[string]$Path,[string]$Body,[string]$Origin,[string]$HostOverride)
 $request=[Net.HttpWebRequest]::Create($url+$Path);$request.Method=$Method;$request.Timeout=5000;$request.AllowAutoRedirect=$false
 if($HostOverride){$request.Host=$HostOverride}
 if($Origin){$request.Headers['Origin']=$Origin}
 if($Method -ceq 'POST'){$request.ContentType='application/x-www-form-urlencoded';$bytes=[Text.Encoding]::UTF8.GetBytes($Body);$request.ContentLength=$bytes.Length;$stream=$request.GetRequestStream();try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}
 try{$response=$request.GetResponse()}catch [Net.WebException]{if(-not $_.Exception.Response){throw};$response=$_.Exception.Response}
 try{$reader=[IO.StreamReader]::new($response.GetResponseStream());try{$text=$reader.ReadToEnd()}finally{$reader.Dispose()};return @{Status=[int]$response.StatusCode;Text=$text;Cache=$response.Headers['Cache-Control'];Csp=$response.Headers['Content-Security-Policy'];ReferrerPolicy=$response.Headers['Referrer-Policy'];Rejection=$response.Headers['X-Neurobro-Rejection']}}finally{$response.Dispose()}
}
try {
 $scriptPath=Join-Path $PSScriptRoot 'LocalSetupWeb.ps1';$out=Join-Path $root 'stdout.txt';$err=Join-Path $root 'stderr.txt'
 $shellName=if($PSVersionTable.PSEdition -eq 'Core'){'pwsh.exe'}else{'powershell.exe'}
 $process=Start-Process -FilePath (Join-Path $PSHOME $shellName) -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$scriptPath+'"'),'-ProfilePath',('"'+$profile+'"'),'-ConfigPath',('"'+$configPath+'"'),'-ProfileId','webfixture','-Port',$port) -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
 $null=$process.Handle
 $ready=Join-Path $profile 'local-setup-web-ready.json';$deadline=[DateTime]::UtcNow.AddSeconds(20)
 while(-not [IO.File]::Exists($ready) -and [DateTime]::UtcNow -lt $deadline -and -not $process.HasExited){Start-Sleep -Milliseconds 100;$process.Refresh()}
 Assert-WebFixture ([IO.File]::Exists($ready)) 'Listener readiness missing.'
 $get=Invoke-FixtureRequest GET '/' '' '' '';Assert-WebFixture ($get.Status -eq 200) 'Loopback form must load.'
 Assert-WebFixture ($get.Cache.Contains('no-store') -and $get.Csp.Contains("frame-ancestors 'none'")) 'Form needs no-store and frame-denying CSP.'
 Assert-WebFixture ($get.ReferrerPolicy -ceq 'same-origin') 'A normal browser form must retain its Origin under same-origin referrer policy.'
 $token=[regex]::Match($get.Text,'name="csrf" value="([a-f0-9]{64})"').Groups[1].Value
 Assert-WebFixture ($token.Length -eq 64) 'Form must carry a random 256-bit CSRF token.'
 Assert-WebFixture ((Invoke-FixtureRequest GET '/' '' '' 'evil.invalid').Status -eq 403) 'Unexpected Host must fail.'
 $hash='0123456789abcdef0123456789abcdef';$valid='csrf='+$token+'&api_id=1234567&api_hash='+$hash
 Assert-WebFixture ((Invoke-FixtureRequest POST '/save' $valid 'https://evil.invalid' '').Status -eq 403) 'Cross-origin POST must fail.'
 $opaqueOrigin=Invoke-FixtureRequest POST '/save' $valid 'null' ''
 Assert-WebFixture ($opaqueOrigin.Status -eq 403 -and $opaqueOrigin.Rejection -ceq 'origin') 'An opaque browser Origin must remain rejected with a safe reason enum.'
 $csrfResponse=Invoke-FixtureRequest POST '/save' ('csrf=wrong&api_id=1234567&api_hash='+$hash) $url ''
 Assert-WebFixture ($csrfResponse.Status -eq 403) ('Wrong CSRF must fail; status '+$csrfResponse.Status)
 Assert-WebFixture ((Invoke-FixtureRequest POST '/save' ('csrf='+$token+'&api_id=0&api_hash='+$hash) $url '').Status -eq 400) 'Invalid API credentials must fail.'
 $vaultPath=Join-Path $profile 'credentials/current-user.dpapi';Assert-WebFixture (-not [IO.File]::Exists($vaultPath)) 'Rejected requests must not persist credentials.'
 if($BrowserSubmission){
  Write-Output ('BROWSER_FIXTURE_READY url='+$url+'/ profile='+$profile+' pid='+$process.Id+'; submit fake api_id=1234567 and api_hash=0123456789abcdef0123456789abcdef using the normal form.')
  $browserDeadline=[DateTime]::UtcNow.AddMinutes(5)
  while(-not $process.WaitForExit(1000) -and [DateTime]::UtcNow -lt $browserDeadline){}
 }else{
  $save=Invoke-FixtureRequest POST '/save' $valid $url '';Assert-WebFixture ($save.Status -eq 200 -and -not $save.Text.Contains($hash)) 'One valid submission must save without reflecting input.'
 }
 Assert-WebFixture ($process.WaitForExit(5000)) 'Successful setup must stop accepting submissions.'
 Assert-WebFixture ($process.ExitCode -eq 0) ('Setup process failed: '+[IO.File]::ReadAllText($err))
 $result=[IO.File]::ReadAllText((Join-Path $profile 'local-setup-web-result.json'))|ConvertFrom-Json
 Assert-WebFixture ($result.credentialsReady -eq $true) 'Result receipt must prove completed credential readback.'
 $binding=Get-NeurobroCredentialBinding $profile $configPath webfixture;$vault=Read-NeurobroCredentialVault $binding
 try { Assert-WebFixture ($vault.Values.Count -eq 5 -and $vault.Values.NEUROBRO_TG_API_ID -ceq '1234567' -and $vault.Values.NEUROBRO_TG_API_HASH -ceq $hash) 'DPAPI must roundtrip submitted credentials and generated keys.' }finally{$vault.Values.Clear()}
 foreach($file in [IO.Directory]::EnumerateFiles($root,'*',[IO.SearchOption]::AllDirectories)){
  $contents=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($file));Assert-WebFixture (-not $contents.Contains($hash) -and -not $contents.Contains($token)) 'Secrets and CSRF token must not occur in any persisted fixture file.'
 }
 Assert-WebFixture ([IO.File]::Exists((Join-Path $profile 'STOP'))) 'Credential setup must preserve the stopped profile.'
 $transport=if($BrowserSubmission){'real browser form'}else{'synthetic HTTP'}
 Write-Output ('PASS: '+$transport+', same-origin Referrer-Policy, exact Host/Origin, CSRF, invalid-input refusal, one DPAPI save/readback, process exit and no persisted plaintext.')
} finally {
 if($process){$process.Refresh();if(-not $process.HasExited){$process.Kill();$process.WaitForExit(5000)|Out-Null};$process.Dispose()}
 $full=[IO.Path]::GetFullPath($root);if(-not $full.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($full) -notlike 'neurobro-web-fixture-*'){throw 'Fixture cleanup escaped temp root.'}
 Remove-Item -LiteralPath $full -Recurse -Force
}
