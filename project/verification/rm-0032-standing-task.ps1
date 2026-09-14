[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ManifestSha256,

    [ValidateSet('Prepare', 'Install', 'Update')]
    [string]$Mode = 'Prepare',

    [ValidatePattern('^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')]
    [string]$RecoveryStartUtc
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'DecadansNeurobroStandingV1'
$BuildRoot = 'C:\Neurobro\build'
$StandingHostPath = Join-Path -Path $BuildRoot -ChildPath 'standing-host.mjs'
$NodePath = 'C:\Program Files\DecadansNeurobro\node.exe'
$BackgroundLauncherPath = 'C:\Program Files\Neurobro\NeurobroBackground.exe'
$TaskNamespace = 'http://schemas.microsoft.com/windows/2004/02/mit/task'
$RestartInterval = 'PT1M'
$RestartCount = '3'
$PrepareDeadlineMilliseconds = 120000
$PrepareSettlementMilliseconds = 5000
$PrepareMarker = "STANDING_PREPARED`n"

function Stop-OwnedPrepareChild {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process
    )

    try {
        if ($Process.HasExited) {
            return
        }
        $Process.Kill()
        if (-not $Process.WaitForExit($PrepareSettlementMilliseconds)) {
            throw 'STANDING_PREPARE_SETTLEMENT_REFUSED'
        }
    }
    catch {
        throw 'STANDING_PREPARE_SETTLEMENT_REFUSED'
    }
}

function Invoke-StandingHostPrepare {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodePath
    $startInfo.Arguments = '"' + $StandingHostPath + '" --prepare ' + $ManifestSha256
    $startInfo.WorkingDirectory = $BuildRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables.Clear()
    $startInfo.EnvironmentVariables['SystemRoot'] = 'C:\Windows'
    $startInfo.EnvironmentVariables['WINDIR'] = 'C:\Windows'
    $startInfo.EnvironmentVariables['PATH'] = 'C:\Windows\System32'
    $startInfo.EnvironmentVariables['LOCALAPPDATA'] = [Environment]::GetFolderPath('LocalApplicationData')
    $startInfo.EnvironmentVariables['USERPROFILE'] = [Environment]::GetFolderPath('UserProfile')

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $started = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::new()
    try {
        if (-not $process.Start()) {
            throw 'STANDING_PREPARE_START_REFUSED'
        }
        $started = $true
        $stopwatch.Start()

        # Drain stderr without retaining it. The host contract exposes only its
        # fixed stdout marker and exit status to this installer.
        $stderrDrain = $process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
        $stdout = [System.IO.MemoryStream]::new()
        $buffer = [byte[]]::new(32)
        $maximumStdoutBytes = [System.Text.Encoding]::UTF8.GetByteCount($PrepareMarker)
        try {
            while ($true) {
                $read = $process.StandardOutput.BaseStream.ReadAsync($buffer, 0, $buffer.Length)
                while (-not $read.Wait(50)) {
                    if ($stopwatch.ElapsedMilliseconds -ge $PrepareDeadlineMilliseconds) {
                        throw 'STANDING_PREPARE_TIMEOUT'
                    }
                }

                if ($read.Result -eq 0) {
                    break
                }
                if (($stdout.Length + $read.Result) -gt $maximumStdoutBytes) {
                    throw 'STANDING_PREPARE_PROTOCOL_REFUSED'
                }
                $stdout.Write($buffer, 0, $read.Result)
            }

            $remaining = $PrepareDeadlineMilliseconds - [int]$stopwatch.ElapsedMilliseconds
            if ($remaining -le 0 -or -not $process.WaitForExit($remaining)) {
                throw 'STANDING_PREPARE_TIMEOUT'
            }
            $remaining = $PrepareDeadlineMilliseconds - [int]$stopwatch.ElapsedMilliseconds
            if ($remaining -le 0 -or -not $stderrDrain.Wait($remaining)) {
                throw 'STANDING_PREPARE_TIMEOUT'
            }
            $stderrDrain.GetAwaiter().GetResult() | Out-Null

            $stdoutText = [System.Text.Encoding]::UTF8.GetString($stdout.ToArray())
            if ($process.ExitCode -ne 0 -or $stdoutText -cne $PrepareMarker) {
                throw 'STANDING_PREPARE_PROTOCOL_REFUSED'
            }
        }
        finally {
            $stdout.Dispose()
        }
    }
    catch {
        $failureCode = $_.Exception.Message
        if ($started) {
            try {
                Stop-OwnedPrepareChild -Process $process
            }
            catch {
                throw 'STANDING_PREPARE_SETTLEMENT_REFUSED'
            }
        }
        if ($failureCode -cin @(
            'STANDING_PREPARE_START_REFUSED',
            'STANDING_PREPARE_TIMEOUT',
            'STANDING_PREPARE_PROTOCOL_REFUSED',
            'STANDING_PREPARE_SETTLEMENT_REFUSED'
        )) {
            throw $failureCode
        }
        throw 'STANDING_PREPARE_REFUSED'
    }
    finally {
        $stopwatch.Stop()
        $process.Dispose()
    }
}

