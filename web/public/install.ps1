& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  Set-StrictMode -Version 3.0

  $minimumNodeMajor = 22
  $nodeDistributionUrl = "https://nodejs.org/download/release"
  $temporaryDirectory = $null
  $previousSecurityProtocol = $null
  $securityProtocolChanged = $false

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

  try {
    $nodeCommand = Get-Command "node" -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    $npxCommand = Find-RelmioNpxCommand
    $installedNodeMajor = 0

    if ($null -ne $nodeCommand -and $null -ne $npxCommand) {
      $installedNodeMajorText = & $nodeCommand.Source -p 'process.versions.node.split(".")[0]' 2>$null
      if (
        $LASTEXITCODE -eq 0 -and
        [int]::TryParse(([string]$installedNodeMajorText).Trim(), [ref]$installedNodeMajor) -and
        $installedNodeMajor -ge $minimumNodeMajor
      ) {
        Write-RelmioInstallerMessage "Using installed Node.js $installedNodeMajor runtime."
        & $npxCommand.Source --yes --ignore-scripts relmio@latest
        $relmioStatus = $LASTEXITCODE
        if ($relmioStatus -ne 0) {
          throw "Relmio finished with status $relmioStatus."
        }
        return
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
    $manifestUrl = "https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt"

    Write-RelmioInstallerMessage "Downloading a temporary Node.js 22 runtime."
    Save-RelmioHttpsFile -Uri $manifestUrl -Destination $manifestPath

    $manifestPattern = '^(?<checksum>[0-9A-Fa-f]{64})\s+(?<filename>node-(?<version>v22\.\d+\.\d+)-win-(?<architecture>x64|arm64)\.zip)$'
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
    $archivePath = Join-Path $temporaryDirectory $runtime.Filename
    $archiveUrl = "$nodeDistributionUrl/$($runtime.Version)/$($runtime.Filename)"
    Save-RelmioHttpsFile -Uri $archiveUrl -Destination $archivePath

    $actualChecksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($actualChecksum, $runtime.Checksum, [StringComparison]::Ordinal)) {
      throw "Node.js download checksum did not match; nothing was executed."
    }
    Write-RelmioInstallerMessage "Verified Node.js download."

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
    & $nodeBinary $npxCli --yes --ignore-scripts relmio@latest
    $relmioStatus = $LASTEXITCODE
    if ($relmioStatus -ne 0) {
      throw "Relmio finished with status $relmioStatus."
    }
  } catch {
    throw "Relmio installer: $($_.Exception.Message)"
  } finally {
    try {
      if ($null -ne $temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
      }
    } finally {
      if ($securityProtocolChanged) {
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
      }
    }
  }
}
