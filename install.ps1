# Freeloomz installer for Windows.
#
#   irm https://raw.githubusercontent.com/chchchadzilla/Freeloomz/main/install.ps1 | iex
#
# Puts Freeloomz in %LOCALAPPDATA%\Programs\Freeloomz, adds Start-menu and
# Desktop shortcuts, and lists it under "Installed apps" so it can be removed
# like any other program. Needs no administrator rights and nothing else
# installed. Run the same line again to update.
#
# What it downloads, all over HTTPS and checked against the SHA-256 sums in
# runtime.json before anything is used:
#   - the app itself, from this repository
#   - the Electron runtime it runs on, from Electron's GitHub releases
#   - ffmpeg, from the ffmpeg-static GitHub releases
#
# To remove Freeloomz: Settings > Apps > Installed apps > Freeloomz, or
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/chchchadzilla/Freeloomz/main/install.ps1))) -Uninstall
#
# Written for Windows PowerShell 5.1 (what Windows ships) and newer. Keep it
# ASCII-only and free of PowerShell 7 syntax.

param(
  [switch]$Uninstall,
  [switch]$NoLaunch,
  [switch]$NoShortcuts,
  # Where to install. Default: %LOCALAPPDATA%\Programs\Freeloomz
  [string]$InstallDir = $env:FREELOOMZ_INSTALL_DIR,
  # A folder or .zip holding the app's source, instead of this repository.
  [string]$Source = $env:FREELOOMZ_INSTALL_SOURCE,
  # A folder of already-downloaded runtime files, for installing offline.
  [string]$Cache = $env:FREELOOMZ_INSTALL_CACHE,
  # Testing only: lay out the app for another system (e.g. linux-x64).
  [string]$Platform = $env:FREELOOMZ_INSTALL_PLATFORM
)

$freeloomzOptions = @{
  Uninstall   = [bool]$Uninstall
  NoLaunch    = [bool]$NoLaunch -or [bool]$env:FREELOOMZ_INSTALL_NO_LAUNCH
  NoShortcuts = [bool]$NoShortcuts
  InstallDir  = $InstallDir
  Source      = $Source
  Cache       = $Cache
  Platform    = $Platform
}

