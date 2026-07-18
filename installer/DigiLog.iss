; DigiLog - Inno Setup installer definition
; Builds a customer-facing Setup.exe that installs DigiLog + a private bundled
; PostgreSQL as auto-starting Windows services, with no prerequisites.
; See tasks/EXE-PACKAGING-PLAN.md (M5).
;
; Compile with Inno Setup 6:   ISCC.exe /DStageDir=<staging> /DAppVersion=1.0.0 installer\DigiLog.iss
; The staging dir is produced by scripts/build-installer.ps1 and must contain:
;   runtime\   pgsql\   service\   scripts\
;
; NOTE: this .iss is authored + reviewed here, but COMPILING it to Setup.exe
; requires Inno Setup on a build machine, and TEST-INSTALLING requires admin.
; Those two steps run on the build/customer machine, not in this repo.

#ifndef StageDir
  #define StageDir "..\dist\stage"
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{8F3B2C71-1A4D-4E9A-9C2B-DIGILOG000001}
AppName=DigiLog
AppVersion={#AppVersion}
AppPublisher=Controlytics
DefaultDirName={autopf}\DigiLog
DefaultGroupName=DigiLog
DisableProgramGroupPage=yes
UninstallDisplayName=DigiLog
UninstallDisplayIcon={app}\runtime\api\dist\app.js
OutputBaseFilename=DigiLog-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupLogging=yes

[Files]
; Program payload -> {app}. Split so upgrades handle running processes correctly:
;  - pgsql (bundled PostgreSQL binaries): onlyifdoesntexist. On upgrade the DB
;    service stays RUNNING (postgres.exe would be locked), and we WANT it up so
;    upgrade.ps1 can pg_dump a live backup before migrating. Skipping the copy on
;    upgrade both avoids the file lock and preserves the working PG binaries.
;    (A future PostgreSQL binary bump is a special, out-of-band migration.)
;  - runtime + service + scripts: ignoreversion (replaced every upgrade). These
;    are freed by stopping DigiLogAPI in PrepareToInstall() BEFORE this copy runs.
Source: "{#StageDir}\pgsql\*";   DestDir: "{app}\pgsql";   Flags: recursesubdirs createallsubdirs onlyifdoesntexist
Source: "{#StageDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StageDir}\service\*"; DestDir: "{app}\service"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StageDir}\scripts\*"; DestDir: "{app}\scripts"; Flags: recursesubdirs createallsubdirs ignoreversion

[Dirs]
; Data root - survives upgrades + uninstall. Created here so ACLs are set early.
Name: "{commonappdata}\DigiLog"; Permissions: service-modify
Name: "{commonappdata}\DigiLog\db"
Name: "{commonappdata}\DigiLog\uploads"
Name: "{commonappdata}\DigiLog\logs"
Name: "{commonappdata}\DigiLog\config"

[Icons]
; Start-menu + desktop shortcut open the app in the default browser.
Name: "{group}\DigiLog"; Filename: "{app}\DigiLog.url"
Name: "{group}\Uninstall DigiLog"; Filename: "{uninstallexe}"
Name: "{commondesktop}\DigiLog"; Filename: "{app}\DigiLog.url"; Tasks: desktopicon
Name: "{group}\Install tablet certificate (rootCA.pem)"; Filename: "{commonappdata}\DigiLog\certs"; Comment: "Copy rootCA.pem to the tablet and install it under Settings > Security > Install certificate"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Run]
; -ExecutionPolicy Bypass is required because the bundled scripts are unsigned; the
; installer already runs elevated and the scripts are shipped read-only under {app}.
;
; FRESH install: generate secrets, provision Postgres, register services, health check.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install.ps1"" -InstallDir ""{app}"" -AdminPassword ""{code:GetAdminPassword}"""; \
  StatusMsg: "Setting up the DigiLog database and services (this can take a minute)..."; \
  Flags: runhidden waituntilterminated; Check: not IsUpgrade
;
; UPGRADE: pre-upgrade DB backup, forward-only migrate deploy, reseed, restart API.
; Preserves all data + secrets in C:\ProgramData\DigiLog.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\upgrade.ps1"" -InstallDir ""{app}"" -Version ""{#AppVersion}"""; \
  StatusMsg: "Backing up and upgrading the DigiLog database (this can take a minute)..."; \
  Flags: runhidden waituntilterminated; Check: IsUpgrade

[UninstallRun]
; Pre-uninstall: stop + remove services. Data is preserved (see uninstall.ps1).
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall.ps1"" -InstallDir ""{app}"""; \
  RunOnceId: "DigiLogServices"; Flags: runhidden waituntilterminated

[Code]
var
  AdminPage: TInputQueryWizardPage;
  IsUpgradeFlag: Boolean;

{ An install is an UPGRADE iff the data-root env file already exists. That file
  holds the generated secrets + DB connection and only ever exists after a prior
  successful install; it lives in ProgramData and survives program replacement. }
function IsUpgrade: Boolean;
begin
  Result := IsUpgradeFlag;
end;

procedure InitializeWizard;
begin
  IsUpgradeFlag := FileExists(ExpandConstant('{commonappdata}\DigiLog\config\digilog.env'));
  AdminPage := CreateInputQueryPage(wpSelectDir,
    'Initial administrator password',
    'Set the password for the built-in ''superadmin'' account.',
    'You will be required to change it on first login. Minimum 8 characters.');
  AdminPage.Add('Initial admin password:', True);  { True = password (masked) }
end;

{ Skip the admin-password page on upgrade: the superadmin already exists and its
  password is never touched (the seed upsert preserves it). }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if IsUpgradeFlag and (PageID = AdminPage.ID) then
    Result := True;
end;

function GetAdminPassword(Param: string): string;
begin
  Result := AdminPage.Values[0];
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (not IsUpgradeFlag) and (CurPageID = AdminPage.ID) then
  begin
    if Length(AdminPage.Values[0]) < 8 then
    begin
      MsgBox('The admin password must be at least 8 characters.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

{ Runs BEFORE the [Files] copy. On upgrade, stop the API service so its running
  node.exe + WinSW service exe are unlocked and can be overwritten. The DB service
  is deliberately LEFT RUNNING: pgsql is copied onlyifdoesntexist (so postgres.exe
  is never overwritten and never locks the copy), and upgrade.ps1 needs the DB up
  to take a pre-upgrade pg_dump backup. `net stop` blocks until the service stops. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if IsUpgradeFlag then
  begin
    Exec('net.exe', 'stop DigiLogAPI', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);  { give Windows a moment to release the exe file handles }
  end;
end;

{ Write the browser shortcut target after install. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  UrlPath: string;
begin
  if CurStep = ssPostInstall then
  begin
    UrlPath := ExpandConstant('{app}\DigiLog.url');
    SaveStringToFile(UrlPath, '[InternetShortcut]' + #13#10 + 'URL=https://localhost:3000' + #13#10, False);
  end;
end;
