<#
.SYNOPSIS
  Configure and register the bundled EMQX 5.3.2 broker as a Windows service.
  Run elevated by install.ps1 (fresh) and upgrade.ps1 (every upgrade). Idempotent.

.DESCRIPTION
  Instrument ingest over MQTT needs a broker on the server, and the installer
  ships one (<InstallDir>\emqx, staged by build-installer.ps1 -EmqxZip). This
  script makes it DigiLog's broker:

    1. Secrets + bridge credential in <DataRoot>\config\digilog.env — appended
       only if ABSENT, never regenerated: MQTT_BROKER_URL, MQTT_CLIENT_ID,
       MQTT_USERNAME, MQTT_PASSWORD, EMQX_NODE_COOKIE, EMQX_DASHBOARD_PASSWORD.
       The API reads the MQTT_* keys through the same env file its service
       loads, and its auth hook admits the bridge by that credential, so ONE
       authenticator (the hook) is enough — no dashboard or API-key step.
    2. Render scripts\emqx\emqx.conf.template + acl.conf into <InstallDir>\emqx\etc
       (the stock acl.conf carries two allow-all rules and is REPLACED).
    3. Create the broker's data dir under <DataRoot>\emqx (retained slots and
       the built-in database survive upgrades there).
    4. (Re)register the Windows service through EMQX's own launcher
       (`emqx.cmd install` = erlsrv, internal service name `emqx`). The
       launcher bakes the generated config paths into the service definition
       at install time, so a config change is applied by uninstall + install,
       which is what this script always does.
    5. Start it, wait for `emqx_ctl status` to report started, set the
       dashboard admin password, open the firewall for the two MQTT ports.

  Nothing here reaches the internet. -DryRun renders the two config files into
  a temp folder and prints every privileged command without running one.

.PARAMETER InstallDir     Program dir (default C:\Program Files\DigiLog)
.PARAMETER DataRoot       Data dir   (default C:\ProgramData\DigiLog)
.PARAMETER ApiPort        The API's HTTPS port — the auth hook URL uses it
.PARAMETER MqttPort / MqttsPort / DashboardPort   1883 / 8883 / 18083
.PARAMETER EmqxRoot       Override the broker folder (tests; default <InstallDir>\emqx)
.PARAMETER DryRun         Render + print, change nothing
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\DigiLog',
  [string]$DataRoot   = 'C:\ProgramData\DigiLog',
  [int]$ApiPort = 3000,
  [int]$MqttPort = 1883,
  [int]$MqttsPort = 8883,
  [int]$DashboardPort = 18083,
  [string]$EmqxRoot,
  [string]$ServiceName = 'emqx',
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'   # native exes write progress to stderr; judge by $LASTEXITCODE
if (-not $EmqxRoot) { $EmqxRoot = Join-Path $InstallDir 'emqx' }
$emqxCmd  = Join-Path $EmqxRoot 'bin\emqx.cmd'
$emqxCtl  = Join-Path $EmqxRoot 'bin\emqx_ctl.cmd'
$etcDir   = Join-Path $EmqxRoot 'etc'
$tplDir   = Join-Path $PSScriptRoot 'emqx'
$dataDir  = Join-Path $DataRoot 'emqx'
$certDir  = Join-Path $DataRoot 'certs'
$envFile  = Join-Path $DataRoot 'config\digilog.env'

function NewSecret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}
# EMQX's dashboard password rule: 8-64 chars with at least one letter and one
# digit. 24 hex chars satisfy it in practice; the loop makes it certain.
function NewDashboardPassword {
  do { $p = NewSecret 12 } until ($p -match '[a-f]' -and $p -match '[0-9]')
  $p
}
# Forward slashes: HOCON strings would need every backslash doubled, and the
# dev box's working config uses forward slashes for exactly these paths.
function Hocon([string]$path) { $path -replace '\\', '/' }

Write-Host "DigiLog EMQX provisioning" -ForegroundColor Cyan
Write-Host "  Broker : $EmqxRoot"
Write-Host "  Data   : $dataDir"
Write-Host "  Ports  : mqtt $MqttPort, mqtts $MqttsPort, dashboard 127.0.0.1:$DashboardPort"
Write-Host "  Hook   : https://127.0.0.1:$ApiPort/api/ingest/v1/mqtt-auth"
if ($DryRun) { Write-Host "  (DRY RUN - no changes)" -ForegroundColor Yellow }
Write-Host ""

