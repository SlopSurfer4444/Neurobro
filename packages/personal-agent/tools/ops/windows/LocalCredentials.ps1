# Dot-source this file. No action, environment mutation, or prompt runs on import.
# Windows DPAPI CurrentUser vault: ciphertext only on disk; secrets enter the
# current process environment only while Invoke-NeurobroWithCredentials runs.

function Assert-NeurobroCredentialPath {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.Contains([char]0)) { throw 'Credential path must be absolute.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -match '^\\\\' -or $full.Substring([IO.Path]::GetPathRoot($full).Length).Contains(':')) { throw 'UNC and alternate-stream credential paths are forbidden.' }
    $cursor = $full
    while ($cursor) {
        try { $attributes = [IO.File]::GetAttributes($cursor) }
        catch [IO.FileNotFoundException] { $attributes = 0 }
        catch [IO.DirectoryNotFoundException] { $attributes = 0 }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Credential path contains a reparse point.' }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
    return $full
}

function Get-NeurobroCredentialBinding {
    param([Parameter(Mandatory)][string]$ProfilePath,[Parameter(Mandatory)][string]$ConfigPath,[Parameter(Mandatory)][string]$ProfileId)
    if ($env:OS -ne 'Windows_NT') { throw 'DPAPI credentials require Windows.' }
    $profile = Assert-NeurobroCredentialPath $ProfilePath
    if ($profile.TrimEnd('\','/') -eq [IO.Path]::GetPathRoot($profile).TrimEnd('\','/') -or $profile -match '(?i)(?:^|[\\/])(?:\.hermes|\.codex|\.ssh|Neurobro)(?:[\\/]|$)|hermes-likeavto-pilot|telegram-standing-build') { throw 'Historical or filesystem-root profiles are forbidden.' }
    if ($ProfileId -notmatch '^[a-zA-Z0-9_-]{1,80}$') { throw 'Invalid expected profile identifier.' }
    $markerPath = Assert-NeurobroCredentialPath ([IO.Path]::Combine($profile,'.neurobro-profile.json'))
    if (-not [IO.File]::Exists($markerPath) -or (Get-Item -LiteralPath $markerPath).Length -gt 65536) { throw 'Exact isolated profile marker is required.' }
    $marker = [IO.File]::ReadAllText($markerPath) | ConvertFrom-Json
    if ($marker.schemaVersion -ne 1 -or $marker.profileId -cne $ProfileId -or -not [string]::Equals([IO.Path]::GetFullPath($marker.stateDirectory),$profile,[StringComparison]::OrdinalIgnoreCase)) { throw 'Profile marker binding does not match.' }
    foreach ($field in @('hermesHome','telegramDatabase','telegramFiles','workspaces','artifacts','logs','temp')) {
        $child = Assert-NeurobroCredentialPath ([string]$marker.$field)
        if (-not $child.StartsWith($profile.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Profile marker path escapes the profile.' }
    }
    $configFile = Assert-NeurobroCredentialPath $ConfigPath
    if (-not [IO.File]::Exists($configFile) -or (Get-Item -LiteralPath $configFile).Length -gt 1048576) { throw 'Configuration file is missing or exceeds limits.' }
    $config = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
    if ($config.schemaVersion -ne 1 -or -not [string]::Equals([IO.Path]::GetFullPath($config.stateDirectory),$profile,[StringComparison]::OrdinalIgnoreCase)) { throw 'Configuration is not bound to this profile.' }
    $names = @('NEUROBRO_STATE_KEY','NEUROBRO_HERMES_API_KEY','NEUROBRO_BRIDGE_REGISTRATION_KEY','NEUROBRO_TG_API_ID','NEUROBRO_TG_API_HASH')
    if ($config.encryptionKeyEnv -cne $names[0] -or $config.hermes.apiKeyEnv -cne $names[1] -or $config.hermes.registrationKeyEnv -cne $names[2] -or $config.telegram.apiIdEnv -cne $names[3] -or $config.telegram.apiHashEnv -cne $names[4]) { throw 'Only the exact Neurobro credential environment names are allowed.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    return @{ Profile=$profile; Config=$configFile; ProfileId=$ProfileId; Sid=$sid; Names=$names; Marker=$marker; Directory=[IO.Path]::Combine($profile,'credentials'); Vault=[IO.Path]::Combine($profile,'credentials','current-user.dpapi') }
}

function Assert-NeurobroCredentialInitializationAllowed {
    param($Binding,[switch]$RequireFreshState,[switch]$OwnsTransition)
    $stop = Assert-NeurobroCredentialPath ([IO.Path]::Combine($Binding.Profile,'STOP'))
    if (-not [IO.File]::Exists($stop)) { throw 'Credential initialization requires a stopped profile.' }
    foreach ($name in @('service.lock','broker.lock','telegram.lock','hermes.lock','.ops.lock','.lease-transition','.neurobro-reconciliation-required.json')) {
        if ($OwnsTransition -and $name -ceq '.lease-transition') { continue }
        $path = Assert-NeurobroCredentialPath ([IO.Path]::Combine($Binding.Profile,$name))
        if ([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) { throw 'Credential initialization requires settled profile custody.' }
    }
    if (-not $RequireFreshState) { return }
    # Check only known durable roots within this profile, never external roots or
    # provider-auth/config/plugin files prepared before first initialization.
    foreach ($root in @($Binding.Profile,$Binding.Marker.hermesHome)) {
        foreach ($path in [IO.Directory]::EnumerateFiles($root)) {
            $name=[IO.Path]::GetFileName($path)
            if ($name -match '(?i)\.(?:sqlite|db)(?:$|[-.])|^service-abandoned-.*\.json$') { throw 'Missing vault over durable runtime state requires recovery, not new keys.' }
        }
    }
    $roots=@($Binding.Marker.telegramDatabase,$Binding.Marker.telegramFiles,$Binding.Marker.workspaces,$Binding.Marker.artifacts)
    foreach ($name in @('archive','incoming','computer-home')) { $roots += [IO.Path]::Combine($Binding.Profile,$name) }
    foreach ($name in @('sessions','memories','cron','state','logs')) { $roots += [IO.Path]::Combine($Binding.Marker.hermesHome,$name) }
    foreach ($path in $roots) {
        $path=Assert-NeurobroCredentialPath $path
        if ([IO.Directory]::Exists($path) -and @([IO.Directory]::EnumerateFileSystemEntries($path)).Count -gt 0) { throw 'Missing vault over durable runtime state requires recovery, not new keys.' }
    }
    $telegram=Assert-NeurobroCredentialPath ([IO.Path]::Combine($Binding.Profile,'telegram'))
    if ([IO.Directory]::Exists($telegram) -and @([IO.Directory]::EnumerateFiles($telegram)).Count -gt 0) { throw 'Missing vault over Telegram journal requires recovery, not new keys.' }
}

function Set-NeurobroCredentialAcl {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$Owner,[switch]$Directory)
    $null = Assert-NeurobroCredentialPath $Path
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    if ($Directory) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else { $acl = [Security.AccessControl.FileSecurity]::new(); $inherit = [Security.AccessControl.InheritanceFlags]::None }
    $acl.SetOwner($Owner); $acl.SetAccessRuleProtection($true,$false)
    foreach ($identity in @($Owner,$system)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Get-NeurobroCredentialEntropy {
    param($Binding)
    return [Text.Encoding]::UTF8.GetBytes(('neurobro-dpapi-v1|' + $Binding.Profile.ToLowerInvariant() + '|' + $Binding.ProfileId + '|' + $Binding.Sid.Value))
}

function Assert-NeurobroCredentialAcl {
    param([Parameter(Mandatory)][string]$Path,$Binding)
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Binding.Sid.Value) { throw 'Credential vault ACL or owner is invalid.' }
    $rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    if ($rules.Count -ne 2) { throw 'Credential vault ACL is not restricted to owner and SYSTEM.' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -cnotin @($Binding.Sid.Value,'S-1-5-18') -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Credential vault ACL grants unexpected access.' }
    }
}

function Read-NeurobroCredentialVault {
    param($Binding)
    $null = Assert-NeurobroCredentialPath $Binding.Vault
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    if (-not [IO.File]::Exists($Binding.Vault)) { return $null }
    if ((Get-Item -LiteralPath $Binding.Vault).Length -gt 65536) { throw 'Credential vault exceeds limits.' }
    Assert-NeurobroCredentialAcl $Binding.Vault $Binding
    $cipher = [IO.File]::ReadAllBytes($Binding.Vault); $plain = $null
    try {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher,(Get-NeurobroCredentialEntropy $Binding),[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $record = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
        if ($record.schemaVersion -ne 1 -or $record.profileId -cne $Binding.ProfileId -or $record.ownerSid -cne $Binding.Sid.Value -or -not [string]::Equals($record.stateDirectory,$Binding.Profile,[StringComparison]::OrdinalIgnoreCase)) { throw 'Credential vault binding is invalid.' }
        $values = @{}
        foreach ($property in $record.values.PSObject.Properties) {
            if ($Binding.Names -cnotcontains $property.Name -or $property.Value -isnot [string] -or [string]::IsNullOrEmpty($property.Value) -or $property.Value -match '[\r\n\x00]') { throw 'Credential vault contains a forbidden name or value.' }
            $values[$property.Name] = $property.Value
        }
        foreach ($name in $Binding.Names) {
            if (-not $values.ContainsKey($name)) { continue }
            $value=$values[$name]
            if ($name -ceq 'NEUROBRO_TG_API_ID') { if ($value -notmatch '^[1-9][0-9]{0,9}$' -or [long]$value -gt 2147483647) { throw 'Invalid vault API ID.' } }
            elseif ($name -ceq 'NEUROBRO_TG_API_HASH') { if ($value -notmatch '^[a-fA-F0-9]{32}$') { throw 'Invalid vault API hash.' } }
            elseif ($value -notmatch '^[a-zA-Z0-9+/]{43}=$' -or [Convert]::FromBase64String($value).Length -ne 32) { throw 'Invalid generated credential encoding.' }
        }
        return @{ Values=$values; Cipher=$cipher }
    } finally { if ($plain) { [Array]::Clear($plain,0,$plain.Length) } }
}

function New-NeurobroRandomCredential {
    $bytes = [byte[]]::new(32); $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes); return [Convert]::ToBase64String($bytes) }
    finally { $rng.Dispose(); [Array]::Clear($bytes,0,$bytes.Length) }
}

function Read-NeurobroInteractiveCredential {
    param([Parameter(Mandatory)][string]$Name)
    $prompt = if ($Name -ceq 'NEUROBRO_TG_API_ID') { 'Telegram API ID (hidden input)' } else { 'Telegram API hash (hidden input)' }
    $secure = Read-Host -Prompt $prompt -AsSecureString; $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
        $value = [Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
        if (($Name -ceq 'NEUROBRO_TG_API_ID' -and ($value -notmatch '^[1-9][0-9]{0,9}$' -or [long]$value -gt 2147483647)) -or ($Name -ceq 'NEUROBRO_TG_API_HASH' -and $value -notmatch '^[a-fA-F0-9]{32}$')) { throw 'Telegram API credential format is invalid.' }
        return $value
    } finally { if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer) }; $secure.Dispose() }
}

function Write-NeurobroCredentialVault {
    param($Binding,[hashtable]$Values,[AllowNull()][byte[]]$ExpectedCipher)
    $record = @{schemaVersion=1;profileId=$Binding.ProfileId;stateDirectory=$Binding.Profile;ownerSid=$Binding.Sid.Value;values=$Values}
    $plain = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 5 -Compress)); $temporary = [IO.Path]::Combine($Binding.Directory,[Guid]::NewGuid().ToString() + '.pending')
    try {
        $cipher = [Security.Cryptography.ProtectedData]::Protect($plain,(Get-NeurobroCredentialEntropy $Binding),[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $null = Assert-NeurobroCredentialPath $temporary
        $stream = [IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Write($cipher,0,$cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Set-NeurobroCredentialAcl -Path $temporary -Owner $Binding.Sid
        $null = Assert-NeurobroCredentialPath $Binding.Vault
        if ($null -eq $ExpectedCipher) {
            if ([IO.File]::Exists($Binding.Vault)) { throw 'Credential vault changed before creation.' }
            [IO.File]::Move($temporary,$Binding.Vault)
        } else {
            if (-not [IO.File]::Exists($Binding.Vault) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($Binding.Vault)) -cne [Convert]::ToBase64String($ExpectedCipher)) { throw 'Credential vault changed before replacement.' }
            [IO.File]::Replace($temporary,$Binding.Vault,[System.Management.Automation.Language.NullString]::Value)
        }
        Set-NeurobroCredentialAcl -Path $Binding.Vault -Owner $Binding.Sid
    } finally {
        [Array]::Clear($plain,0,$plain.Length)
        $null = Assert-NeurobroCredentialPath $Binding.Directory
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Initialize-NeurobroCredentials {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProfilePath,[Parameter(Mandatory)][string]$ConfigPath,[string]$ProfileId='owner-v1',[scriptblock]$CredentialReader)
    $lock = $null; $values = $null; $transition = $null; $operations = $null
    try {
        $binding = Get-NeurobroCredentialBinding $ProfilePath $ConfigPath $ProfileId
        Assert-NeurobroCredentialInitializationAllowed $binding -RequireFreshState:(-not [IO.File]::Exists($binding.Vault))
        $transitionPath=[IO.Path]::Combine($binding.Profile,'.lease-transition')
        $transition=[IO.FileStream]::new($transitionPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        Assert-NeurobroCredentialInitializationAllowed $binding -OwnsTransition -RequireFreshState:(-not [IO.File]::Exists($binding.Vault))
        $operationsPath=[IO.Path]::Combine($binding.Profile,'.ops.lock')
        $operations=[IO.FileStream]::new($operationsPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $null = Assert-NeurobroCredentialPath $binding.Directory
        $null = [IO.Directory]::CreateDirectory($binding.Directory)
        Set-NeurobroCredentialAcl -Path $binding.Directory -Owner $binding.Sid -Directory
        $lockPath = [IO.Path]::Combine($binding.Directory,'credentials.lock'); $null = Assert-NeurobroCredentialPath $lockPath
        $lock = [IO.FileStream]::new($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $prior = Read-NeurobroCredentialVault $binding; $values = if ($null -eq $prior) { @{} } else { $prior.Values }; $changed=$false
        if ($null -ne $prior) {
            foreach ($name in $binding.Names[0..2]) { if (-not $values.ContainsKey($name)) { throw 'Existing vault is missing generated keys; explicit recovery is required.' } }
        }
        foreach ($name in $binding.Names) {
            if (-not $values.ContainsKey($name)) {
                if ($name -ceq 'NEUROBRO_TG_API_ID' -or $name -ceq 'NEUROBRO_TG_API_HASH') {
                    $value = if ($CredentialReader) { & $CredentialReader $name } else { Read-NeurobroInteractiveCredential $name }
                    if ($value -isnot [string] -or ($name -ceq 'NEUROBRO_TG_API_ID' -and ($value -notmatch '^[1-9][0-9]{0,9}$' -or [long]$value -gt 2147483647)) -or ($name -ceq 'NEUROBRO_TG_API_HASH' -and $value -notmatch '^[a-fA-F0-9]{32}$')) { throw 'Telegram API credential format is invalid.' }
                    $values[$name] = $value; $value = $null
                } else { $values[$name] = New-NeurobroRandomCredential }
                $changed=$true
            }
        }
        if ($changed) { $expected = if ($null -eq $prior) { $null } else { $prior.Cipher }; Write-NeurobroCredentialVault $binding $values $expected }
        else { Set-NeurobroCredentialAcl -Path $binding.Vault -Owner $binding.Sid }
    } catch { throw 'Neurobro credential initialization failed; no credential values are included in diagnostics.' }
    finally {
        if ($lock) { $lock.Dispose() }; if ($null -ne $values) { $values.Clear() }
        if ($operations) { $operations.Dispose(); $null=Assert-NeurobroCredentialPath $operationsPath; [IO.File]::Delete($operationsPath) }
        if ($transition) { $transition.Dispose(); $null=Assert-NeurobroCredentialPath $transitionPath; [IO.File]::Delete($transitionPath) }
    }
}

function Invoke-NeurobroWithCredentials {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProfilePath,[Parameter(Mandatory)][string]$ConfigPath,[string]$ProfileId='owner-v1',[Parameter(Mandatory)][scriptblock]$Action)
    $saved = @{}; $values = $null
    try {
        $binding = Get-NeurobroCredentialBinding $ProfilePath $ConfigPath $ProfileId
        $vault = Read-NeurobroCredentialVault $binding
        if ($null -eq $vault -or $vault.Values.Count -ne $binding.Names.Count) { throw 'Credential vault is incomplete; initialize it first.' }
        $values = $vault.Values
        foreach ($name in $binding.Names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,[EnvironmentVariableTarget]::Process) }
        foreach ($name in $binding.Names) { [Environment]::SetEnvironmentVariable($name,$values[$name],[EnvironmentVariableTarget]::Process) }
        & $Action $binding.Config
    } catch { throw 'Neurobro credential action failed; no credential values are included in diagnostics.' }
    finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],[EnvironmentVariableTarget]::Process) }
        if ($values) { $values.Clear() }
    }
}
