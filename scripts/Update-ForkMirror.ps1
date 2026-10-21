#Requires -Version 5.1
<#
.SYNOPSIS
Safely replace an existing Gitea Mirror container with the GHCR image built
from your own fork. Never deletes storage or invokes 'down -v'.
.DESCRIPTION
Uses the existing minimal Compose file and optional archive overlay. Pulls
the image BEFORE downtime, then stops the old container to copy a consistent
backup of /app/data. Preserves .env. Runs one liveness test after upgrade.
Rollback of a migrated database is manual and requires the backup.
.EXAMPLE
.\scripts\Update-ForkMirror.ps1 -DryRun
.\scripts\Update-ForkMirror.ps1
#>
[CmdletBinding()]
param(
    [string]$Image = 'ghcr.io/mugenrei/gitea-mirror:edge',
    [string]$CompanionUrl = 'http://localhost:4321',
    [switch]$DryRun,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$previousForkImage = [Environment]::GetEnvironmentVariable('FORK_IMAGE','Process')

function Assert-Docker {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (Docker exit code $LASTEXITCODE). The existing data has not been deleted."
    }
}

function Step {
    param([string]$Message)
    Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

Push-Location $repoRoot
try {
    foreach ($required in @('docker-compose.alt.yml','docker-compose.fork-image.yml')) {
        if (-not (Test-Path $required)) { throw "Missing $required. Run from the cloned fork's folder." }
    }

    $files = @('-f','docker-compose.alt.yml')
    if (Test-Path 'docker-compose.archive.yml') {
        $files += @('-f','docker-compose.archive.yml')
    }
    $files += @('-f','docker-compose.fork-image.yml')
    $env:FORK_IMAGE = $Image

    Step "Checking the Compose configuration"
    & docker compose @files config --quiet
    Assert-Docker 'Compose configuration'
    $resolvedImages = @(& docker compose @files config --images)
    Assert-Docker 'Compose image selection'
    if ($resolvedImages -notcontains $Image) {
        throw "Unexpected resolved image. Expected $Image; got: $($resolvedImages -join ', ')"
    }

    Step "Inspecting the existing container"
    $mountsJson = & docker inspect gitea-mirror --format '{{json .Mounts}}'
    Assert-Docker 'Inspect container mounts'
    $mounts = @($mountsJson | ConvertFrom-Json)
    if (@($mounts | Where-Object { $_.Destination -eq '/app/data' }).Count -eq 0) {
        throw 'Existing container has no /app/data mount. Aborting to avoid losing the companion database.'
    }
    $oldImage = (& docker inspect gitea-mirror --format '{{.Image}}').Trim()
    Assert-Docker 'Inspect existing image'
    $wasRunning = ((& docker inspect gitea-mirror --format '{{.State.Running}}').Trim() -eq 'true')
    Assert-Docker 'Inspect container running state'
    Step "Current image ID: $oldImage"
    Step "Desired image: $Image"

    if ($DryRun) {
        Step 'DRY RUN complete. No image pulled, no container stopped, no backup or replacement performed.'
        return
    }

    Step "Pulling the new image BEFORE stopping the existing installation"
    & docker pull $Image
    Assert-Docker 'Pull fork image'

    if (-not $Yes) {
        $approval = Read-Host 'Type UPDATE to stop the companion, make a database backup, and replace the image'
        if ($approval -cne 'UPDATE') {
            Step 'Cancelled without stopping the existing container'
            return
        }
    }

    $backupParent = Join-Path (Split-Path -Parent $repoRoot) 'gitea-mirror-backups'
    $backupDir = Join-Path $backupParent (Get-Date -Format 'yyyyMMdd-HHmmss')
    New-Item -Path $backupDir -ItemType Directory -Force | Out-Null
    # Backups deliberately live OUTSIDE the Docker build context and local git checkout.
    Set-Content -LiteralPath (Join-Path $backupDir 'previous-image-id.txt') -Value $oldImage -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $backupDir 'target-image.txt') -Value $Image -Encoding ASCII

    Step 'Stopping companion to make a consistent SQLite backup'
    if ($wasRunning) {
        & docker stop gitea-mirror
        Assert-Docker 'Stop container'
    }
    Step "Copying the stopped container's /app/data into $backupDir"
    # docker cp works for both bind mounts and Docker-managed volumes.
    & docker cp 'gitea-mirror:/app/data' $backupDir
    Assert-Docker 'Copy companion data'
    $dbBackup = Join-Path (Join-Path $backupDir 'data') 'gitea-mirror.db'
    if (-not (Test-Path -LiteralPath $dbBackup)) {
        throw "Backup verification failed: $dbBackup does not exist. Existing container was NOT replaced. Use docker start gitea-mirror."
    }
    if ((Get-Item -LiteralPath $dbBackup).Length -le 0) {
        throw "Backup verification failed: database file is empty. Existing container was NOT replaced. Use docker start gitea-mirror."
    }
    if (Test-Path -LiteralPath '.env') {
        Copy-Item -LiteralPath '.env' -Destination (Join-Path $backupDir '.env') -Force
    }
    Step "Verified database backup ($((Get-Item $dbBackup).Length) bytes)"

    Step 'Starting replacement with the same mounts and existing .env'
    & docker compose @files up -d --no-build --no-deps --force-recreate gitea-mirror
    Assert-Docker 'Recreate companion'

    $healthUrl = $CompanionUrl.TrimEnd('/') + '/api/health/live'
    $healthy = $false
    for ($attempt = 1; $attempt -le 24; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 6 -UseBasicParsing
            if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).status -eq 'ok') {
                $healthy = $true
                break
            }
        } catch {
            # Startup may need time to finish the database migration.
        }
        Start-Sleep -Seconds 5
    }
    if (-not $healthy) {
        Write-Warning "Replacement did not pass liveness at $healthUrl."
        Write-Warning "Backup: $backupDir"
        Write-Warning "Do not reuse the old image with a newly migrated database without restoring the backup."
        & docker logs --tail 60 gitea-mirror
        throw 'New companion failed to pass the liveness check. Investigate container logs before attempting rollback.'
    }

    Step 'Fork image upgrade succeeded. The HTTP process is responding.'
    Step "Backup: $backupDir"
    Step 'Check the Web UI, account, existing repositories, and /api/health before bulk import.'
    & docker compose @files ps
} finally {
    if ($null -eq $previousForkImage) {
        Remove-Item Env:FORK_IMAGE -ErrorAction SilentlyContinue
    } else {
        $env:FORK_IMAGE = $previousForkImage
    }
    Pop-Location
}