if (-not (Test-Path $emqxCmd)) {
  Write-Host "FATAL: EMQX launcher not found at $emqxCmd - the installer did not stage the broker (build-installer.ps1 -EmqxZip)." -ForegroundColor Red
  exit 1
}
foreach ($t in 'emqx.conf.template','acl.conf') {
  if (-not (Test-Path (Join-Path $tplDir $t))) { Write-Host "FATAL: template $t missing from $tplDir" -ForegroundColor Red; exit 1 }
}

# 1. Env keys — append only what is absent. install.ps1 wrote the file first
#    (fresh) or it survives from the previous version (upgrade).
if (-not (Test-Path $envFile)) { Write-Host "FATAL: $envFile not found - run after the env file is written." -ForegroundColor Red; exit 1 }
$envLines = Get-Content $envFile
function EnvGet([string]$key) {
  $line = $envLines | Where-Object { $_ -match "^\s*$([regex]::Escape($key))\s*=" } | Select-Object -First 1
  if ($line) { ($line -replace "^\s*$([regex]::Escape($key))\s*=", '').Trim() } else { $null }
}
$pending = @()
function EnvEnsure([string]$key, [string]$value) {
  $cur = EnvGet $key
  if ($cur) { return $cur }
  $script:pending += "$key=$value"
  return $value
}
$brokerUrl = EnvEnsure 'MQTT_BROKER_URL' "mqtt://127.0.0.1:$MqttPort"
$null      = EnvEnsure 'MQTT_CLIENT_ID' 'digilog-ingest-bridge'
$null      = EnvEnsure 'MQTT_USERNAME' 'digilog-bridge'
$null      = EnvEnsure 'MQTT_PASSWORD' (NewSecret 24)
$cookie    = EnvEnsure 'EMQX_NODE_COOKIE' (NewSecret 24)
$dashPw    = EnvEnsure 'EMQX_DASHBOARD_PASSWORD' (NewDashboardPassword)
if ($pending.Count -gt 0) {
  if ($DryRun) { Write-Host "[dry-run] append to $envFile : $($pending -replace '=.*','=<generated>' -join ', ')" -ForegroundColor Yellow }
  else {
    Add-Content -Path $envFile -Value $pending -Encoding ascii
    Write-Host "==> Appended $($pending.Count) key(s) to $envFile (existing keys untouched)" -ForegroundColor Cyan
  }
} else { Write-Host "==> $envFile already carries the MQTT/EMQX keys (reused)" -ForegroundColor Cyan }

# 2. Render the two config files. Every @@TOKEN@@ must be consumed - a stray one
#    means a template/script mismatch and the broker would boot on garbage.
$certFile = Join-Path $certDir 'server.crt'
$keyFile  = Join-Path $certDir 'server.key'
$caFile   = Join-Path $certDir 'rootCA.pem'
foreach ($f in $certFile, $keyFile, $caFile) {
  if (-not (Test-Path $f) -and -not $DryRun) { Write-Host "FATAL: $f missing - certs are generated by install.ps1 before this step." -ForegroundColor Red; exit 1 }
}
$aclOut  = Join-Path $etcDir 'acl.conf'
$confOut = Join-Path $etcDir 'emqx.conf'
$conf = Get-Content (Join-Path $tplDir 'emqx.conf.template') -Raw
$map = @{
  '@@NODE_COOKIE@@'    = $cookie
  '@@DATA_DIR@@'       = (Hocon $dataDir)
  '@@DASHBOARD_PORT@@' = $DashboardPort
  '@@MQTT_PORT@@'      = $MqttPort
  '@@MQTTS_PORT@@'     = $MqttsPort
  '@@CERT_FILE@@'      = (Hocon $certFile)
  '@@KEY_FILE@@'       = (Hocon $keyFile)
  '@@CA_FILE@@'        = (Hocon $caFile)
  '@@HOOK_URL@@'       = "https://127.0.0.1:$ApiPort/api/ingest/v1/mqtt-auth"
  '@@ACL_FILE@@'       = (Hocon $aclOut)
}
foreach ($k in $map.Keys) { $conf = $conf.Replace($k, [string]$map[$k]) }
$stray = [regex]::Matches($conf, '@@[A-Z_]+@@') | ForEach-Object { $_.Value } | Sort-Object -Unique
if ($stray) { Write-Host "FATAL: unrendered template token(s): $($stray -join ', ')" -ForegroundColor Red; exit 1 }
$acl = Get-Content (Join-Path $tplDir 'acl.conf') -Raw

