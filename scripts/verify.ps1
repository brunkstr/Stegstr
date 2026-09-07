# One command: clean clone -> build -> full test matrix.
#
# Proves the repo works from nothing but git, cargo, node, and python --
# not "works on my machine". By default this clones a fresh copy into a
# temp directory and builds/tests THAT, so nothing in your existing working
# tree (uncommitted changes, stale build artifacts, local-only fixes) can
# make the result look better than what a judge cloning the repo actually
# gets.
#
# REAL COLD-START RUNTIME: expect roughly 10-20 minutes end-to-end with no
# warm caches (network and CPU dependent) -- the Rust release build alone
# is the dominant cost, measured at ~7-8 minutes from a completely empty
# target/ with a warm cargo registry cache (a first-ever `cargo build` on
# the machine, which also has to download every crate, will take longer
# still). This is NOT a hang: each step prints a heartbeat line every 20
# seconds, and cargo's own "Compiling <crate>" output is the normal sign
# of life during the long stretch.
#
# Usage:
#   .\scripts\verify.ps1                    # clean clone of the current branch's HEAD commit
#   .\scripts\verify.ps1 -Ref <branch>       # clean clone of a specific branch/tag/commit
#   .\scripts\verify.ps1 -InPlace            # skip cloning, test the current working tree instead
#   .\scripts\verify.ps1 -SkipPython         # skip the channel-simulator Python matrix
#
# Exits 0 iff every step passed. On failure, the temp clone (if any) is left
# in place and its path is printed, so you can inspect what broke.
#
# NOTE on `npm test`: it spawns several worker processes in parallel. If
# something else on the machine is compiling at that exact moment, vitest's
# worker pool can time out waiting for a worker to start and report a
# spurious failure -- a resource-contention flake, not a real test
# failure. Re-running alone resolves it.

param(
    [string]$Ref = "",
    [switch]$InPlace,
    [switch]$SkipPython
)

$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")
$RepoRoot = (Get-Location).Path
$RepoUrl = (git remote get-url origin 2>$null)
if (-not $RepoUrl) { $RepoUrl = $RepoRoot }
if (-not $Ref) { $Ref = (git rev-parse HEAD) }

# Force a predictable build location regardless of the caller's own shell
# environment -- a stray CARGO_TARGET_DIR (some Rust setups export one
# globally to share build caches across projects) would otherwise put the
# compiled binary somewhere other than <clone>/src-tauri/target, which is
# exactly where the channel_simulator Python scripts below expect to find
# it, and where they'd silently fail to find it instead.
Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue

$StepsPassed = New-Object System.Collections.Generic.List[string]
$StepsFailed = New-Object System.Collections.Generic.List[string]
$script:StepNum = 0
$RunStart = Get-Date

function Run-Step {
    param([string]$Name, [string]$Exe, [string[]]$ExeArgs)
    $script:StepNum++
    $startTs = Get-Date
    Write-Host ""
    Write-Host "=== [step $($script:StepNum), $($startTs.ToString('HH:mm:ss'))] $Name ==="
    Write-Host "+ $Exe $($ExeArgs -join ' ')"

    # Deliberately not Start-Process -PassThru: on Windows PowerShell 5.1
    # its returned Process object does not reliably report ExitCode when
    # polled without -Wait (confirmed: HasExited flips true but ExitCode
    # stays blank even after Refresh()) -- silently misreporting every
    # passing step as failed. System.Diagnostics.Process, started and
    # owned directly, does not have that problem; output still streams
    # straight to this console since nothing is redirected.
    #
    # Routed through cmd.exe rather than invoking $Exe directly: npm (and
    # pip, on some installs) resolves to a .cmd shim on Windows, and
    # CreateProcess -- which both Start-Process and Process.Start use --
    # cannot launch a .cmd file directly ("%1 is not a valid Win32
    # application"), unlike PowerShell's own `&` operator or a real shell,
    # which both know to hand it to cmd.exe. Routing everything through
    # cmd.exe /c uniformly sidesteps needing to special-case which tools
    # are shims and which are real .exe files.
    $quotedArgs = ($ExeArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c `"$Exe $quotedArgs`""
    $psi.UseShellExecute = $false
    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        Write-Host ">>> [step $($script:StepNum)] FAILED to start: $Name -- $($_.Exception.Message)" -ForegroundColor Red
    }
    if (-not $proc) {
        # Without this check, `-not $proc.HasExited` below evaluates
        # `-not $null` = $true forever, spinning in an infinite loop
        # instead of ever reporting the failure -- confirmed the hard way.
        $StepsFailed.Add("$Name (failed to start)")
        return
    }

    $lastBeat = Get-Date
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 500
        if (((Get-Date) - $lastBeat).TotalSeconds -ge 20) {
            $elapsed = [int]((Get-Date) - $startTs).TotalSeconds
            Write-Host "    ... still running: $Name (${elapsed}s elapsed)"
            $lastBeat = Get-Date
        }
    }
    $elapsed = [int]((Get-Date) - $startTs).TotalSeconds

    if ($proc.ExitCode -eq 0) {
        $StepsPassed.Add("$Name (${elapsed}s)")
        Write-Host "=== [step $($script:StepNum)] PASSED in ${elapsed}s: $Name ===" -ForegroundColor Green
    } else {
        $StepsFailed.Add("$Name (${elapsed}s)")
        Write-Host ">>> [step $($script:StepNum)] FAILED after ${elapsed}s: $Name" -ForegroundColor Red
    }
}

