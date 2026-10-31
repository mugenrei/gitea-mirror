#!/usr/bin/env python3
"""Recheck importer v1 GitHub manifests against the live GitHub GraphQL API.

Runs on GitHub Actions with GITHUB_TOKEN. Missing/private/disabled/empty repos
are quarantined; API errors abort WITHOUT replacing the last verified manifest.
Uses GraphQL aliases to check thousands of repos with ~45 authenticated calls.
"""
import argparse
import collections
import datetime
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib import error, request

API = "https://api.github.com/graphql"
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "catalogs/2026-10-22-all-new-2090.json"
DEST = ROOT / "catalogs/verified"
NAME = re.compile(r"^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)$", re.I)
FIELDS = "nameWithOwner url isArchived isDisabled isEmpty isPrivate diskUsage"
MAX_BATCH = 45


def key(url):
    return url.lower().rstrip("/").removesuffix(".git")


def query_batch(rows, token, retries=5):
    fragments = []
    for i, row in enumerate(rows):
        m = NAME.fullmatch(row["url"])
        if not m:
            raise ValueError("invalid repository URL: " + row["url"])
        owner, name = m.groups()
        fragments.append(
            "r%d: repository(owner: %s, name: %s) { %s }"
            % (i, json.dumps(owner), json.dumps(name), FIELDS)
        )
    body = json.dumps({"query": "query VerifyRepositories { " + " ".join(fragments) + " }"}).encode("utf-8")
    for attempt in range(retries):
        req = request.Request(API, data=body, headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mugenrei-gitea-mirror-catalog-validator",
            "Content-Type": "application/json",
        }, method="POST")
        try:
            with request.urlopen(req, timeout=45) as resp:
                payload = json.load(resp)
            if not isinstance(payload.get("data"), dict):
                raise RuntimeError("GraphQL returned no data: " + str(payload.get("errors", []))[:500])
            # Repository resolution errors may occur for each non-public URL;
            # data will still include all other aliases.
            errors_by_alias = collections.defaultdict(list)
            for err in payload.get("errors", []):
                path = err.get("path") or []
                if path and isinstance(path[0], str):
                    errors_by_alias[path[0]].append(str(err.get("message", ""))[:200])
            return [
                (payload["data"].get("r%d" % i), errors_by_alias.get("r%d" % i, []))
                for i in range(len(rows))
            ]
        except error.HTTPError as exc:
            code = exc.code
            if code in (401, 404):
                raise RuntimeError("GitHub GraphQL authentication/endpoint failed (HTTP %d)" % code)
            if code not in (403, 429, 500, 502, 503, 504) or attempt == retries - 1:
                raise
            retry = exc.headers.get("Retry-After")
            pause = min(90, max(2, int(retry))) if retry and retry.isdigit() else min(90, 2 ** (attempt + 1) * 3)
        except (TimeoutError, OSError, RuntimeError) as exc:
            if attempt == retries - 1:
                raise
            pause = min(60, 2 ** (attempt + 1) * 3)
        print("Retrying GraphQL batch after %ds (attempt %d/%d)" % (pause, attempt + 1, retries), flush=True)
        time.sleep(pause)
    raise RuntimeError("GraphQL retry budget exceeded")


def classify(row, obj, errors):
    entry = {"originalUrl": row["url"], "destinationOrg": row.get("destinationOrg"),
             "category": row.get("category"), "mirror": row.get("mirror", True)}
    if not isinstance(obj, dict):
        if errors and all(("Could not resolve to a Repository" in e or "NOT_FOUND" in e) for e in errors):
            return "unavailable", dict(entry, reason="not_found_or_inaccessible", apiErrors=errors)
        return "review", dict(entry, reason="ambiguous_or_missing_graphql_response", apiErrors=errors)
    if obj.get("isPrivate"):
        return "unavailable", dict(entry, reason="private")
    if obj.get("isDisabled"):
        return "unavailable", dict(entry, reason="disabled")
    if obj.get("isEmpty"):
        return "unavailable", dict(entry, reason="empty")
    canonical = obj.get("url")
    if not isinstance(canonical, str) or not NAME.fullmatch(canonical):
        return "review", dict(entry, reason="unexpected_canonical_url", apiResponse=canonical)
    result = dict(entry, url=canonical,
                  archived=bool(obj.get("isArchived")),
                  githubReportedDiskUsageKiB=obj.get("diskUsage"),
                  renamed=(key(canonical) != key(row["url"])))
    return "valid", result


