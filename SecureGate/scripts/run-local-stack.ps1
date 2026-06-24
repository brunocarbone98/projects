#requires -Version 5.1
<#
.SYNOPSIS
    Bring up the whole Shipping Hub stack locally and (optionally) run the SecureGate suite.

.DESCRIPTION
    Every test under com.securegate is an *integration* test: it talks to a running
    Shipping Hub over HTTP. When the stack is down, REST Assured fails every test with
    "java.net.ConnectException: Connection refused" - which looks like "all tests failed"
    even though nothing is wrong with the test code.

    This script starts the four moving parts the suite needs and waits until the API is
    healthy, so the suite has something to talk to:

        PostgreSQL   :5432   (bundled in %USERPROFILE%\sg-tools, or your own)
        pricing      :8001   FastAPI  (services/pricing)   -> OPTIONAL: the API falls back to an
                                                            identical local quote calc if it is down
        labels       :8002   FastAPI  (services/labels)    -> OPTIONAL: not exercised by the suite
        API          :4000   Express + Prisma             -> what the suite calls
        web          :3000   Next.js                      -> only needed for @ui tests

    Verified working in a clean sandbox (June 2026): with the bundled Node + PostgreSQL in
    %USERPROFILE%\sg-tools and a local Chrome, all 44 tests pass even without Python
    (the pricing/labels services are optional - see above).

.EXAMPLE
    pwsh SecureGate\scripts\run-local-stack.ps1
        Starts the stack and waits for /health.

.EXAMPLE
    pwsh SecureGate\scripts\run-local-stack.ps1 -RunTests
        Starts the stack, waits for /health, then runs `mvnw verify -Denv=local`.

.EXAMPLE
    pwsh SecureGate\scripts\run-local-stack.ps1 -RunTests -Headed
        Same, but the Selenium UI tests open a real, visible Chrome window (-Dheadless=false).
#>
[CmdletBinding()]
param(
    [switch]$RunTests,
    # Open a real, visible Chrome window for the Selenium UI tests instead of running headless.
    [switch]$Headed,
    # Extra args passed straight to mvnw, e.g. -MvnArgs '-DexcludedGroups=' for the full set.
    [string]$MvnArgs = ''
)

$ErrorActionPreference = 'Stop'

# --- paths --------------------------------------------------------------------
$repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..')         # ...\projects
$hub        = Join-Path $repoRoot 'FullStackHub'
$secureGate = Join-Path $repoRoot 'SecureGate'
$tools      = Join-Path $env:USERPROFILE 'sg-tools'