if ($InPlace) {
    $WorkDir = $RepoRoot
    Write-Host "Testing in place: $WorkDir (not a clean-clone proof)"
} else {
    $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("stegstr-verify-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))
    Write-Host "Clean clone of $RepoUrl @ $Ref into: $WorkDir"
    git clone --quiet $RepoUrl $WorkDir
    if ($LASTEXITCODE -ne 0) { Write-Host "clone failed" -ForegroundColor Red; exit 1 }
    git -C $WorkDir checkout --quiet $Ref
    if ($LASTEXITCODE -ne 0) { Write-Host "checkout of ref '$Ref' failed" -ForegroundColor Red; exit 1 }
}

Set-Location $WorkDir

Run-Step "Rust: release build (stegstr-cli)" "cargo" @("build", "--release", "--bin", "stegstr-cli", "--manifest-path", "src-tauri/Cargo.toml")
Run-Step "Rust: cargo test --release" "cargo" @("test", "--release", "--manifest-path", "src-tauri/Cargo.toml")
Run-Step "Rust: cargo clippy -- -D warnings" "cargo" @("clippy", "--release", "--all-targets", "--manifest-path", "src-tauri/Cargo.toml", "--", "-D", "warnings")

if (Get-Command npm -ErrorAction SilentlyContinue) {
    Run-Step "Frontend: npm install" "npm" @("install", "--no-audit", "--no-fund")
    Run-Step "Frontend: npm test" "npm" @("test")
} else {
    Write-Host ""
    Write-Host "=== Frontend tests skipped: npm not found ==="
    $StepsFailed.Add("Frontend: npm not found")
}

if (-not $SkipPython) {
    $Py = $null
    if (Get-Command python -ErrorAction SilentlyContinue) { $Py = "python" }
    elseif (Get-Command python3 -ErrorAction SilentlyContinue) { $Py = "python3" }

    if ($Py) {
        Push-Location channel_simulator
        Run-Step "Python: pip install -r requirements.txt" $Py @("-m", "pip", "install", "-r", "requirements.txt")
        Run-Step "Python: generate realistic covers" $Py @("gen_realistic_covers.py")
        Run-Step "Python: generate extended covers" $Py @("gen_extended_covers.py")
        Run-Step "Python: run_matrix_rust_cli.py (45/45 expected)" $Py @("run_matrix_rust_cli.py")
        Run-Step "Python: run_matrix_realistic.py (prototype matrix)" $Py @("run_matrix_realistic.py")
        Pop-Location
    } else {
        Write-Host ""
        Write-Host "=== Python matrix skipped: no python/python3 found ==="
        $StepsFailed.Add("Python: interpreter not found")
    }
} else {
    Write-Host ""
    Write-Host "=== Python matrix skipped: -SkipPython ==="
}

$TotalElapsed = [int]((Get-Date) - $RunStart).TotalSeconds
Write-Host ""
Write-Host "==================== SUMMARY ===================="
foreach ($s in $StepsPassed) { Write-Host "PASS  $s" -ForegroundColor Green }
foreach ($s in $StepsFailed) { Write-Host "FAIL  $s" -ForegroundColor Red }
Write-Host "$($StepsPassed.Count) passed, $($StepsFailed.Count) failed -- total ${TotalElapsed}s"

if (-not $InPlace) {
    if ($StepsFailed.Count -eq 0) {
        Set-Location $RepoRoot
        Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
    } else {
        Write-Host "Clean clone left at: $WorkDir (for inspection)"
    }
}

if ($StepsFailed.Count -eq 0) { exit 0 } else { exit 1 }
