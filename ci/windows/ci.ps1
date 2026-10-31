# The CLI's checks on Windows, run natively on the CI VM by ci/windows/remote.ps1
# (`pwsh ci/windows/remote.ps1`): the type check, the CLI's unit tests, the
# terminal UI's tests, and the executable the `Release CLI` workflow builds,
# smoke-tested away from the checkout as the workflow does.
#
# `remote.ps1 ci -Live` adds the live tests AGENTS.md lists for the CLI — Code
# Exchange, PIN Exchange and Tor between two CLI processes, and `tor-test` —
# which reach the public Nostr relays and the Tor network, so they take minutes
# and want a change under cli/ that calls for them.
#
# What a CI VM cannot check — a password typed at a real console, Ctrl-C in
# one, the clipboard — is in phase 5 of docs/ROADMAP.md.
#
# PowerShell 7. Installs nothing beyond node_modules: Bun is on the VM's PATH,
# and devtools points BUN_INSTALL_CACHE_DIR outside the workspace.
#Requires -Version 7
[CmdletBinding()]
param([switch] $Live)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# No colour codes in a log that is read as text.
$env:NO_COLOR = '1'

function Invoke-Step([string] $Name, [scriptblock] $Body) {
    Write-Host ''
    Write-Host "== $Name =="
    $clock = [Diagnostics.Stopwatch]::StartNew()
    & $Body
    Write-Host ("   {0} took {1:n0}s" -f $Name, $clock.Elapsed.TotalSeconds)
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host "FAILED: $Name (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
}

Write-Host '== toolchain =='
& bun --version
if ($env:BUN_INSTALL_CACHE_DIR) { Write-Host "   BUN_INSTALL_CACHE_DIR=$env:BUN_INSTALL_CACHE_DIR" }

# `bun x`, not `bunx`: the remoting session's PATH has bun.exe and not its
# bunx alias.
Invoke-Step 'install' { & bun install --frozen-lockfile }
Invoke-Step 'type check' { & bun x tsc -b }
Invoke-Step 'cli unit tests' { & bun x vitest run --project unit cli/ }
Invoke-Step 'terminal UI tests' { & bun run test:tui }
Invoke-Step 'build' { & bun run build:cli -- --outfile dist\cli\ptransfer-windows-amd64.exe }

Invoke-Step 'smoke test the executable' {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $binary = (Resolve-Path dist\cli\ptransfer-windows-amd64.exe).Path
    # Away from the checkout, so no node_modules can stand in for something
    # the executable failed to embed.
    Push-Location ([IO.Path]::GetTempPath())
    try {
        $got = & $binary --version
        Write-Host "   the executable reports: $got"
        if ($got -notlike "ptransfer $version *") {
            Write-Host "   expected 'ptransfer $version (protocol N)'"
            $global:LASTEXITCODE = 1
            return
        }
        & $binary send --help | Out-Null
        if ($LASTEXITCODE -ne 0) { return }
        # The native addons load only when used, so --version passes without
        # them. A Code Exchange code is printed once libdatachannel has made an
        # offer; the run then fails on the answer stdin never brings.
        $code = $null | & $binary send --code (Join-Path $PSScriptRoot '..\..\package.json') 2> send-code.err
        $refused = Select-String -Quiet 'No code was given on standard input' send-code.err
        if (-not $code -or -not $refused) {
            Get-Content send-code.err
            Write-Host '   send --code printed no code: the WebRTC addon did not load'
            $global:LASTEXITCODE = 1
            return
        }
        Write-Host '   send --code made an offer: the WebRTC addon loaded'
        $global:LASTEXITCODE = 0
    } finally {
        Remove-Item -ErrorAction SilentlyContinue send-code.err
        Pop-Location
    }
}

if (-not $Live) {
    Write-Host ''
    Write-Host '== live tests: not asked for (remote.ps1 ci -Live) =='
    exit 0
}
Invoke-Step 'live: Code Exchange' { & bun run test:live:code:cli }
Invoke-Step 'live: PIN Exchange' { & bun run test:live:pin:cli }
Invoke-Step 'live: Tor' { & bun run test:live:tor:cli }
Invoke-Step 'live: tor-test' { & bun run cli tor-test }