def manifest(rows):
    return {
        "version": 1,
        "defaults": {"destinationOrg": "decomps", "mirror": True},
        "repositories": [
            {"url": r["url"], "destinationOrg": r["destinationOrg"], "category": r["category"],
             **({"mirror": False} if not r["mirror"] else {})}
            for r in rows
        ],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=DEST)
    parser.add_argument("--batch-size", type=int, default=MAX_BATCH)
    args = parser.parse_args()
    if args.batch_size < 1 or args.batch_size > MAX_BATCH:
        parser.error("batch size must be between 1 and 45")
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        parser.error("GITHUB_TOKEN or GH_TOKEN required for live verification")
    rows = json.loads(args.source.read_text(encoding="utf-8"))["repositories"]
    print("Auditing %d repository URLs in batches of %d" % (len(rows), args.batch_size), flush=True)

    valid, unavailable, review = [], [], []
    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        try:
            outcomes = query_batch(batch, token)
        except Exception as exc:
            # Fail closed: do not publish a partially verified list.
            raise RuntimeError("Live verification failed at entries %d-%d: %s" %
                               (start + 1, start + len(batch), exc)) from exc
        for row, (obj, errs) in zip(batch, outcomes):
            label, item = classify(row, obj, errs)
            {"valid": valid, "unavailable": unavailable, "review": review}[label].append(item)
        print("Checked %4d/%d: valid=%d unavailable=%d review=%d" %
              (min(len(rows), start + len(batch)), len(rows), len(valid), len(unavailable), len(review)),
              flush=True)
    if review:
        # GraphQL issues are not evidence a repository is absent; quarantine
        # them from ready-to-mirror files until a later retry/manual check.
        print("WARNING: %d ambiguous responses require review" % len(review), file=sys.stderr)

    # Prevent duplicate canonical URLs and duplicate Gitea destination names.
    # A move/rename cannot silently overwrite an unrelated repository.
    used_urls = set()
    used_targets = set()
    deduped = []
    for r in sorted(valid, key=lambda x: (not x["mirror"], x["url"].lower())):
        target = r["destinationOrg"].lower() + "/" + r["url"].split("/")[-1].lower()
        urlkey = key(r["url"])
        if urlkey in used_urls:
            review.append(dict(r, reason="canonical_url_duplicate"))
        elif target in used_targets:
            review.append(dict(r, reason="destination_name_collision"))
        else:
            deduped.append(r)
            used_urls.add(urlkey)
            used_targets.add(target)

    usable = [r for r in deduped if r["mirror"]]
    trackonly = [r for r in deduped if not r["mirror"]]
    families = {
        "playstation": ("ps1", "ps2", "ps3", "ps4", "ps5", "psp"),
        "nintendo": ("nes", "snes", "n64", "gamecube", "wii", "wiiu", "switch",
                     "gb", "gbc", "gba", "nds", "3ds", "virtualboy"),
        "xbox": ("xbox", "xbox360", "xboxone"),
        "sega": ("mastersystem", "genesis", "gamegear", "sega32x", "segacd", "saturn", "dreamcast"),
        "pc": ("pc", "pc-engines", "pc-ports", "pc98", "mac"),
    }
    byfamily = collections.defaultdict(list)
    for r in usable:
        category = r["category"].lower()
        platform = category.split("-")[0]
        for family, members in families.items():
            if any(category == p or category.startswith(p + "-") for p in members):
                byfamily[family].append(r)
                break
        else:
            byfamily["other"].append(r)

    stats = {
        "checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sourceEntries": len(rows),
        "verifiedReadyToMirror": len(usable),
        "verifiedTrackOnly": len(trackonly),
        "unavailableOrInaccessible": len(unavailable),
        "requiresReview": len(review),
        "archivedButAvailable": sum(r["archived"] for r in deduped),
        "renamedOrTransferred": sum(r["renamed"] for r in deduped),
        "platformMirrorCounts": {k: len(v) for k, v in sorted(byfamily.items())},
        "notes": [
            "Unavailable includes private/inaccessible, not necessarily deleted.",
            "GraphQL verifies repository identity and public availability, not code correctness.",
            "The original discovery catalog was not deleted.",
        ],
    }

    args.output.mkdir(parents=True, exist_ok=True)
    def write(name, value):
        target = args.output / name
        target.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("Wrote", target, flush=True)

    write("latest-valid-mirror.json", manifest(usable))
    write("latest-valid-trackonly.json", manifest(trackonly))
    write("latest-valid-all.json", manifest(usable + trackonly))
    for family, members in sorted(byfamily.items()):
        write("latest-" + family + ".json", manifest(members))
    write("latest-unavailable.json", {"checkedAtUtc": stats["checkedAtUtc"], "repositories": unavailable})
    write("latest-review.json", {"checkedAtUtc": stats["checkedAtUtc"], "repositories": review})
    write("latest-repository-report.json", {"summary": stats, "repositories": deduped})
    write("latest-stats.json", stats)
    print(json.dumps(stats, indent=2), flush=True)


if __name__ == "__main__":
    main()
