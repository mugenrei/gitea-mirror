# Fast updates for mugenrei/gitea-mirror (Windows + Docker Desktop)

The fork already has \`.github/workflows/docker-build.yml\`. On pushes to
\`main\`, it builds and publishes \`ghcr.io/mugenrei/gitea-mirror:edge\`.
This fork's workflow selects \`linux/amd64\` instead of also building arm64,
since the intended Windows Docker Desktop host is x86-64. Upstream continues
to build its original multiarch images. Images built from \`main\` are
development images: the normal build workflow tags release images as
\`latest\`, **not** every main commit.

## First time: publish the fork image

1. On GitHub, open **Actions → Docker Build, Push & Security Scan** in
   \`mugenrei/gitea-mirror\`.
2. Choose **Run workflow → main** after merging this change. You may see an
   automatic main push run already queued; avoid starting duplicates.
3. Wait until the **Build and push Docker image** step succeeds. Full workflow
   may run extra security scans after publication.
4. Verify the container package
   \`ghcr.io/mugenrei/gitea-mirror:edge\` exists in the fork's **Packages**.
5. GitHub's GHCR container packages may start with **private** visibility even
   when the repository is public. To pull anonymously, change the package
   visibility to **Public** in its package settings. Alternatively use a
   registry token with \`read:packages\` and \`docker login ghcr.io\`. Do not
   commit tokens or put them in scripts.

If no Actions runs appear after enabling workflows, use the **Run workflow**
button; enabling Actions after a previous push does not retroactively rerun
the old commit.

## Safe one-command update

Clone the fork and keep the companion's existing \`docker-compose.alt.yml\`,
\`.env\`, and persistent data volume or \`data/\` bind mount.

\`\`\`powershell
git switch main
git pull --ff-only origin main

# Read-only preview (does not pull, stop or recreate anything)
.\scripts\Update-ForkMirror.ps1 -DryRun

# Actual update, requires typing UPDATE to confirm
.\scripts\Update-ForkMirror.ps1
\`\`\`

What the script does:

- Inspects the running \`gitea-mirror\` container and ensures \`/app/data\`
  is mounted.
- Uses \`docker-compose.alt.yml\`, an optional
  \`docker-compose.archive.yml\`, and \`docker-compose.fork-image.yml\` in
  that order. The locally built \`docker-compose.local.yml\` used during the
  initial installation is intentionally omitted.
- Pulls the fork image **before** stopping the old instance. If GHCR is
  inaccessible, the existing installation stays running.
- Asks for explicit confirmation before downtime.
- Stops the companion, backs up \`/app/data\` and the local \`.env\` to a
  timestamped directory named \`gitea-mirror-backups\` **beside** the Git
  checkout, and verifies that the SQLite database is not empty.
- Recreates only the companion container; does **not** delete volumes,
  Gitea repositories, tokens, or existing mirror records.
- Waits for \`/api/health/live\` to respond; then asks the operator to verify
  the authenticated UI and repository list.

The script's health probe uses \`http://localhost:4321\` by default.
For a non-default port or reverse-proxy prefix, supply
\`-CompanionUrl 'https://your-companion.example.com/mirror'\`.

**Important:** A live HTTP response only proves process liveness, not that
existing mirrored repositories or background metadata synchronization work.
Check \`/api/health\`, sign in, and verify a known repository after upgrading.

## Manual equivalent

If you prefer the small number of Compose commands:

\`\`\`powershell
docker pull ghcr.io/mugenrei/gitea-mirror:edge
# STOP the companion and back up its /app/data and .env first!
docker compose -f docker-compose.alt.yml -f docker-compose.fork-image.yml up -d --no-build --force-recreate gitea-mirror
\`\`\`

If you use the archive overlay, include it between the two \`-f\` flags.
Do NOT run \`docker compose down -v\`.

## Reproducibility and rollback

\`:edge\` moves whenever a new main image is published. To pin an older
known-good image, set \`-Image ghcr.io/mugenrei/gitea-mirror:<sha-tag>\` on the
updater. The existing Docker workflow publishes short SHA tags as well as
\`:edge\`. Prefer a tested SHA or an immutable image digest for long-running
archival deployments.

The backup directory records the previous container image ID and a copy of
the pre-upgrade database. An older app image **must not** be restarted
against a newer migrated database unless the older schema is compatible.
For rollback:
1. Stop the new companion, copy aside its current data for investigation.
2. Restore the pre-upgrade \`data/\` or Docker volume contents AND the
   saved \`.env\` from the selected backup.
3. Recreate the old container using the previously recorded image ID/tag
   and the same settings/mount.
4. Verify the dashboard and tracked mirrors.

Do not restore a historical companion database over a newer working one
without considering mirror jobs created since that backup. Gitea's separate
Git repositories are unaffected by these companion database backups.

## Performance notes

Local builds are replaced by \`docker pull\`, but the first GitHub build can
still be slow: the Dockerfile compiles git-lfs and installs dependencies.
GitHub's Buildx cache makes subsequent changes faster. The fork's workflow
skips arm64 compilation to minimize build time for the x86-64 host.

The live HTTP performance issue is a separate concern. If the companion's
SQLite database is on a Windows bind mount, consider a planned, verified
migration to a Linux-backed Docker named volume after collecting diagnostics;
do not change the mount accidentally during an image-only upgrade.
