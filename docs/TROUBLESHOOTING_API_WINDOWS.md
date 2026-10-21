# Diagnosing slow imports and an unresponsive dashboard on Docker Desktop (Windows)

The **Add repository** endpoint performs a GitHub metadata lookup before it
returns. Other work (mirror jobs, session authentication, SQLite writes, and
recovery) runs in the same app process. Do not assume a network timeout means
the repository was not imported: first check tracked repositories.

## First: identify the deployment and bottleneck

Use PowerShell **without putting tokens into command lines or log files**.

```powershell
docker inspect gitea-mirror --format '{{json .Mounts}}'
docker inspect gitea-mirror --format 'State={{json .State}}'
docker stats --no-stream gitea-mirror
docker logs --tail 250 --timestamps gitea-mirror
```

If you use `docker-compose.alt.yml`, note that its `./data:/app/data`
bind mount can point at a Windows NTFS folder. The app uses `bun:sqlite`,
which executes SQLite operations synchronously. High-latency filesystem
operations on Docker Desktop's Windows file-sharing layer can block the
HTTP process. The standard `docker-compose.yml` uses a Docker-managed
named volume instead.

**Do not simply switch the volume mount on an existing instance.**
A new empty volume would make the companion appear to have lost its
configuration and jobs. Stop the app, back up `./data` and `.env`, and
migrate the files before changing the mount. Preserve ownership and verify
the SQLite database and any `-wal`/`-shm` files if present.

## Distinguish process stalls from dependency stalls

On the diagnostics branch (not the upstream published Docker image):

```powershell
$base = 'http://localhost:4321'
1..8 | ForEach-Object {
  foreach ($path in @('/api/health/live', '/api/health')) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
      $res = Invoke-WebRequest -Uri ($base + $path) -TimeoutSec 8 -UseBasicParsing
      "$path status=$($res.StatusCode) elapsed=$($watch.ElapsedMilliseconds)ms"
    } catch {
      "$path ERROR elapsed=$($watch.ElapsedMilliseconds)ms: $($_.Exception.Message)"
    }
  }
  Start-Sleep -Seconds 2
}
```

Interpretation:

- **Both live and normal health stall:** the HTTP process/event loop may be
  blocked, or Docker/container networking is unhealthy.
- **Live is fast, normal health is slow:** DB/recovery work is a more likely
  contributor. Compare `[HTTP Slow]` log lines (middleware vs handler).
- **Both health endpoints are fast, Add repository is slow:** prioritize
  source API latency, rate limits, credentials, and the lookup timeout.
- **Container has OOMKilled=true or restarts:** investigate memory limits and
  expensive background jobs before enabling bulk imports.

The liveness route deliberately skips auth, database, recovery, and external
lookups, and reports only whether the HTTP server can respond.

## Repository import and rate limits

An interactive `POST /api/sync/repository` must not wait for
GitHub throttle sleep/retries lasting minutes. The diagnostics branch bounds
upstream GET `/repos/{owner}/{repo}` I/O to 12 seconds and disables the
throttling plugin's long rate-limit waits for that specific metadata lookup.
Background mirroring and other GitHub API requests retain their existing
throttle policy.

Look for `[GitHub] Repository metadata lookup rate-limited`, HTTP status
403/429, and `[HTTP Slow]` messages. The latest version health check is
now performed asynchronously and is no longer required for an HTTP response.

The existing `/api/health` endpoint is still a *readiness-style*
endpoint, not a dependency-free liveness endpoint.

## Archival safety

Do not delete or recreate the companion's SQLite database to fix a timeout.
Do not enable automatic deletion of Gitea mirrors. Keep a copy of the
original source URLs and verify the destination before reattempting imports.
If a request timed out, use the tracked-repositories API to determine whether
it created a record rather than blindly repeating it.