# Everything runs inside this block, so that nothing (functions, preference
# variables) leaks into the PowerShell session the line was pasted into.
$freeloomzInstaller = {
  param($o)

  Set-StrictMode -Off
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'chchchadzilla/Freeloomz'
  $appId = 'Freeloomz'

  function Say {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host "  $Text" -ForegroundColor $Color
  }

  function Step {
    param([string]$Text)
    Write-Host "  > " -ForegroundColor Green -NoNewline
    Write-Host $Text
  }

  # An expected problem with a plain-language explanation (no stack trace).
  function Fail {
    param([string]$Text)
    $problem = New-Object System.Exception $Text
    $problem.Data['freeloomz'] = $true
    throw $problem
  }

  function Read-Json {
    param([string]$Path)
    Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
  }

  function Write-TextFile {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
  }

  # Antivirus scanners briefly hold on to files that were just written;
  # moving or deleting them then fails for a moment. Try a few times.
  function Invoke-Patiently {
    param([scriptblock]$Action)
    $attempt = 0
    while ($true) {
      $attempt++
      try {
        & $Action
        return
      } catch {
        if ($attempt -ge 5) { throw }
        Start-Sleep -Milliseconds (400 * $attempt)
      }
    }
  }

  function Remove-Quietly {
    param([string]$Path)
    if (-not $Path) { return }
    if (Test-Path -LiteralPath $Path) {
      try {
        Invoke-Patiently { Remove-Item -LiteralPath $Path -Recurse -Force }
      } catch {
        # Left behind at worst; never a reason to fail.
      }
    }
  }

  function Test-Checksum {
    param([string]$Path, [string]$Sha256)
    if (-not $Sha256) { return }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256.ToLowerInvariant()) {
      throw "the file did not match its expected checksum (got $actual)"
    }
  }

  # Streams a URL to disk, showing a percentage while it does.
  function Save-Url {
    param([string]$Url, [string]$Path, [string]$Label)
    $request = [System.Net.WebRequest]::Create($Url)
    $request.UserAgent = 'freeloomz-installer'
    # Office networks often sit behind a proxy that wants the signed-in
    # Windows account; offer it, or every download fails with a 407.
    try {
      $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
      $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
      $request.Proxy = $proxy
    } catch {
      # Keep whatever the system set up.
    }
    $response = $request.GetResponse()
    $shownProgress = $false
    # A percentage that rewrites itself only makes sense on a real screen.
    $live = $Label -and -not [System.Console]::IsOutputRedirected
    if ($Label -and -not $live) { Step $Label }
    try {
      $total = $response.ContentLength
      $in = $response.GetResponseStream()
      $out = [System.IO.File]::Create($Path)
      $done = [long]0
      try {
        $buffer = New-Object byte[] 262144
        $shown = -1
        while ($true) {
          $n = $in.Read($buffer, 0, $buffer.Length)
          if ($n -le 0) { break }
          $out.Write($buffer, 0, $n)
          $done += $n
          if ($live -and $total -gt 0) {
            $percent = [int][math]::Floor(100 * $done / $total)
            if ($percent -ne $shown) {
              $shown = $percent
              $shownProgress = $true
              Write-Host ("`r  > {0} {1,3}%" -f $Label, $percent) -NoNewline
            }
          }
        }
      } finally {
        $out.Dispose()
        $in.Dispose()
      }
      if ($total -gt 0 -and $done -ne $total) { throw 'the download was cut short' }
    } finally {
      $response.Close()
      if ($shownProgress) { Write-Host '' }
    }
  }

  # Downloads (or takes from the cache folder) and verifies one file.
  function Get-File {
    param([string]$Url, [string]$Path, [string]$Sha256, [string]$Label)
    $name = Split-Path -Leaf $Path
    if ($o.Cache) {
      $cached = Join-Path $o.Cache $name
      if (Test-Path -LiteralPath $cached -PathType Leaf) {
        Copy-Item -LiteralPath $cached -Destination $Path -Force
        try {
          Test-Checksum $Path $Sha256
        } catch {
          Fail "$cached is not the file this version of Freeloomz needs: $($_.Exception.Message)."
        }
        Step "Using $name from $($o.Cache)"
        return
      }
    }
    $problem = ''
    foreach ($attempt in 1..3) {
      try {
        Save-Url $Url $Path $Label
        Test-Checksum $Path $Sha256
        return
      } catch {
        $problem = $_.Exception.Message
        if ($_.Exception.InnerException) { $problem = $_.Exception.InnerException.Message }
        if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
      }
    }
    Fail "Could not download $Url ($problem). Check your internet connection and run this again."
  }

  function Expand-Zip {
    param([string]$Zip, [string]$To)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $To)
  }

  function Expand-Gzip {
    param([string]$Gz, [string]$To)
    $in = [System.IO.File]::OpenRead($Gz)
    try {
      $out = [System.IO.File]::Create($To)
      try {
        $stream = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
        try {
          $stream.CopyTo($out)
        } finally {
          $stream.Dispose()
        }
      } finally {
        $out.Dispose()
      }
    } finally {
      $in.Dispose()
    }
  }

  # Copies just what the app needs to run out of a source tree.
  function Copy-App {
    param([string]$From, [string]$To)
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    foreach ($file in @('package.json', 'LICENSE')) {
      Copy-Item -LiteralPath (Join-Path $From $file) -Destination (Join-Path $To $file)
    }
    foreach ($folder in @('src', 'assets')) {
      Copy-Item -LiteralPath (Join-Path $From $folder) -Destination (Join-Path $To $folder) -Recurse
    }
  }

  # ------------------------------------------------------------------ setup

  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Fail 'This PC restricts what PowerShell may do (constrained language mode), so the installer cannot run here. That is a setting made by whoever manages the PC.'
  }

  $onWindows = ($PSVersionTable.PSEdition -ne 'Core') -or $IsWindows
  $platform = $o.Platform
  if (-not $platform) {
    if (-not $onWindows) {
      Fail "This installer is for Windows. On macOS and Linux, with Node.js 22 or newer: npm install -g https://github.com/$repo/archive/refs/heads/main.tar.gz"
    }
    if (-not [System.Environment]::Is64BitOperatingSystem) { Fail 'Freeloomz needs 64-bit Windows.' }
    if ([System.Environment]::OSVersion.Version.Major -lt 10) { Fail 'Freeloomz needs Windows 10 or newer.' }
    $platform = 'win32-x64'
  }
  $forWindows = $platform -like 'win32-*'
  $exeName = if ($forWindows) { 'Freeloomz.exe' } else { 'freeloomz' }
  $stockExeName = if ($forWindows) { 'electron.exe' } else { 'electron' }
  $ffmpegName = if ($forWindows) { 'ffmpeg.exe' } else { 'ffmpeg' }
  $integrate = $forWindows -and $onWindows # shortcuts, "Installed apps" entry

  $dir = $o.InstallDir
  if (-not $dir) {
    if (-not $onWindows) { Fail 'Say where to install with -InstallDir.' }
    $dir = Join-Path $env:LOCALAPPDATA 'Programs\Freeloomz'
  }
  $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dir)
  $exe = Join-Path $dir $exeName
  $resources = Join-Path $dir 'resources'
  $manifestPath = Join-Path $resources 'freeloomz-install.json'
  $ffmpegPath = Join-Path (Join-Path $resources 'ffmpeg') $ffmpegName
  $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$appId"

  function Get-ShortcutPaths {
    @(
      (Join-Path ([System.Environment]::GetFolderPath('Programs')) 'Freeloomz.lnk'),
      (Join-Path ([System.Environment]::GetFolderPath('DesktopDirectory')) 'Freeloomz.lnk')
    )
  }

  function Assert-NotRunning {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($exeName)
    $running = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)
      })
    if ($running.Count -gt 0) {
      Fail 'Freeloomz is open. Finish any recording, quit it (right-click its icon next to the clock, then "Quit Freeloomz") and run this again.'
    }
  }

  # The folder is only ever replaced or deleted when this file is in it, so
  # a mistyped -InstallDir can never take someone's documents with it.
  $existing = $null
  if (Test-Path -LiteralPath $dir) {
    if (Test-Path -LiteralPath $manifestPath) {
      try {
        $existing = Read-Json $manifestPath
      } catch {
        $existing = New-Object psobject
      }
    } elseif (@(Get-ChildItem -LiteralPath $dir -Force).Count -gt 0) {
      Fail "$dir already exists and is not a Freeloomz install. Choose another folder with -InstallDir, or empty that one first."
    }
  }

  Write-Host ''
  Write-Host '  freel' -NoNewline
  Write-Host 'oo' -ForegroundColor Green -NoNewline
  Write-Host 'mz'
  Write-Host ''

  # -------------------------------------------------------------- uninstall

  if ($o.Uninstall) {
    if (-not $existing) {
      Say "Freeloomz is not installed in $dir."
      return
    }
    Assert-NotRunning
    if ($integrate) {
      try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($link in Get-ShortcutPaths) {
          if (-not (Test-Path -LiteralPath $link)) { continue }
          # Leave alone a shortcut that points at some other copy.
          if ($shell.CreateShortcut($link).TargetPath -eq $exe) { Remove-Item -LiteralPath $link -Force }
        }
      } catch {
        Say "Could not remove the shortcuts: $($_.Exception.Message)" 'Yellow'
      }
      try {
        if (Test-Path -LiteralPath $uninstallKey) { Remove-Item -LiteralPath $uninstallKey -Recurse -Force }
      } catch {
        Say "Could not remove the Installed apps entry: $($_.Exception.Message)" 'Yellow'
      }
    }
    # A folder cannot be deleted from inside itself.
    $here = (Get-Location).ProviderPath
    if ($here -and $here.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) {
      Set-Location -LiteralPath (Split-Path -Parent $dir)
    }
    if ([System.Environment]::CurrentDirectory.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) {
      [System.Environment]::CurrentDirectory = Split-Path -Parent $dir
    }
    Invoke-Patiently { Remove-Item -LiteralPath $dir -Recurse -Force }
    Step 'Freeloomz was removed.'
    Say 'Your recordings were not touched.'
    if ($onWindows) { Say "Your settings are still in $(Join-Path $env:APPDATA 'Freeloomz'); delete that folder too if you want them gone." }
    Write-Host ''
    return
  }

  # ---------------------------------------------------------------- install

  Assert-NotRunning

  # Not every download server speaks to the old TLS versions that Windows
  # PowerShell 5.1 offers by default.
  try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
  } catch {
    # Newer systems negotiate this by themselves.
  }

  $parent = Split-Path -Parent $dir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $stamp = [System.IO.Path]::GetRandomFileName().Replace('.', '')
  # Next to the destination, so the finished folder can be swapped in with a
  # rename (instant, and all-or-nothing) instead of a copy.
  $work = "$dir.installing-$stamp"
  $retired = "$dir.old-$stamp"
  $downloads = Join-Path $work 'downloads'

  try {
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null

    # 1. The app itself.
    $source = $o.Source
    if (-not $source) { $source = "https://github.com/$repo/archive/refs/heads/main.zip" }
    $sourceRoot = $null
    if ($source -notmatch '^https?://' -and (Test-Path -LiteralPath $source -PathType Container)) {
      $sourceRoot = (Resolve-Path -LiteralPath $source).ProviderPath
    } else {
      $sourceZip = Join-Path $downloads 'freeloomz-source.zip'
      if ($source -match '^https?://') {
        Get-File $source $sourceZip '' ''
      } else {
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { Fail "There is no folder or .zip at $source." }
        Copy-Item -LiteralPath $source -Destination $sourceZip
      }
      $unpacked = Join-Path $downloads 'source'
      Expand-Zip $sourceZip $unpacked
      # GitHub wraps the files in one top-level folder.
      $sourceRoot = $unpacked
      if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'package.json'))) {
        $inner = @(Get-ChildItem -LiteralPath $unpacked -Directory)
        if ($inner.Count -eq 1) { $sourceRoot = $inner[0].FullName }
      }
    }
    foreach ($needed in @('package.json', 'runtime.json', 'install.ps1', 'src', 'assets')) {
      if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $needed))) {
        Fail "That does not look like Freeloomz: $needed is missing from $source."
      }
    }
    $package = Read-Json (Join-Path $sourceRoot 'package.json')
    $runtime = Read-Json (Join-Path $sourceRoot 'runtime.json')
    $version = $package.version
    $electronVersion = $runtime.electron.version
    $electronSha = $runtime.electron.sha256.$platform
    $ffmpegRelease = $runtime.ffmpeg.release
    $ffmpegSha = $runtime.ffmpeg.sha256.$platform
    if (-not $electronSha -or -not $ffmpegSha) { Fail "Freeloomz has no build for $platform." }

    $manifest = [ordered]@{
      app         = $version
      electron    = $electronVersion
      ffmpeg      = $ffmpegRelease
      platform    = $platform
      installedBy = 'install.ps1'
      installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    $manifestJson = $manifest | ConvertTo-Json

    $verb = if ($existing) { 'Updating to' } else { 'Installing' }
    Step "$verb Freeloomz $version"

    # The runtime and ffmpeg are 190 MB of download; keep them when an
    # update did not change them, which is nearly always.
    $keepRuntime = $existing -and
      ($existing.platform -eq $platform) -and
      ($existing.electron -eq $electronVersion) -and
      ($existing.ffmpeg -eq $ffmpegRelease) -and
      (Test-Path -LiteralPath $exe) -and
      (Test-Path -LiteralPath $ffmpegPath)

    if ($keepRuntime) {
      $newApp = Join-Path $resources "app.new-$stamp"
      $oldApp = Join-Path $resources "app.old-$stamp"
      $app = Join-Path $resources 'app'
      Copy-App $sourceRoot $newApp
      $hadApp = Test-Path -LiteralPath $app
      if ($hadApp) { Invoke-Patiently { Rename-Item -LiteralPath $app -NewName (Split-Path -Leaf $oldApp) } }
      try {
        Invoke-Patiently { Rename-Item -LiteralPath $newApp -NewName 'app' }
      } catch {
        if ($hadApp) { Rename-Item -LiteralPath $oldApp -NewName 'app' }
        throw
      }
      Remove-Quietly $oldApp
      Copy-Item -LiteralPath (Join-Path $sourceRoot 'install.ps1') -Destination (Join-Path $dir 'install.ps1') -Force
      Write-TextFile $manifestPath $manifestJson
    } else {
      try {
        $free = (Get-Item -LiteralPath $parent).PSDrive.Free
        if ($free -and $free -lt 1GB) { Fail "There is not enough free disk space to install Freeloomz (it needs about 1 GB while installing)." }
      } catch {
        if ($_.Exception.Data['freeloomz']) { throw }
        # Free space could not be read (network drive, odd provider): carry on.
      }

      # 2. The runtime.
      $electronZipName = "electron-v$electronVersion-$platform.zip"
      $electronZip = Join-Path $downloads $electronZipName
      Get-File "https://github.com/electron/electron/releases/download/v$electronVersion/$electronZipName" $electronZip $electronSha 'Downloading the app runtime (about 160 MB)'
      $stage = Join-Path $work 'Freeloomz'
      Step 'Unpacking'
      Expand-Zip $electronZip $stage
      Remove-Item -LiteralPath $electronZip -Force
      # The app's own name on the program makes Windows show "Freeloomz"
      # (not "Electron") in the taskbar, Task Manager and permission prompts.
      Rename-Item -LiteralPath (Join-Path $stage $stockExeName) -NewName $exeName

      # 3. ffmpeg, which turns recordings into finished MP4s.
      $ffmpegGzName = "ffmpeg-$platform.gz"
      $ffmpegGz = Join-Path $downloads $ffmpegGzName
      Get-File "https://github.com/eugeneware/ffmpeg-static/releases/download/$ffmpegRelease/$ffmpegGzName" $ffmpegGz $ffmpegSha 'Downloading the video encoder (about 30 MB)'
      $stageResources = Join-Path $stage 'resources'
      $stageFfmpegDir = Join-Path $stageResources 'ffmpeg'
      New-Item -ItemType Directory -Force -Path $stageFfmpegDir | Out-Null
      Expand-Gzip $ffmpegGz (Join-Path $stageFfmpegDir $ffmpegName)

      if (-not $forWindows) {
        & chmod +x (Join-Path $stage $exeName) (Join-Path $stageFfmpegDir $ffmpegName)
        foreach ($helper in @('chrome-sandbox', 'chrome_crashpad_handler')) {
          $helperPath = Join-Path $stage $helper
          if (Test-Path -LiteralPath $helperPath) { & chmod +x $helperPath }
        }
      }

      Copy-App $sourceRoot (Join-Path $stageResources 'app')
      Copy-Item -LiteralPath (Join-Path $sourceRoot 'install.ps1') -Destination (Join-Path $stage 'install.ps1')
      Write-TextFile (Join-Path $stageResources 'freeloomz-install.json') $manifestJson

      # Swap the finished folder into place.
      $hadDir = Test-Path -LiteralPath $dir
      if ($hadDir) {
        try {
          Invoke-Patiently { Rename-Item -LiteralPath $dir -NewName (Split-Path -Leaf $retired) }
        } catch {
          Fail "Could not replace $dir - something in it is in use. Close Freeloomz and any window showing that folder, then run this again."
        }
      }
      try {
        Invoke-Patiently { Move-Item -LiteralPath $stage -Destination $dir }
      } catch {
        if ($hadDir) { Rename-Item -LiteralPath $retired -NewName (Split-Path -Leaf $dir) }
        throw
      }
      Remove-Quietly $retired
    }
  } finally {
    Remove-Quietly $work
  }

  # ------------------------------------------------------ Windows integration

  $shortcutsMade = $false
  if ($integrate -and -not $o.NoShortcuts) {
    try {
      $links = Get-ShortcutPaths
      $shell = New-Object -ComObject WScript.Shell
      for ($i = 0; $i -lt $links.Count; $i++) {
        $link = $links[$i]
        # On an update, do not bring back a Desktop shortcut that was deleted.
        if ($i -eq 1 -and $existing -and -not (Test-Path -LiteralPath $link)) { continue }
        $shortcut = $shell.CreateShortcut($link)
        $shortcut.TargetPath = $exe
        $shortcut.WorkingDirectory = $dir
        $shortcut.Description = 'Freeloomz - screen and camera recorder'
        $shortcut.IconLocation = (Join-Path $resources 'app\assets\icon.ico') + ',0'
        $shortcut.Save()
      }
      $shortcutsMade = $true
    } catch {
      Say "Could not add the shortcuts: $($_.Exception.Message)" 'Yellow'
    }
  }

  if ($integrate) {
    try {
      if (-not (Test-Path -LiteralPath $uninstallKey)) { New-Item -Path $uninstallKey -Force | Out-Null }
      $uninstallCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Uninstall -InstallDir "{1}"' -f (Join-Path $dir 'install.ps1'), $dir
      $sizeKb = [int]((Get-ChildItem -LiteralPath $dir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB)
      New-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayName' -Value 'Freeloomz' -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayVersion' -Value ([string]$version) -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'Publisher' -Value 'Chad Keith' -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'InstallLocation' -Value $dir -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayIcon' -Value (Join-Path $resources 'app\assets\icon.ico') -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'UninstallString' -Value $uninstallCommand -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'URLInfoAbout' -Value "https://github.com/$repo" -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'EstimatedSize' -Value $sizeKb -PropertyType DWord -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
      New-ItemProperty -LiteralPath $uninstallKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
    } catch {
      # Only costs the entry under "Installed apps"; the app itself is fine.
    }
  }

  Write-Host ''
  Write-Host "  Freeloomz $version is installed." -ForegroundColor Green
  if ($shortcutsMade) {
    Say 'Open it from the Start menu or the Desktop shortcut.'
  } else {
    Say "Open it with: $exe"
  }
  Say 'To update, run this same line again.'
  Write-Host ''

  if ($integrate -and -not $o.NoLaunch) {
    try {
      Start-Process -FilePath $exe -WorkingDirectory $dir
    } catch {
      Say "Could not start it automatically: $($_.Exception.Message)" 'Yellow'
    }
  }
}

$freeloomzFailed = $false
try {
  & $freeloomzInstaller $freeloomzOptions
} catch {
  $freeloomzFailed = $true
  Write-Host ''
  if ($_.Exception.Data['freeloomz']) {
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  } else {
    Write-Host "  Freeloomz could not be installed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  ($($_.InvocationInfo.PositionMessage -replace '\s+', ' '))" -ForegroundColor DarkGray
    Write-Host "  Please report this at https://github.com/chchchadzilla/Freeloomz/issues" -ForegroundColor DarkGray
  }
  Write-Host ''
}

# Run as a file (the "Installed apps" uninstaller, or a script), report
# failure through the exit code. Pasted into a terminal there is no file,
# and exiting would close the person's window.
if ($freeloomzFailed -and $MyInvocation.MyCommand.Path) { exit 1 }
