# Repository Lists (v1)

Use **Repositories → Import List** to import repositories into Gitea Mirror from a
versioned JSON manifest, a CSV file, or a plain list of HTTPS URLs.

Repository lists are user-managed files. They are useful for thematic Gitea
organizations such as `decomps`, `unreal-plugins`, `blender-addons`, and a
general-purpose `mirrors` fallback.

## Canonical JSON

```json
{
  "version": 1,
  "defaults": {
    "destinationOrg": "mirrors",
    "mirror": true
  },
  "repositories": [
    {
      "url": "https://github.com/zeldaret/oot",
      "destinationOrg": "decomps",
      "category": "n64-decomp",
      "notes": "Matching decompilation"
    },
    {
      "url": "https://github.com/n64decomp/sm64",
      "destinationOrg": "decomps",
      "mirror": false
    }
  ]
}
```

Required: `version: 1` and `repositories` array of objects with `url`.

Optional fields:
- `defaults.destinationOrg`: destination Gitea organization if the entry has none.
- `defaults.mirror`: whether to start mirroring after adding (default: true).
- `destinationOrg`: overrides default organization per repository.
- `mirror`: overrides default mirror behavior. `false` tracks without mirroring.
- `category`, `notes`: list annotations shown on preview, **not** written to
  repository topics or descriptions by v1. Keep the manifest in version control.

## CSV

```csv
url,destinationOrg,mirror,category,notes
https://github.com/zeldaret/oot,decomps,true,n64-decomp,matching decomp
https://github.com/n64decomp/sm64,decomps,false,n64-decomp,
```

Header must include `url` and can include the other columns in any order.
CSV accepts RFC 4180 quoted commas and newlines. Missing destination falls
back to your companion's configured destination strategy, not a JSON default.

## Simple URL list

```text
# repositories to import under the configured default destination
https://github.com/zeldaret/oot
https://github.com/n64decomp/sm64
```

This is quickest for ad hoc lists. Use JSON or CSV when choosing organizations.

## Safeguards and limitations

- A preview validates all entries before starting network requests.
- Maximum 2 MB input, 5,000 entries. Only HTTPS URLs without credentials,
  query parameters or fragments are accepted.
- Repeated source URL + destination is de-duplicated; contradictory duplicates
  and duplicate repository names in the same destination organization are
  reported as errors.
- It looks up already-tracked repositories first. It **never** uses
  `force: true`, moves existing mirrors, recreates deleted Gitea repositories,
  or changes an existing repository's destination.
- Existing completed mirrors are skipped. Existing imported entries can be
  mirrored, and in-progress entries are waited on. Existing failed/skipped
  entries require manual investigation; they are not automatically retried.
- For `mirror: true`, the browser starts **one** mirror job, polls its state,
  and waits for completion before starting another. This is intentionally
  conservative to avoid flooding a constrained SQLite/Docker installation.
- The browser tab **must remain open** for this v1 runner. Closing or pausing
  leaves completed work intact; load the same file again to reconcile it and
  continue. Do not assume a timed-out write failed: the app stops on ambiguous
  connection failure, and a future run consults the tracked list.
- Destination organizations must exist, and the connected source host must be
  configured in **Connections**. GitLab supports nested groups.
- The runner does not provide permanent history preservation. Protect the
  Gitea repository storage and companion database with independent backups.
- Importing 5,000 repositories sequentially may take many hours; background
  durable server-side jobs and archival protections are planned separately.

## Deploying this fork

This feature is not present in the published
`ghcr.io/raylabshq/gitea-mirror:latest` image. Build and run the fork's
feature branch or wait for its integration into your custom image. Back up
`/app/data` before switching images; the database is persistent across
compatible application versions.

## Programmatic automation

The UI deliberately reuses the existing authenticated endpoints:
`GET /api/github/repositories`,
`POST /api/sync/repository` (per repo), and
`POST /api/job/mirror-repo` (one repo at a time). There is no new
long-running API request that blocks HTTP for a whole list. The JSON schema
can also be consumed by a future independent CLI or durable job queue.