# Prefer the bundled toolchain in sg-tools; fall back to whatever is on PATH.
$nodeDir = Join-Path $tools 'node-v22.12.0-win-x64'
$pnpm    = if (Test-Path (Join-Path $nodeDir 'pnpm.CMD')) { Join-Path $nodeDir 'pnpm.CMD' } else { 'pnpm' }
$pgBin   = Join-Path $tools 'pg\pgsql\bin'
$pgData  = Join-Path $tools 'pgdata'
if (Test-Path $nodeDir) { $env:Path = "$nodeDir;$env:Path" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- 1. PostgreSQL ------------------------------------------------------------
function Test-Port($port) {
    try { (Test-NetConnection 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded }
    catch { $false }
}

# Start the bundled cluster in sg-tools. Returns $true if pg_ctl reported success.
function Start-BundledPostgres {
    if (-not (Test-Path (Join-Path $pgBin 'pg_ctl.exe'))) {
        Write-Warning 'No bundled PostgreSQL cluster in sg-tools. Start your own Postgres (docker compose up -d in FullStackHub).'
        return $false
    }
    & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $tools 'pg.log') -w start
    return ($LASTEXITCODE -eq 0)
}

Write-Step 'PostgreSQL (:5432)'
if (Test-Port 5432) {
    Write-Host '    already listening - reusing it'
} else {
    Start-BundledPostgres | Out-Null
}

# --- 2. API .env --------------------------------------------------------------
$apiDir = Join-Path $hub 'apps\api'
$envFile = Join-Path $apiDir '.env'
if (-not (Test-Path $envFile)) {
    Write-Step 'apps/api/.env (from .env.example)'
    Copy-Item (Join-Path $apiDir '.env.example') $envFile
}

# --- 3. install + migrate + seed ---------------------------------------------
Push-Location $hub
try {
    if (-not (Test-Path (Join-Path $hub 'node_modules'))) {
        Write-Step 'pnpm install'
        & $pnpm install
    }
    Write-Step 'prisma migrate deploy + generate'
    & $pnpm --filter '@shipping-hub/api' db:deploy
    Write-Step 'seed demo data (idempotent)'
    & $pnpm --filter '@shipping-hub/api' db:seed
} finally {
    Pop-Location
}

# --- 4. Python microservices (pricing/labels) --------------------------------
function Start-PyService($name, $port) {
    $svc = Join-Path $hub "services\$name"
    $venvPy = Join-Path $svc '.venv\Scripts\python.exe'
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $py) { Write-Warning "Python not found - '$name' (:$port) will NOT start. Quote tests need pricing."; return }
    if (-not (Test-Path $venvPy)) {
        Write-Step "create venv for $name"
        & $py -m venv (Join-Path $svc '.venv')
        & $venvPy -m pip install -q -r (Join-Path $svc 'requirements.txt')
    }
    Write-Step "$name (:$port)"
    Start-Process -WindowStyle Hidden -WorkingDirectory $svc `
        -FilePath $venvPy -ArgumentList @('-m','uvicorn','main:app','--host','127.0.0.1','--port',"$port") | Out-Null
}
# Python is optional: if it is missing the API computes quotes locally (identical result) and
# the suite never downloads a label, so the run is still fully green without these services.
Start-PyService 'pricing' 8001
Start-PyService 'labels'  8002

# --- 5. API + web -------------------------------------------------------------
Write-Step 'API (:4000)'
Start-Process -WindowStyle Hidden -WorkingDirectory $hub `
    -FilePath $pnpm -ArgumentList @('--filter','@shipping-hub/api','start') | Out-Null

Write-Step 'web (:3000)'
Start-Process -WindowStyle Hidden -WorkingDirectory $hub `
    -FilePath $pnpm -ArgumentList @('--filter','@shipping-hub/web','dev') | Out-Null

# --- 6. wait for /health ------------------------------------------------------
Write-Step 'waiting for http://localhost:4000/health'
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-RestMethod 'http://localhost:4000/health' -TimeoutSec 2
        if ($r.status -eq 'ok') { $ok = $true; break }
    } catch { }
    Start-Sleep 2
}
if (-not $ok) { throw 'API never became healthy on :4000 - check the API window/logs.' }
Write-Host 'Stack is up. API is healthy.' -ForegroundColor Green

# --- 6a. verify the DATABASE answers, not just /health -----------------------
# /health touches no database, so it stays 200 even when PostgreSQL is down - and then EVERY
# data-backed endpoint returns 500. On Windows the bundled Postgres occasionally crashes (Windows
# exception 0xC0000142, visible in %USERPROFILE%\sg-tools\pg.log) after it has started. Probe a real
# read; if it fails, bring Postgres back up once and re-probe, then fail loudly rather than handing
# the suite a stack on which every test 500s.
$demoTrack = 'http://localhost:4000/api/v1/tracking/PTY-2026-001001-0'
function Test-DbBackedRead {
    try {
        $resp = Invoke-WebRequest $demoTrack -TimeoutSec 5 -UseBasicParsing
        return ([int]$resp.StatusCode -lt 500)
    } catch {
        # Windows PowerShell 5.1 throws on a non-2xx/3xx; read the status off the response.
        # A 4xx (404/429) still means API + database answered - only a 5xx (or a connection error,
        # which leaves no status) counts as "database down".
        $code = 0
        try { $code = [int]$_.Exception.Response.StatusCode } catch {}
        return ($code -ge 400 -and $code -lt 500)
    }
}

Write-Step 'verifying the database answers a real read'
if (-not (Test-DbBackedRead)) {
    Write-Warning 'API is up but a data read returned 5xx - PostgreSQL looks down. Restarting it...'
    if (-not (Test-Port 5432)) { Start-BundledPostgres | Out-Null }
    $dbOk = $false
    for ($i = 0; $i -lt 15; $i++) { if (Test-DbBackedRead) { $dbOk = $true; break }; Start-Sleep 2 }
    if (-not $dbOk) {
        throw 'Database never came back: data-backed endpoints still return 500. Check %USERPROFILE%\sg-tools\pg.log for a 0xC0000142 crash, then re-run this script.'
    }
}
Write-Host 'Database is reachable (data-backed read OK).' -ForegroundColor Green

# --- 6b. wait for the web app + warm up the routes the UI tests hit ----------
# In `next dev` the first hit to a route triggers an on-demand compile that can take >15s -
# longer than the Selenium url-wait - so a cold first UI run can spuriously time out. Pre-warming
# the key routes here makes the UI tests deterministic.
Write-Step 'waiting for http://localhost:3000 + warming UI routes'
$webRoutes = @(
    'http://localhost:3000/en',
    'http://localhost:3000/en/login',
    'http://localhost:3000/en/quote',
    'http://localhost:3000/en/app',
    'http://localhost:3000/en/tracking/PTY-2026-001001-0'
)
for ($r = 0; $r -lt $webRoutes.Count; $r++) {
    $route = $webRoutes[$r]
    for ($i = 0; $i -lt 60; $i++) {
        try { Invoke-WebRequest $route -TimeoutSec 30 -UseBasicParsing | Out-Null; break }
        catch { Start-Sleep 2 }
    }
}
Write-Host 'Web app is up and routes are warm.' -ForegroundColor Green

# --- 7. optionally run the suite ---------------------------------------------
if ($RunTests) {
    $mvnExtra = $MvnArgs.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)
    if ($Headed) {
        Write-Step 'running the SecureGate suite with a VISIBLE browser (mvnw verify -Denv=local -Dheadless=false)'
        $mvnExtra = @('-Dheadless=false') + $mvnExtra
    } else {
        Write-Step 'running the SecureGate suite (mvnw verify -Denv=local)'
    }
    Push-Location $secureGate
    try {
        & .\mvnw.cmd verify -Denv=local $mvnExtra
    } finally {
        Pop-Location
    }
}
