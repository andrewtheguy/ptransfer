# ptransfer installer for Windows
# Downloads the latest executable from: https://github.com/andrewtheguy/ptransfer/releases
#
#   irm https://raw.githubusercontent.com/andrewtheguy/ptransfer/main/install.ps1 | iex
#
# With options, run it as a script block instead, since `iex` takes none:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/andrewtheguy/ptransfer/main/install.ps1))) -Prerelease
#
#   -Tag v0.0.13     install that release instead of the latest
#   -Prerelease      install the newest prerelease
#   -DownloadOnly    leave the executable in the current directory
#
# It installs into %LOCALAPPDATA%\Programs\ptransfer — no administrator needed
# — and puts that folder on the user's PATH. The download is checked against
# the SHA-256 digest GitHub published for it before anything is installed.
#
# Written for Windows PowerShell 5.1 as well as PowerShell 7: 5.1 is what a
# stock Windows runs `irm | iex` in.
param(
    [string] $Tag,
    [switch] $Prerelease,
    [switch] $DownloadOnly
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is many times slower with its progress bar drawn.
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 can default to TLS 1.0, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'andrewtheguy/ptransfer'
$Binary = 'ptransfer-windows-amd64.exe'
$Api = "https://api.github.com/repos/$Repo/releases"

function Info([string] $Message) { Write-Host "[INFO] $Message" -ForegroundColor Green }
function Warn([string] $Message) { Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Fail([string] $Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    # `exit` would close the window `irm | iex` runs in; a throw ends only the script.
    throw $Message
}

function Get-Release {
    if ($Tag) {
        Info "Fetching release $Tag..."
        return Invoke-RestMethod -UseBasicParsing "$Api/tags/$Tag"
    }
    if ($Prerelease) {
        Info 'Fetching the latest prerelease...'
        $found = Invoke-RestMethod -UseBasicParsing "$Api`?per_page=30" |
            Where-Object { $_.prerelease } | Select-Object -First 1
        if (-not $found) { Fail 'Could not find any prerelease on GitHub' }
        return $found
    }
    Info 'Fetching the latest release...'
    return Invoke-RestMethod -UseBasicParsing "$Api/latest"
}

# Only x64 is built. Windows on Arm's x64 emulation may run it, untested.
$arch = $env:PROCESSOR_ARCHITEW6432
if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
if ($arch -eq 'x86') { Fail 'ptransfer needs 64-bit Windows.' }
if ($arch -eq 'ARM64') { Warn 'There is no Arm build; installing the x64 one, which Windows'' emulation may run, untested.' }

try { $release = Get-Release }
catch { Fail "Could not fetch release information from GitHub: $($_.Exception.Message)" }
Info "Release: $($release.tag_name)"

$asset = $release.assets | Where-Object { $_.name -eq $Binary } | Select-Object -First 1
if (-not $asset) { Fail "Release $($release.tag_name) has no $Binary; it may predate the Windows build." }
if ($asset.digest -notmatch '^sha256:([0-9a-f]{64})$') {
    Fail "GitHub published no SHA-256 digest for $Binary in $($release.tag_name); not installing an unchecked download."
}
$expected = $Matches[1]
Info "Expected checksum: $($expected.Substring(0, 16))..."

$temp = Join-Path ([IO.Path]::GetTempPath()) "ptransfer-install-$PID"
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
    $download = Join-Path $temp $Binary
    Info "Downloading $($asset.browser_download_url)"
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $download

    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Fail "Checksum verification FAILED. Expected $expected, got $actual."
    }
    Info "Checksum verified: $($actual.Substring(0, 16))..."

    if ($DownloadOnly) {
        $saved = Join-Path (Get-Location).Path $Binary
        Move-Item -Force -LiteralPath $download -Destination $saved
        Info "Saved to $saved"
        return
    }

    $installDir = Join-Path $env:LOCALAPPDATA 'Programs\ptransfer'
    $installed = Join-Path $installDir 'ptransfer.exe'
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    try {
        Move-Item -Force -LiteralPath $download -Destination $installed
    } catch [System.IO.IOException] {
        # Windows will not replace an executable while it runs.
        Fail "Could not replace $installed; if ptransfer is running, close it and run this again."
    }
    Info "Installed to $installed"

    # The user's PATH as stored, not this session's: the session's is the
    # machine's and the user's joined, and writing it back would copy the
    # machine's entries into the user's.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($userPath) { $entries = $userPath -split ';' | Where-Object { $_ } }
    if ($entries -notcontains $installDir) {
        [Environment]::SetEnvironmentVariable('Path', (($entries + $installDir) -join ';'), 'User')
        $env:Path = "$env:Path;$installDir"
        Info "Added $installDir to your PATH; terminals opened from now on find ptransfer."
    }

    # Another ptransfer earlier on PATH runs instead of this one.
    $first = Get-Command ptransfer -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($first -and $first.Source -ne $installed) {
        Warn "$($first.Source) comes before $installed on your PATH and runs instead of it."
        Warn 'Remove it, or move it later on your PATH.'
    }

    Info 'Installation completed successfully!'
    Info 'Run ptransfer in Windows Terminal; its terminal UI does not support the older console host.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
