$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'LocalCredentials.ps1')
function Assert-Fixture { param([bool]$Condition,[string]$Reason) if(-not $Condition){throw $Reason} }
$root=Join-Path ([IO.Path]::GetTempPath()) ('neurobro-credentials-fixture-' + [Guid]::NewGuid().ToString())
$null=[IO.Directory]::CreateDirectory($root)
$profile=Join-Path $root 'profile';$null=[IO.Directory]::CreateDirectory($profile)
$configPath=Join-Path $profile 'config.json'
$marker=@{schemaVersion=1;profileId='fixture';stateDirectory=$profile}
foreach($field in @('hermesHome','telegramDatabase','telegramFiles','workspaces','artifacts','logs','temp')){$marker[$field]=Join-Path $profile $field;$null=[IO.Directory]::CreateDirectory($marker[$field])}
[IO.File]::WriteAllText((Join-Path $profile '.neurobro-profile.json'),($marker|ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $profile 'STOP'),'Synthetic stopped fixture')
[IO.File]::WriteAllText((Join-Path $marker.hermesHome 'auth.json'),'{"syntheticInitialProviderAuth":true}')
$config=@{schemaVersion=1;stateDirectory=$profile;encryptionKeyEnv='NEUROBRO_STATE_KEY';hermes=@{apiKeyEnv='NEUROBRO_HERMES_API_KEY';registrationKeyEnv='NEUROBRO_BRIDGE_REGISTRATION_KEY'};telegram=@{apiIdEnv='NEUROBRO_TG_API_ID';apiHashEnv='NEUROBRO_TG_API_HASH'}}
[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json))
$script:promptCount=0
function Read-NeurobroInteractiveCredential { param([string]$Name) $script:promptCount++;if($Name -ceq 'NEUROBRO_TG_API_ID'){return '1234567'};return '0123456789abcdef0123456789abcdef' }
$names=@('NEUROBRO_STATE_KEY','NEUROBRO_HERMES_API_KEY','NEUROBRO_BRIDGE_REGISTRATION_KEY','NEUROBRO_TG_API_ID','NEUROBRO_TG_API_HASH');$prior=@{}
foreach($name in $names){$prior[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
 $invalidReaderFailed=$false
 try{Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -CredentialReader {param($name) 'invalid-fixture'}}catch{$invalidReaderFailed=$true}
 Assert-Fixture $invalidReaderFailed 'A supplied reader must undergo API credential validation.'
 Assert-Fixture (-not [IO.File]::Exists((Join-Path $profile 'credentials/current-user.dpapi'))) 'Invalid reader values must not create a vault.'
 Assert-Fixture ($script:promptCount -eq 0) 'A supplied reader must not enter the console prompt.'
 Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -CredentialReader {param($name) Read-NeurobroInteractiveCredential $name}
 Assert-Fixture ([IO.File]::ReadAllText((Join-Path $marker.hermesHome 'auth.json')) -ceq '{"syntheticInitialProviderAuth":true}') 'Initial profile provider-auth file must remain untouched.'
 Assert-Fixture ($script:promptCount -eq 2) 'First initialization must request only two Telegram credentials.'
 $vaultPath=Join-Path $profile 'credentials/current-user.dpapi';$cipher=[IO.File]::ReadAllBytes($vaultPath)
 Assert-Fixture (-not [Text.Encoding]::UTF8.GetString($cipher).Contains('0123456789abcdef0123456789abcdef')) 'Synthetic plaintext must not occur in vault.'
 Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture
 Assert-Fixture ($script:promptCount -eq 2) 'Restart must not prompt or regenerate keys.'
 Assert-Fixture ([Convert]::ToBase64String($cipher) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($vaultPath))) 'Unchanged vault ciphertext must be preserved exactly.'
 [Environment]::SetEnvironmentVariable('NEUROBRO_TG_API_ID','previous-process-fixture','Process')
 $script:observed=$null
 Invoke-NeurobroWithCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -Action {
  param($actualConfig)
  Assert-Fixture ($actualConfig -ceq $configPath) 'Action receives only config path.'
  Assert-Fixture ($env:NEUROBRO_TG_API_ID -ceq '1234567') 'Process import must load exact API ID.'
  Assert-Fixture ($env:NEUROBRO_TG_API_HASH -ceq '0123456789abcdef0123456789abcdef') 'Process import must load exact hash.'
  Assert-Fixture ([Convert]::FromBase64String($env:NEUROBRO_STATE_KEY).Length -eq 32) 'State key must be exactly 32 bytes.'
  $script:observed=@($env:NEUROBRO_STATE_KEY,$env:NEUROBRO_HERMES_API_KEY,$env:NEUROBRO_BRIDGE_REGISTRATION_KEY)
 }
 Assert-Fixture ($env:NEUROBRO_TG_API_ID -ceq 'previous-process-fixture') 'Original process environment must be restored.'
 $failed=$false
 try{Invoke-NeurobroWithCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -Action {throw '0123456789abcdef0123456789abcdef'}}catch{$failed=$true;Assert-Fixture (-not $_.Exception.Message.Contains('0123456789abcdef0123456789abcdef')) 'Action diagnostics must suppress secret-bearing errors.'}
 Assert-Fixture $failed 'Action failure must propagate.'
 Assert-Fixture ($env:NEUROBRO_TG_API_ID -ceq 'previous-process-fixture') 'Failure must restore original environment.'
 Invoke-NeurobroWithCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -Action {Assert-Fixture (@($env:NEUROBRO_STATE_KEY,$env:NEUROBRO_HERMES_API_KEY,$env:NEUROBRO_BRIDGE_REGISTRATION_KEY) -join ',' -ceq ($script:observed -join ',')) 'Generated keys must survive restart unchanged.'}
 $failed=$false;try{Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId wrong}catch{$failed=$true};Assert-Fixture $failed 'Wrong expected marker must fail closed.'
 $alias=Join-Path $root 'alias';$null=New-Item -ItemType Junction -Path $alias -Target $profile
 $failed=$false;try{Initialize-NeurobroCredentials -ProfilePath $alias -ConfigPath $configPath -ProfileId fixture}catch{$failed=$true};Assert-Fixture $failed 'Real disk junction must fail before mutation.'
 [IO.Directory]::Delete($alias)
 $binding=Get-NeurobroCredentialBinding $profile $configPath fixture;Assert-NeurobroCredentialAcl $vaultPath $binding
 $config.encryptionKeyEnv='PATH';[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json));$failed=$false;try{Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture}catch{$failed=$true};Assert-Fixture $failed 'Unknown or system environment names must be rejected.'
 $config.encryptionKeyEnv='NEUROBRO_STATE_KEY';[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json))
 $record=Read-NeurobroCredentialVault $binding;$record.Values.Remove('NEUROBRO_TG_API_ID');Write-NeurobroCredentialVault $binding $record.Values $record.Cipher
 Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture;Assert-Fixture ($script:promptCount -eq 3) 'Partial vault must prompt only for the absent API credential.'
 Invoke-NeurobroWithCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -Action {Assert-Fixture (@($env:NEUROBRO_STATE_KEY,$env:NEUROBRO_HERMES_API_KEY,$env:NEUROBRO_BRIDGE_REGISTRATION_KEY) -join ',' -ceq ($script:observed -join ',')) 'CAS completion must preserve every existing generated key.'}
 $record=Read-NeurobroCredentialVault $binding;$before=[Convert]::ToBase64String($record.Cipher);$wrong=[byte[]]$record.Cipher.Clone();$wrong[0]=$wrong[0] -bxor 1;$failed=$false
 try{Write-NeurobroCredentialVault $binding $record.Values $wrong}catch{$failed=$true};Assert-Fixture $failed 'Wrong expected ciphertext must fail CAS.'
 Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($vaultPath)) -ceq $before) 'Failed CAS must preserve vault bytes.'
 Assert-Fixture (@(Get-ChildItem -LiteralPath (Join-Path $profile 'credentials') -Filter '*.pending').Count -eq 0) 'Failed CAS must remove only its ciphertext temporary file.'
 $record.Values.Clear()
 foreach($generatedName in $names[0..2]){
  $complete=Read-NeurobroCredentialVault $binding;$partial=@{};foreach($n in $complete.Values.Keys){if($n -cne $generatedName){$partial[$n]=$complete.Values[$n]}}
  Write-NeurobroCredentialVault $binding $partial $complete.Cipher;$partialCipher=[IO.File]::ReadAllBytes($vaultPath);$prompts=$script:promptCount;$failed=$false
  try{Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture}catch{$failed=$true};Assert-Fixture $failed 'Existing vault missing a generated key must require recovery.'
  Assert-Fixture ($script:promptCount -eq $prompts) 'Recovery refusal must occur before any prompt.'
  Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($vaultPath)) -ceq [Convert]::ToBase64String($partialCipher)) 'Missing generated key must not replace existing ciphertext.'
  Write-NeurobroCredentialVault $binding $complete.Values $partialCipher;$complete.Values.Clear();$partial.Clear()
 }
 foreach($blocker in @('service.lock','broker.lock','telegram.lock','hermes.lock','.ops.lock','.lease-transition','.neurobro-reconciliation-required.json')){
  $path=Join-Path $profile $blocker;[IO.File]::WriteAllText($path,'Synthetic unsettled custody');$before=[Convert]::ToBase64String([IO.File]::ReadAllBytes($vaultPath));$prompts=$script:promptCount;$failed=$false
  try{Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture}catch{$failed=$true};Assert-Fixture $failed 'Live lease/operations/reconciliation marker must block initialization.'
  Assert-Fixture ($script:promptCount -eq $prompts) 'Unsettled profile must not prompt.';Assert-Fixture ([IO.File]::ReadAllText($path) -ceq 'Synthetic unsettled custody') 'Existing custody marker must remain unchanged.'
  Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($vaultPath)) -ceq $before) 'Unsettled profile must preserve ciphertext.'
  Invoke-NeurobroWithCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -Action {Assert-Fixture ($env:NEUROBRO_TG_API_ID -ceq '1234567') 'Existing vault import remains usable during launch custody.'}
  [IO.File]::Delete($path)
 }
 $savedVault=Join-Path $profile 'fixture-vault.dpapi';[IO.File]::Move($vaultPath,$savedVault)
 foreach($runtimePath in @((Join-Path $profile 'broker.sqlite'),(Join-Path $marker.telegramDatabase 'td.binlog'))){
  [IO.File]::WriteAllText($runtimePath,'Synthetic durable runtime state');$prompts=$script:promptCount;$failed=$false
  try{Initialize-NeurobroCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture}catch{$failed=$true};Assert-Fixture $failed 'Missing vault over existing durable state must require recovery.'
  Assert-Fixture ($script:promptCount -eq $prompts) 'Missing vault recovery must not prompt.';Assert-Fixture (-not [IO.File]::Exists($vaultPath)) 'Missing vault must not regenerate a new state key.'
  Assert-Fixture ([IO.File]::ReadAllText($runtimePath) -ceq 'Synthetic durable runtime state') 'Durable state must remain unchanged.';[IO.File]::Delete($runtimePath)
 }
 [IO.File]::Move($savedVault,$vaultPath)
 Assert-Fixture (-not [IO.File]::Exists((Join-Path $profile '.ops.lock')) -and -not [IO.File]::Exists((Join-Path $profile '.lease-transition'))) 'Owned initialization guards must be cleaned after success and failure.'
 $cipher=[IO.File]::ReadAllBytes($vaultPath);$cipher[0]=$cipher[0] -bxor 1;[IO.File]::WriteAllBytes($vaultPath,$cipher);$failed=$false;try{Invoke-NeurobroWithCredentials -ProfilePath $profile -ConfigPath $configPath -ProfileId fixture -Action {throw 'must not execute'}}catch{$failed=$true};Assert-Fixture $failed 'Corrupt DPAPI vault must fail closed.'
 Write-Output 'PASS: synthetic DPAPI/ACL, atomic CAS, environment restore, missing-key/state refusal, custody gates, corruption and junction rejection.'
}finally{
 foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name],'Process')}
 $script:observed=$null
 $expected=[IO.Path]::GetFullPath($root);if(-not $expected.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($expected) -notlike 'neurobro-credentials-fixture-*'){throw 'Fixture cleanup escaped temp root.'}
 Remove-Item -LiteralPath $expected -Recurse -Force
}
