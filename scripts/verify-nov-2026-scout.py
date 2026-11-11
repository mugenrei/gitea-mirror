#!/usr/bin/env python3
"""Live re-verification for new November 2026 game decomps, recomps and tooling.

Reads the *entire* previous archive as an exclusion set (including canonical
renames) and the November candidates. Executes authenticated GraphQL batches,
fails closed on provider errors, and produces importer JSON v1 plus quarantine.
The script cannot delete or move existing mirrors.

All source URLs in the output are canonical public GitHub repository URLs.
"""
import collections
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "catalogs" / "2026-11-11-candidates.json"
BASELINE = ROOT / "catalogs" / "2026-11-11-existing-baseline.json"
DEST = ROOT / "catalogs" / "2026-11-11-verified"
OLD_VERIFIER = ROOT / "scripts" / "revalidate-repo-catalog.py"
MIN_DISK_USAGE_KIB = 24

spec = importlib.util.spec_from_file_location("existing_scout_verifier", OLD_VERIFIER)
old = importlib.util.module_from_spec(spec)
spec.loader.exec_module(old)
# Extra metadata for quality gating and distinguishing redundant forks.
old.FIELDS += " isFork parent { nameWithOwner } stargazerCount pushedAt description"


def norm(url):
    return url.lower().rstrip("/").removesuffix(".git")


def identity(url):
    return norm(url).removeprefix("https://github.com/")


def owner_repo(name):
    return norm("https://github.com/" + name)


def extract(rows, token):
    valid, unavailable, review = [], [], []
    for start in range(0, len(rows), 35):
        batch = rows[start:start + 35]
        try:
            results = old.query_batch(batch, token)
        except Exception as exc:
            # No partial catalog writes if GitHub errors or rate limits.
            raise RuntimeError("GitHub API audit aborted at %d/%d: %s" %
                               (start, len(rows), exc)) from exc
        for row, (obj, errs) in zip(batch, results):
            verdict, result = old.classify(row, obj, errs)
            if verdict == "valid":
                result["stars"] = int(obj.get("stargazerCount") or 0)
                result["isFork"] = bool(obj.get("isFork"))
                result["parentRepo"] = obj.get("parent", {}).get("nameWithOwner") if isinstance(obj.get("parent"), dict) else None
                result["lastPushedAt"] = obj.get("pushedAt")
                result["description"] = (obj.get("description") or "")[:250]
                valid.append(result)
            elif verdict == "unavailable":
                unavailable.append(result)
            else:
                review.append(result)
        if start % 175 == 0 or start + len(batch) >= len(rows):
            print("Checked %4d/%d, valid=%d unavailable=%d review=%d" %
                  (min(start + len(batch), len(rows)), len(rows), len(valid), len(unavailable), len(review)),
                  flush=True)
    return valid, unavailable, review


def group_of(category):
    plat = category.split("-")[0]
    if plat in {"ps1", "ps2", "ps3", "ps4", "ps5", "psp", "vita", "pocketstation"}:
        return "playstation"
    if plat in {"nes", "snes", "n64", "gamecube", "wii", "wiiu", "switch", "switch2",
                "gb", "gbc", "gba", "nds", "3ds", "virtualboy"}:
        return "nintendo"
    if plat in {"xbox", "xbox360", "xboxone", "xboxseries"}:
        return "xbox"
    if plat in {"genesis", "mastersystem", "dreamcast", "saturn", "segacd", "gamegear", "sega32x"}:
        return "sega"
    if plat in {"pc", "pc98", "pc-engines", "pc-ports", "mac", "mobile", "web"}:
        return "pc"
    if plat == "tooling":
        return "tools"
    return "other"


def manifest(items):
    return {"version": 1,
            "defaults": {"destinationOrg": "decomps", "mirror": True},
            "repositories": [
                {"url": x["url"], "destinationOrg": x["destinationOrg"],
                 "category": x["category"],
                 **({"mirror": False} if not x["mirror"] else {})}
                for x in items
            ]}