if ($DryRun) {
  $out = Join-Path $env:TEMP 'digilog-emqx-dryrun'
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  Set-Content -Path (Join-Path $out 'emqx.conf') -Value $conf -Encoding ascii
  Set-Content -Path (Join-Path $out 'acl.conf')  -Value $acl  -Encoding ascii
  Write-Host "[dry-run] rendered emqx.conf + acl.conf to $out (would write to $etcDir)" -ForegroundColor Yellow
} else {
  foreach ($f in $confOut, $aclOut) {
    $orig = "$f.orig"
    if ((Test-Path $f) -and -not (Test-Path $orig)) { Copy-Item $f $orig }   # keep the stock file once
  }
  Set-Content -Path $confOut -Value $conf -Encoding ascii
  Set-Content -Path $aclOut  -Value $acl  -Encoding ascii
  Write-Host "==> Wrote $confOut and $aclOut (stock copies kept as *.orig)" -ForegroundColor Cyan
}

# 3. Data dir - the launcher refuses to start if node.data_dir does not exist.
if ($DryRun) { Write-Host "[dry-run] create $dataDir" -ForegroundColor Yellow }
else { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }

# 4. (Re)register the service. `emqx.cmd install` reads node.name/cookie/data_dir
#    from the rendered emqx.conf, generates the app config under <data_dir>\configs
#    and registers erlsrv with those paths - so re-rendering the config means
#    uninstall + install, every time. The launcher's own `sc config` line names
#    the internal service `emqx` (its -i flag), which is what sc.exe uses.
function Do-Cmd($desc, $exe, [string[]]$argList, [switch]$IgnoreFail) {
  if ($DryRun) { Write-Host "[dry-run] $desc" -ForegroundColor Yellow; Write-Host "          $exe $($argList -join ' ')" -ForegroundColor DarkGray; return }
  Write-Host "==> $desc" -ForegroundColor Cyan
  & $exe @argList 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -and -not $IgnoreFail) { Write-Host "FAILED: $desc (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Do-Cmd "stop $ServiceName (existing)" 'sc.exe' @('stop', $ServiceName) -IgnoreFail
  if (-not $DryRun) { Start-Sleep -Seconds 3 }
  Do-Cmd "uninstall $ServiceName (emqx.cmd uninstall)" $emqxCmd @('uninstall') -IgnoreFail
}
Do-Cmd "install $ServiceName (emqx.cmd install -> erlsrv)" $emqxCmd @('install')
Do-Cmd "set $ServiceName to auto-start" 'sc.exe' @('config', $ServiceName, 'start=', 'auto')
Do-Cmd "start $ServiceName" 'sc.exe' @('start', $ServiceName)

# 5. Wait for the node, then the dashboard password + firewall.
if (-not $DryRun) {
  $up = $false
  foreach ($i in 1..60) {
    $status = (& $emqxCtl status 2>&1 | Out-String)
    if ($status -match 'is started') { $up = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $up) { Write-Host "FATAL: EMQX did not report started within 60s. See $EmqxRoot\log and $dataDir." -ForegroundColor Red; exit 1 }
  Write-Host "==> EMQX is started" -ForegroundColor Green
  # Best effort: the dashboard is loopback-only; a failure here costs an admin
  # a shell command (`emqx_ctl admins passwd admin <pw>`), not the install.
  & $emqxCtl admins passwd admin $dashPw 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "==> Dashboard admin password set (EMQX_DASHBOARD_PASSWORD in digilog.env)" -ForegroundColor Cyan }
  else { Write-Host "WARN: could not set the dashboard admin password; run: emqx_ctl admins passwd admin <EMQX_DASHBOARD_PASSWORD>" -ForegroundColor Yellow }
  netsh advfirewall firewall delete rule name="DigiLog MQTT" 2>$null | Out-Null
  netsh advfirewall firewall add rule name="DigiLog MQTT" dir=in action=allow protocol=TCP localport="$MqttPort,$MqttsPort" | Out-Null
  Write-Host "==> Firewall: TCP $MqttPort,$MqttsPort allowed in (rule 'DigiLog MQTT')" -ForegroundColor Cyan
} else {
  Write-Host "[dry-run] wait for emqx_ctl status 'is started'; emqx_ctl admins passwd admin <EMQX_DASHBOARD_PASSWORD>; netsh add rule 'DigiLog MQTT' TCP $MqttPort,$MqttsPort" -ForegroundColor Yellow
}

Write-Host "`nEMQX provisioned. Broker $brokerUrl; devices publish on instruments/<code>/telemetry." -ForegroundColor Green
exit 0
