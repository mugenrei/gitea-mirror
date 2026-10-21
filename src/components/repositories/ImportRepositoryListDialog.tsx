import { useMemo, useRef, useState } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { parseRepositoryList, type RepositoryListEntry } from "@/lib/repository-list";
import { withBase } from "@/lib/base-path";
import type { RepositoryApiResponse } from "@/types/Repository";

type Tracked = {
  id: string;
  fullName: string;
  url?: string;
  sourceUrl?: string | null;
  destinationOrg?: string | null;
  mirroredLocation?: string | null;
  status: string;
};

type ImportProgress = {
  done: number;
  total: number;
  added: number;
  mirrored: number;
  alreadyTracked: number;
  skipped: number;
  failed: number;
  current: string;
};

const SAMPLE = JSON.stringify({
  version: 1,
  defaults: { destinationOrg: "mirrors", mirror: true },
  repositories: [
    { url: "https://github.com/zeldaret/oot", destinationOrg: "decomps", category: "n64" },
    { url: "https://github.com/n64decomp/sm64", destinationOrg: "decomps" },
  ],
}, null, 2);

class TransportError extends Error {}

async function requestJson(path: string, options: RequestInit = {}, timeoutMs = 20_000): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  let response: Response;
  try {
    response = await fetch(withBase(path), {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TransportError("Companion did not respond: " + String(error));
  }
  let body: Record<string, any>;
  try { body = await response.json(); }
  catch { throw new TransportError("Companion returned a non-JSON response (HTTP " + response.status + ")"); }
  return { status: response.status, body };
}

async function trackedRepositories(): Promise<Tracked[]> {
  const { status, body } = await requestJson("/api/github/repositories");
  if (status !== 200 || !body.success || !Array.isArray(body.repositories)) {
    throw new Error(body.error ?? "Could not list tracked repositories");
  }
  return body.repositories as Tracked[];
}

function identityFromUrl(url: string): string | null {
  try {
    const data = parseRepositoryList(url);
    return data.entries[0]?.key ?? null;
  } catch { return null; }
}

function findTracked(repos: Tracked[], entry: RepositoryListEntry): Tracked | undefined {
  return repos.find((repo) => {
    const sourceUrl = repo.url || repo.sourceUrl;
    return typeof sourceUrl === "string" && identityFromUrl(sourceUrl) === entry.key;
  });
}

function destinationConflict(existing: Tracked, desired: string | null): boolean {
  if (!desired) return false;
  const current = existing.mirroredLocation?.split("/")[0] || existing.destinationOrg;
  return !!current && current.toLowerCase() !== desired.toLowerCase();
}

async function waitForMirror(entry: RepositoryListEntry, id: string, stop: () => boolean): Promise<"mirrored" | "failed" | "paused"> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (stop()) return "paused";
    await new Promise<void>((resolve) => setTimeout(resolve, 12_000));
    const rows = await trackedRepositories();
    const current = rows.find((r) => r.id === id);
    if (!current) throw new Error("Tracked repository disappeared: " + entry.url);
    if (current.status === "mirrored" || current.status === "synced") return "mirrored";
    if (current.status === "failed" || current.status === "deleted" || current.status === "archived") return "failed";
  }
  throw new Error("Mirror did not finish within 15 minutes: " + entry.url + ". Re-import to resume after checking its status.");
}

