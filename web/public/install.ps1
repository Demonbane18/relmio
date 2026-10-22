& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  Set-StrictMode -Version 3.0

  $nodeDistributionUrl = "https://nodejs.org/download/release"
  $temporaryDirectory = $null
  $previousSecurityProtocol = $null
  $securityProtocolChanged = $false
  $previousPath = $null
  $pathChanged = $false
  $foregroundWizardEnvironmentExisted = Test-Path Env:RELMIO_FOREGROUND_WIZARD
  $previousForegroundWizardEnvironment = if ($foregroundWizardEnvironmentExisted) {
    [Environment]::GetEnvironmentVariable("RELMIO_FOREGROUND_WIZARD", "Process")
  } else {
    $null
  }

  function Write-RelmioInstallerMessage {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host "Relmio installer: $Message"
  }

  function Save-RelmioHttpsFile {
    param(
      [Parameter(Mandatory = $true)][string]$Uri,
      [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not $Uri.StartsWith("https://", [System.StringComparison]::Ordinal)) {
      throw "Refusing to download from a non-HTTPS address."
    }

    Invoke-WebRequest `
      -Uri $Uri `
      -OutFile $Destination `
      -UseBasicParsing `
      -MaximumRedirection 0 `
      -TimeoutSec 600 `
      -ErrorAction Stop
  }

  function Find-RelmioNpxCommand {
    $command = Get-Command "npx.cmd" -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -eq $command) {
      $command = Get-Command "npx" -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    }
    return $command
  }

  function Test-RelmioReusableNodeVersion {
    param([Parameter(Mandatory = $true)][string]$VersionText)

    if ($VersionText -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$') {
      return $false
    }

    $major = 0
    $minor = 0
    $patch = 0
    if (-not [int]::TryParse($Matches["major"], [ref]$major) -or
        -not [int]::TryParse($Matches["minor"], [ref]$minor) -or
        -not [int]::TryParse($Matches["patch"], [ref]$patch)) {
      return $false
    }

    if ($major -eq 24) {
      return ($minor -gt 22) -or ($minor -eq 22 -and $patch -ge 1)
    }
    if ($major -eq 26) {
      return ($minor -gt 12) -or ($minor -eq 12 -and $patch -ge 1)
    }
    return $false
  }

  function Get-RelmioNodeRejectMessage {
    param([Parameter(Mandatory = $true)][string]$VersionText)

    $major = 0
    if ($VersionText -match '^v(?<major>\d+)\.' -and [int]::TryParse($Matches["major"], [ref]$major)) {
      if ($major -eq 24 -or $major -lt 24) {
        return "Installed Node.js $VersionText is older than the patched 24.22.1; using a verified temporary runtime."
      }
      if ($major -eq 26) {
        return "Installed Node.js $VersionText is older than the patched 26.12.1; using a verified temporary runtime."
      }
      if ($major -eq 25) {
        return "Installed Node.js $VersionText is an end-of-life release with no security patch; using a verified temporary runtime."
      }
    }
    return "Installed Node.js $VersionText is not a patched runtime Relmio can reuse; using a verified temporary runtime."
  }

  try {
    $nodeCommand = Get-Command "node" -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    $npxCommand = Find-RelmioNpxCommand

    if ($null -ne $nodeCommand -and $null -ne $npxCommand) {
      $installedNodeVersion = (& $nodeCommand.Source --version 2>$null)
      $nodeExitCode = 1
      if (Test-Path -Path variable:LASTEXITCODE) {
        $nodeExitCode = $LASTEXITCODE
      }
      if ($null -ne $installedNodeVersion) {
        $installedNodeVersion = ([string]$installedNodeVersion).Trim()
      }
      if ($nodeExitCode -eq 0 -and $installedNodeVersion -and (Test-RelmioReusableNodeVersion -VersionText $installedNodeVersion)) {
        Write-RelmioInstallerMessage "Using installed Node.js $installedNodeVersion runtime."
        [Environment]::SetEnvironmentVariable("RELMIO_FOREGROUND_WIZARD", "1", "Process")
        & $npxCommand.Source --yes --ignore-scripts relmio@latest
        $relmioStatus = if (Test-Path -Path variable:LASTEXITCODE) { $LASTEXITCODE } else { 1 }
        if ($relmioStatus -ne 0) {
          throw "Relmio finished with status $relmioStatus."
        }
        return
      }
      if ($nodeExitCode -eq 0 -and $installedNodeVersion -match '^v\d+\.\d+\.\d+$') {
        Write-RelmioInstallerMessage (Get-RelmioNodeRejectMessage -VersionText $installedNodeVersion)
      }
    }

    $windowsArchitecture = if (
      -not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)
    ) {
      $env:PROCESSOR_ARCHITEW6432
    } else {
      $env:PROCESSOR_ARCHITECTURE
    }

    $nodeArchitecture = switch ($windowsArchitecture.ToUpperInvariant()) {
      "AMD64" { "x64"; break }
      "ARM64" { "arm64"; break }
      default {
        throw "Unsupported CPU architecture. Relmio supports Windows x64 and ARM64."
      }
    }

    $previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
    [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $securityProtocolChanged = $true

    $temporaryDirectory = Join-Path `
      ([IO.Path]::GetTempPath()) `
      ("relmio-" + [Guid]::NewGuid().ToString("N"))
    [IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null

    $manifestPath = Join-Path $temporaryDirectory "SHASUMS256.txt"
    $manifestUrl = "https://nodejs.org/download/release/latest-v24.x/SHASUMS256.txt"

    Write-RelmioInstallerMessage "[1/4] Installing a temporary Node.js 24 runtime. Please wait; this does not install Node.js system-wide."
    Write-RelmioInstallerMessage "[2/4] Downloading the official Node.js checksum manifest and runtime. Please wait..."
    Save-RelmioHttpsFile -Uri $manifestUrl -Destination $manifestPath

    $manifestPattern = '^(?<checksum>[0-9A-Fa-f]{64})\s+(?<filename>node-(?<version>v24\.\d+\.\d+)-win-(?<architecture>x64|arm64)\.zip)$'
    $runtimeEntries = @(
      foreach ($line in Get-Content -LiteralPath $manifestPath) {
        if ($line -match $manifestPattern -and $Matches["architecture"] -eq $nodeArchitecture) {
          [PSCustomObject]@{
            Checksum = $Matches["checksum"].ToLowerInvariant()
            Filename = $Matches["filename"]
            Version = $Matches["version"]
          }
        }
      }
    )

    if ($runtimeEntries.Count -ne 1) {
      throw "The Node.js manifest did not contain exactly one supported Windows runtime."
    }

    $runtime = $runtimeEntries[0]
    $manifestMinor = 0
    $manifestPatch = 0
    if ($runtime.Version -notmatch '^v24\.(?<minor>\d+)\.(?<patch>\d+)$' -or
        -not [int]::TryParse($Matches["minor"], [ref]$manifestMinor) -or
        -not [int]::TryParse($Matches["patch"], [ref]$manifestPatch) -or
        $manifestMinor -lt 22 -or ($manifestMinor -eq 22 -and $manifestPatch -lt 1)) {
      throw "The Node.js manifest version is older than the patched 24.22.1."
    }
    $archivePath = Join-Path $temporaryDirectory $runtime.Filename
    $archiveUrl = "$nodeDistributionUrl/$($runtime.Version)/$($runtime.Filename)"
    Save-RelmioHttpsFile -Uri $archiveUrl -Destination $archivePath

    Write-RelmioInstallerMessage "[3/4] Verifying the Node.js SHA-256 checksum. Please wait..."
    $actualChecksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($actualChecksum, $runtime.Checksum, [StringComparison]::Ordinal)) {
      throw "Node.js download checksum did not match; nothing was executed."
    }
    Write-RelmioInstallerMessage "Verified Node.js download."

    Write-RelmioInstallerMessage "[4/4] Extracting the verified temporary Node.js 24 runtime. Please wait..."
    Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDirectory -Force
    $archiveRoot = [IO.Path]::GetFileNameWithoutExtension($runtime.Filename)
    $nodeBinary = Join-Path $temporaryDirectory "$archiveRoot\node.exe"
    $npxCli = Join-Path $temporaryDirectory "$archiveRoot\node_modules\npm\bin\npx-cli.js"

    if (-not (Test-Path -LiteralPath $nodeBinary -PathType Leaf)) {
      throw "The verified Node.js archive did not contain its runtime."
    }
    if (-not (Test-Path -LiteralPath $npxCli -PathType Leaf)) {
      throw "The verified Node.js archive did not contain npm."
    }

    Write-RelmioInstallerMessage "Starting the newest Relmio wizard."
    [Environment]::SetEnvironmentVariable("RELMIO_FOREGROUND_WIZARD", "1", "Process")
    # npm's .cmd bin shims call `node` from PATH, so expose the portable runtime to the child.
    $previousPath = $env:Path
    $pathChanged = $true
    $env:Path = (Split-Path -Parent $nodeBinary) + [IO.Path]::PathSeparator + $env:Path
    & $nodeBinary $npxCli --yes --ignore-scripts relmio@latest
    $relmioStatus = $LASTEXITCODE
    if ($relmioStatus -ne 0) {
      throw "Relmio finished with status $relmioStatus."
    }
  } catch {
    throw "Relmio installer: $($_.Exception.Message)"
  } finally {
    if ($pathChanged) {
      $env:Path = $previousPath
    }
    try {
      if ($null -ne $temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
        # node.exe can stay locked briefly after npx exits; retry like install.cmd (3 attempts, ~1 s apart).
        for ($removeAttempt = 1; ; $removeAttempt++) {
          try {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
            break
          } catch {
            if ($removeAttempt -ge 3) { throw }
            Start-Sleep -Seconds 1
          }
        }
      }
    } finally {
      try {
        if ($securityProtocolChanged) {
          [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
        }
      } finally {
        if ($foregroundWizardEnvironmentExisted) {
          [Environment]::SetEnvironmentVariable("RELMIO_FOREGROUND_WIZARD", $previousForegroundWizardEnvironment, "Process")
        } else {
          Remove-Item Env:RELMIO_FOREGROUND_WIZARD -ErrorAction SilentlyContinue
        }
      }
    }
  }
}