function ConvertTo-XmlText {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    return [System.Security.SecurityElement]::Escape($Value)
}

function New-StandingTaskXml {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CurrentUserSid,

        [Parameter(Mandatory = $true)]
        [string]$ActionArguments
    )

    $sidXml = ConvertTo-XmlText -Value $CurrentUserSid
    $commandXml = ConvertTo-XmlText -Value $BackgroundLauncherPath
    $argumentsXml = ConvertTo-XmlText -Value $ActionArguments
    $workingDirectoryXml = ConvertTo-XmlText -Value $BuildRoot

    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="$TaskNamespace">
  <RegistrationInfo>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$sidXml</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="CurrentUser">
      <UserId>$sidXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>$RestartInterval</Interval>
      <Count>$RestartCount</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="CurrentUser">
    <Exec>
      <Command>$commandXml</Command>
      <Arguments>$argumentsXml</Arguments>
      <WorkingDirectory>$workingDirectoryXml</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Get-RootTaskOrNull {
    param(
        [Parameter(Mandatory = $true)]
        [object]$RootFolder
    )

    try {
        return $RootFolder.GetTask($TaskName)
    }
    catch {
        if ($_.Exception.HResult -eq -2147024894) {
            return $null
        }
        throw
    }
}

function Assert-TaskXmlValue {
    param(
        [Parameter(Mandatory = $true)]
        [xml]$Document,

        [Parameter(Mandatory = $true)]
        [System.Xml.XmlNamespaceManager]$NamespaceManager,

        [Parameter(Mandatory = $true)]
        [string]$XPath,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Expected,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $node = $Document.SelectSingleNode($XPath, $NamespaceManager)
    $actual = if ($node -is [System.Xml.XmlAttribute]) { $node.Value } elseif ($null -ne $node) { $node.InnerText } else { $null }
    if ($null -eq $node -or $actual -cne $Expected) {
        throw "Scheduled task readback refused: $Label did not match."
    }
}

function Assert-TaskXmlNodeCount {
    param(
        [Parameter(Mandatory = $true)]
        [xml]$Document,

        [Parameter(Mandatory = $true)]
        [System.Xml.XmlNamespaceManager]$NamespaceManager,

        [Parameter(Mandatory = $true)]
        [string]$XPath,

        [Parameter(Mandatory = $true)]
        [int]$Expected,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $nodes = $Document.SelectNodes($XPath, $NamespaceManager)
    if ($null -eq $nodes -or $nodes.Count -ne $Expected) {
        throw "Scheduled task readback refused: $Label cardinality did not match."
    }
}

function Resolve-StandingTaskSid {
    param([Parameter(Mandatory=$true)][string]$Value)
    if ($Value -match '^S-1-') { return [Security.Principal.SecurityIdentifier]::new($Value).Value }
    return [Security.Principal.NTAccount]::new($Value).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Assert-RecoveryStart {
    param([Parameter(Mandatory=$true)][string]$Value)
    $parsed = [DateTimeOffset]::ParseExact($Value, "yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($parsed.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") -cne $Value) { throw 'STANDING_TASK_START_REFUSED' }
}

function Get-StandingTaskAction {
    # The GUI-subsystem launcher owns environment isolation and the windowless
    # node child. A console-subsystem PowerShell action can create Terminal even
    # with -WindowStyle Hidden.
    return '"' + $BuildRoot + '" ' + $ManifestSha256
}

function New-RecoveryTriggerXml {
    param([Parameter(Mandatory=$true)][string]$StartUtc)
    Assert-RecoveryStart $StartUtc
    # Microsoft RepetitionPattern.Duration: omitted means indefinite.
    # Keep StartBoundary/Enabled/Repetition/ExecutionTimeLimit schema order.
    return @"
<TimeTrigger id="StandingRecovery">
  <StartBoundary>$StartUtc</StartBoundary>
  <Enabled>true</Enabled>
  <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
  <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
</TimeTrigger>
"@
}

function Add-RecoveryTrigger {
    param([xml]$Document, [string]$StartUtc)
    [xml]$fragment = New-RecoveryTriggerXml $StartUtc
    $ns=[Xml.XmlNamespaceManager]::new($Document.NameTable);$ns.AddNamespace('t',$TaskNamespace)
    $target=$Document.SelectSingleNode('/t:Task/t:Triggers',$ns)
    # Parse in the Task Scheduler namespace before importing the new node.
    [xml]$wrapped='<Triggers xmlns="'+$TaskNamespace+'">'+$fragment.DocumentElement.OuterXml+'</Triggers>'
    $null=$target.AppendChild($Document.ImportNode($wrapped.DocumentElement.FirstChild,$true))
}

function Assert-OwnedStandingTaskXml {
    param([xml]$readback, [string]$currentUserSid, [string]$actionArguments, [string]$StartUtc, [switch]$RequireRecovery)
    $namespaces = [System.Xml.XmlNamespaceManager]::new($readback.NameTable)
    $namespaces.AddNamespace('t', $TaskNamespace)

    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Triggers' 1 'trigger collection'
    $triggerCount = $readback.SelectNodes('/t:Task/t:Triggers/*', $namespaces).Count
    if ($triggerCount -notin @(1,2)) { throw 'STANDING_TASK_TRIGGER_COUNT_REFUSED' }
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Triggers/t:TimeTrigger' ($triggerCount - 1) 'recovery trigger'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Triggers/t:LogonTrigger' 1 'logon trigger'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Principals' 1 'principal collection'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Principals/*' 1 'principal'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Principals/t:Principal' 1 'current-user principal'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Actions' 1 'action collection'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Actions/*' 1 'action'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Actions/t:Exec' 1 'exec action'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:RegistrationInfo/t:URI' "\$TaskName" 'task URI'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Triggers/t:LogonTrigger/t:Enabled' 'true' 'logon trigger state'
    $triggerUser = $readback.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger/t:UserId', $namespaces).InnerText
    if ((Resolve-StandingTaskSid $triggerUser) -cne $currentUserSid) { throw 'STANDING_TASK_TRIGGER_IDENTITY_REFUSED' }
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Principals/t:Principal/@id' 'CurrentUser' 'principal identity'
    $principalUser = $readback.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId', $namespaces).InnerText
    if ((Resolve-StandingTaskSid $principalUser) -cne $currentUserSid) { throw 'STANDING_TASK_PRINCIPAL_REFUSED' }
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Principals/t:Principal/t:LogonType' 'InteractiveToken' 'principal logon type'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Principals/t:Principal/t:RunLevel' 'LeastPrivilege' 'principal run level'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:MultipleInstancesPolicy' 'IgnoreNew' 'multiple instances policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:AllowHardTerminate' 'true' 'hard termination policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:StartWhenAvailable' 'true' 'missed start policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:AllowStartOnDemand' 'true' 'manual start policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:Enabled' 'true' 'task state'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:Hidden' 'true' 'task visibility'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:WakeToRun' 'false' 'wake policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:ExecutionTimeLimit' 'PT0S' 'execution time limit'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:RestartOnFailure/t:Interval' $RestartInterval 'restart interval'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:RestartOnFailure/t:Count' $RestartCount 'restart count'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:DisallowStartIfOnBatteries' 'false' 'battery start policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:StopIfGoingOnBatteries' 'false' 'battery stop policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:RunOnlyIfNetworkAvailable' 'false' 'network condition'
    $idle=$readback.SelectNodes('/t:Task/t:Settings/t:RunOnlyIfIdle',$namespaces)
    if ($idle.Count -gt 1 -or ($idle.Count -eq 1 -and $idle[0].InnerText -cne 'false')) { throw 'STANDING_TASK_IDLE_REFUSED' }
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:IdleSettings/t:StopOnIdleEnd' 'false' 'idle stop policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Settings/t:IdleSettings/t:RestartOnIdle' 'false' 'idle restart policy'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Actions/@Context' 'CurrentUser' 'action principal context'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Actions/t:Exec/t:Command' $BackgroundLauncherPath 'action command'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Actions/t:Exec/t:Arguments' $actionArguments 'action arguments'
    Assert-TaskXmlValue $readback $namespaces '/t:Task/t:Actions/t:Exec/t:WorkingDirectory' $BuildRoot 'action working directory'

    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Triggers/t:LogonTrigger/t:Repetition' 0 'logon repetition'
    Assert-TaskXmlNodeCount $readback $namespaces '/t:Task/t:Triggers/t:LogonTrigger/t:EndBoundary' 0 'logon end'
    if ($RequireRecovery -and $triggerCount -ne 2) { throw 'STANDING_TASK_RECOVERY_MISSING' }
    if ($triggerCount -eq 2) {
        Assert-RecoveryStart $StartUtc
        $path='/t:Task/t:Triggers/t:TimeTrigger'
        Assert-TaskXmlValue $readback $namespaces ($path+'/@id') 'StandingRecovery' 'recovery identity'
        $actualStart=$readback.SelectSingleNode(($path+'/t:StartBoundary'),$namespaces)
        if ($null -eq $actualStart -or [DateTimeOffset]::Parse($actualStart.InnerText) -ne [DateTimeOffset]::Parse($StartUtc)) { throw 'STANDING_TASK_START_MISMATCH' }
        Assert-TaskXmlValue $readback $namespaces ($path+'/t:Enabled') 'true' 'recovery enabled'
        Assert-TaskXmlValue $readback $namespaces ($path+'/t:ExecutionTimeLimit') 'PT0S' 'recovery runtime'
        Assert-TaskXmlValue $readback $namespaces ($path+'/t:Repetition/t:Interval') 'PT1M' 'recovery interval'
        Assert-TaskXmlValue $readback $namespaces ($path+'/t:Repetition/t:StopAtDurationEnd') 'false' 'recovery no forced stop'
        Assert-TaskXmlNodeCount $readback $namespaces ($path+'/t:Repetition') 1 'recovery repetition'
        Assert-TaskXmlNodeCount $readback $namespaces ($path+'/t:Repetition/t:Duration') 0 'indefinite recovery'
        Assert-TaskXmlNodeCount $readback $namespaces ($path+'/t:EndBoundary') 0 'recovery end'
        $jitter=$readback.SelectNodes(($path+'/t:RandomDelay'),$namespaces)
        if ($jitter.Count -gt 1 -or ($jitter.Count -eq 1 -and $jitter[0].InnerText -cne 'PT0S')) { throw 'STANDING_TASK_JITTER_REFUSED' }
    }
    return ($triggerCount -eq 2)
}

function Set-StandingTask {
    param([object]$RootFolder, [string]$CurrentUserSid, [ValidateSet('Install','Update')][string]$Operation, [string]$StartUtc)
    Assert-RecoveryStart $StartUtc
    $actionArguments=Get-StandingTaskAction
    $existing=Get-RootTaskOrNull $RootFolder
    if ($Operation -eq 'Install') {
        if ($null -ne $existing) { throw 'STANDING_TASK_ALREADY_EXISTS' }
        [xml]$document=New-StandingTaskXml $CurrentUserSid $actionArguments
        $flag=2
    } else {
        if ($null -eq $existing) { throw 'STANDING_TASK_MISSING' }
        $priorXml=$existing.Definition.XmlText
        [xml]$document=$priorXml
        $already=Assert-OwnedStandingTaskXml $document $CurrentUserSid $actionArguments $StartUtc
        if ($already) { return [pscustomobject]@{changed=$false;recoveryVerified=$true} }
        $flag=4
    }
    Add-RecoveryTrigger $document $StartUtc
    $null=Assert-OwnedStandingTaskXml $document $CurrentUserSid $actionArguments $StartUtc -RequireRecovery
    # Require a future boundary; replaying an already-installed
    # identical configuration above remains idempotent after this date passes.
    if ([DateTimeOffset]::Parse($StartUtc) -le [DateTimeOffset]::UtcNow.AddSeconds(15)) { throw 'STANDING_TASK_START_TOO_SOON' }
    if ($Operation -eq 'Update') {
        $fresh=Get-RootTaskOrNull $RootFolder
        if ($null -eq $fresh -or $fresh.Definition.XmlText -cne $priorXml) { throw 'STANDING_TASK_CHANGED' }
    }
    $registered=$RootFolder.RegisterTask($TaskName,$document.OuterXml,$flag,$CurrentUserSid,$null,3,$null)
    if ($null -eq $registered) { throw 'STANDING_TASK_REGISTRATION_REFUSED' }
    [xml]$effective=$RootFolder.GetTask($TaskName).Definition.XmlText
    $null=Assert-OwnedStandingTaskXml $effective $CurrentUserSid $actionArguments $StartUtc -RequireRecovery
    return [pscustomobject]@{changed=$true;recoveryVerified=$true}
}

Invoke-StandingHostPrepare
$change=[pscustomobject]@{changed=$false;recoveryVerified=$false}
if ($Mode -in @('Install','Update')) {
    try {
        if ([string]::IsNullOrEmpty($RecoveryStartUtc)) { throw 'STANDING_TASK_START_REQUIRED' }
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity.User) { throw 'STANDING_TASK_IDENTITY_REFUSED' }
        $service=New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $change=Set-StandingTask $service.GetFolder('\') $identity.User.Value $Mode $RecoveryStartUtc
    } catch { throw 'STANDING_TASK_CONFIGURATION_REFUSED' }
}
[ordered]@{
    schema='decadans-neurobro-standing-task-result-v2';mode=$Mode.ToLowerInvariant();hostPrepared=$true
    taskChanged=$change.changed;recoveryVerified=$change.recoveryVerified;taskStarted=$false
    taskName=$TaskName;buildRoot=$BuildRoot;manifestSha256=$ManifestSha256;recoveryStartUtc=$RecoveryStartUtc
    recoveryInterval='PT1M';recoveryDuration='indefinite';multipleInstances='IgnoreNew'
    executionTimeLimit='PT0S';principal='current-user';runLevel='LeastPrivilege';logonType='InteractiveToken'
} | ConvertTo-Json -Compress