export default function ImportRepositoryListDialog({
  open, onOpenChange, onFinished,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onFinished: () => void | Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState("");
  const stopRef = useRef(false);
  const parsed = useMemo(() => {
    try { return content.trim() ? { result: parseRepositoryList(content), error: "" } : null; }
    catch (e) { return { result: null, error: e instanceof Error ? e.message : String(e) }; }
  }, [content]);
  const result = parsed?.result ?? null;
  const validationErrors = result?.issues.filter((item) => item.level === "error") ?? [];
  const addMessage = (message: string) => {
    setMessages((prev) => [...prev.slice(-99), message]);
  };

  async function importList() {
    if (!result || validationErrors.length || running) return;
    setRunning(true);
    setError("");
    setMessages([]);
    stopRef.current = false;
    const initial: ImportProgress = {
      done: 0, total: result.entries.length, added: 0, mirrored: 0,
      alreadyTracked: 0, skipped: 0, failed: 0, current: "",
    };
    const counts = { ...initial };
    try {
      // One list fetch upfront; new entries are added to this local cache.
      // Never force-update tracked rows, move destinations, or retry an unknown
      // transport failure: a timed-out write may have succeeded already.
      const tracked = await trackedRepositories();
      for (const entry of result.entries) {
        if (stopRef.current) break;
        counts.current = entry.url;
        setProgress({ ...counts });
        let row = findTracked(tracked, entry);
        if (row && destinationConflict(row, entry.destinationOrg)) {
          counts.failed++;
          addMessage("CONFLICT: " + entry.url + " already targets a different organization");
          counts.done++;
          setProgress({ ...counts });
          continue;
        }
        if (!row) {
          const response = await requestJson("/api/sync/repository", {
            method: "POST",
            body: JSON.stringify({
              owner: entry.owner, repo: entry.repo,
              host: entry.host, path: entry.path,
              ...(entry.destinationOrg ? { destinationOrg: entry.destinationOrg } : {}),
            }),
          });
          if (response.status === 409) {
            // It may have been added by another importer. Resolve its identity
            // instead of using force=true (which can unexpectedly reroute it).
            const latest = await trackedRepositories();
            tracked.splice(0, tracked.length, ...latest);
            row = findTracked(tracked, entry);
            if (!row) throw new Error("Duplicate response but no matching tracked row: " + entry.url);
          } else if (response.status === 200 && response.body.success && response.body.repository?.id) {
            row = response.body.repository as Tracked;
            tracked.push(row);
            counts.added++;
            addMessage("Added: " + entry.url);
          } else {
            counts.failed++;
            addMessage("FAILED: " + entry.url + " — " + (response.body.error ?? "HTTP " + response.status));
            counts.done++;
            setProgress({ ...counts });
            continue;
          }
        } else counts.alreadyTracked++;
        if (!row || !entry.mirror) {
          counts.skipped++;
          counts.done++;
          setProgress({ ...counts });
          continue;
        }
        if (row.status === "mirrored" || row.status === "synced") {
          counts.mirrored++;
        } else if (row.status === "imported" || row.status === "mirroring") {
          if (row.status === "imported") {
            const started = await requestJson("/api/job/mirror-repo", {
              method: "POST",
              body: JSON.stringify({ repositoryIds: [row.id] }),
            });
            if (started.status !== 200 || !started.body.success) {
              counts.failed++;
              addMessage("FAILED to start mirror: " + entry.url + " — " + (started.body.error ?? "HTTP " + started.status));
              counts.done++;
              setProgress({ ...counts });
              continue;
            }
            addMessage("Mirroring: " + entry.url);
          }
          const state = await waitForMirror(entry, row.id, () => stopRef.current);
          if (state === "paused") break;
          if (state === "mirrored") {
            counts.mirrored++;
            addMessage("Mirrored: " + entry.url);
          } else {
            counts.failed++;
            addMessage("FAILED mirror: " + entry.url + " (inspect the repository's activity log)");
          }
        } else {
          counts.skipped++;
          addMessage("Skipped existing status " + row.status + ": " + entry.url);
        }
        counts.done++;
        setProgress({ ...counts });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      addMessage("STOPPED: " + message + ". Rerun this file to reconcile tracked entries safely.");
    } finally {
      setRunning(false);
      counts.current = "";
      setProgress({ ...counts });
      void onFinished();
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file || running) return;
    if (file.size > 2_000_000) { setError("Maximum file size is 2 MB"); return; }
    setContent(await file.text());
    setProgress(null);
    setError("");
    setMessages([]);
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!running) onOpenChange(value); }}>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import repository list</DialogTitle>
          <DialogDescription>
            Upload JSON/CSV or paste repository URLs. Review destinations before importing.
            Re-running a file skips already tracked repositories; it never force-updates or moves them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="flex gap-2 items-center text-sm">
            <FileUp className="h-4 w-4" />
            Load .json, .csv, or .txt
            <input type="file" accept=".json,.csv,.txt,text/plain,application/json,text/csv"
              disabled={running} onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }}
              className="block max-w-[225px] text-xs" />
          </label>
          <textarea value={content} onChange={(e) => { setContent(e.target.value); setProgress(null); setError(""); }}
            disabled={running} rows={8} spellCheck={false}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            placeholder={SAMPLE} aria-label="Repository manifest JSON, CSV or URLs" />
          {parsed?.error && <p role="alert" className="text-sm text-destructive">{parsed.error}</p>}
          {result && (
            <div className="space-y-2">
              <p className="text-sm">
                Format: <strong>{result.format}</strong> · {result.entries.length} distinct repositories ·
                {validationErrors.length} errors · {result.issues.length - validationErrors.length} warnings
              </p>
              {result.issues.slice(0, 12).map((issue, i) => (
                <p key={i} className={"text-xs " + (issue.level === "error" ? "text-destructive" : "text-muted-foreground")}>
                  Row {issue.row}: {issue.message}
                </p>
              ))}
              <div className="max-h-40 overflow-auto rounded border text-xs">
                {result.entries.slice(0, 25).map((entry) => (
                  <div key={entry.key} className="flex justify-between gap-2 px-2 py-1 border-b">
                    <span className="truncate" title={entry.url}>{entry.url}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {entry.destinationOrg ?? "default"} · {entry.mirror ? "mirror" : "track only"}
                    </span>
                  </div>
                ))}
                {result.entries.length > 25 && <p className="px-2 py-1 text-muted-foreground">...and {result.entries.length - 25} more</p>}
              </div>
              <p className="text-xs text-muted-foreground">
                Category and notes are annotations in this file; this version does not change Gitea topics.
                Import runs in this browser tab, one mirror at a time. Keep the tab open.
              </p>
            </div>
          )}
          {progress && (
            <div aria-live="polite" className="space-y-1 text-sm rounded border p-2">
              <p>{progress.done} / {progress.total} processed · {progress.added} added · {progress.mirrored} mirrored ·
                {progress.alreadyTracked} tracked · {progress.skipped} skipped · {progress.failed} failed</p>
              {progress.current && <p className="text-xs truncate" title={progress.current}>{progress.current}</p>}
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!!messages.length && (
            <div className="max-h-32 overflow-auto rounded border p-2 font-mono text-xs" aria-label="Import activity">
              {messages.slice(-20).map((message, i) => <div key={i}>{message}</div>)}
            </div>
          )}
          <div className="flex justify-end gap-2">
            {running ? (
              <Button variant="outline" onClick={() => { stopRef.current = true; }}>
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Pause after current request
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
                <Button disabled={!result?.entries.length || validationErrors.length > 0} onClick={() => { void importList(); }}>
                  Import {result?.entries.length ?? 0} repositories
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