def main():
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("GITHUB_TOKEN (Actions) or GH_TOKEN required")
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    base_urls = {norm(u) for u in baseline["urls"]}
    base_targets = baseline.get("destinationTargets", {})
    incoming = source["repositories"]
    print("Baseline: %d canonical+historic URLs; incoming: %d candidates." %
          (len(base_urls), len(incoming)), flush=True)
    if len(incoming) < 500:
        raise RuntimeError("Refusing to overwrite output: unexpected small candidate catalog")

    valid, unavailable, review = extract(incoming, token)
    candidate_ids = {norm(r["url"]) for r in incoming}
    retained, target_used, seen = [], dict(base_targets), set()

    def best_order(r):
        return (not r["mirror"], r["renamed"], -r.get("stars", 0), r["url"].lower())

    counts = collections.Counter()
    for r in sorted(valid, key=best_order):
        orig = norm(r["originalUrl"])
        canonical = norm(r["url"])
        repo_key = identity(r["url"])
        dest_name = r["destinationOrg"].lower() + "/" + repo_key.split("/")[-1]
        if canonical in base_urls:
            review.append(dict(r, reason="previously_catalogued_canonical_url"))
            counts["previously_catalogued_canonical_url"] += 1
            continue
        if canonical in seen:
            review.append(dict(r, reason="duplicate_canonical_identity_inside_november_scout"))
            counts["duplicate_canonical_identity_inside_november_scout"] += 1
            continue
        if dest_name in target_used and target_used[dest_name] != repo_key:
            review.append(dict(r, reason="gitea_destination_name_collision",
                               conflictingSource=target_used[dest_name]))
            counts["gitea_destination_name_collision"] += 1
            continue

        # Existing public fork of a repository already catalogued may have
        # unique commits, but should not automatically mirror a duplicate.
        parent = r.get("parentRepo")
        parent_id = owner_repo(parent) if parent else None
        parent_baselined = bool(parent_id and parent_id in base_urls)
        size = r.get("githubReportedDiskUsageKiB")
        stars = r.get("stars", 0)
        low_signal = size is None or size < MIN_DISK_USAGE_KIB or (size < 120 and stars == 0)
        if low_signal:
            r["mirror"] = False
            r["triage"] = "tiny_or_low_signal"
            counts["tiny_or_low_signal"] += 1
        elif parent_baselined and stars < 20:
            r["mirror"] = False
            r["triage"] = "fork_of_existing_catalogued_repo"
            counts["fork_of_existing_catalogued_repo"] += 1
        elif r.get("isFork") and stars < 2 and size < 500:
            r["mirror"] = False
            r["triage"] = "low_signal_fork"
            counts["low_signal_fork"] += 1
        else:
            r["triage"] = "normal"
        retained.append(r)
        target_used[dest_name] = repo_key
        seen.add(canonical)

    ready = sorted((r for r in retained if r["mirror"]), key=lambda r: r["url"].lower())
    tracked = sorted((r for r in retained if not r["mirror"]), key=lambda r: r["url"].lower())
    by_group = collections.defaultdict(list)
    for r in ready:
        by_group[group_of(r["category"])].append(r)

    stats = {
        "scanDateUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sourceCandidateEntries": len(incoming),
        "baselineExcludedUrlKeys": len(base_urls),
        "availableUniqueNew": len(retained),
        "verifiedMirrorReady": len(ready),
        "verifiedTrackOnly": len(tracked),
        "missingOrInaccessible": len(unavailable),
        "requiresManualReview": len(review),
        "archivedAvailable": sum(r["archived"] for r in retained),
        "canonicalRedirects": sum(r["renamed"] for r in retained),
        "lowSignalTriage": dict(counts),
        "platformMirrorCounts": {key: len(items) for key, items in sorted(by_group.items())},
        "notes": [
            "No overlap with original 298 + previous 2090 candidates + their verified canonical URLs.",
            "No live-source API outage is interpreted as deletion: such outages abort the audit.",
            "An inaccessible repository may be deleted, renamed without redirect, or private.",
            "A verified public repository is not necessarily a valid or complete decompilation.",
            "Small or low-signal projects and redundant forks are track-only, not deleted.",
        ],
    }

    # Write files only after every API batch succeeded.
    DEST.mkdir(parents=True, exist_ok=True)
    def emit(filename, payload):
        path = DEST / filename
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("Wrote %s (%d bytes)" % (path, path.stat().st_size), flush=True)

    emit("latest-all.json", manifest(ready + tracked))
    emit("latest-mirror.json", manifest(ready))
    emit("latest-trackonly.json", manifest(tracked))
    for group, items in sorted(by_group.items()):
        emit("latest-" + group + ".json", manifest(items))
    emit("latest-unavailable.json", {"repositories": unavailable})
    emit("latest-review.json", {"repositories": review})
    emit("latest-metadata.json", {"repositories": retained})
    emit("latest-stats.json", stats)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
