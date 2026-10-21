/**
 * Versioned repository lists for bulk imports. Pure (browser/server), no I/O.
 *
 * JSON v1:
 * { "version": 1, "defaults": { "destinationOrg": "mirrors", "mirror": true },
 *   "repositories": [ { "url": "https://github.com/owner/repo", "destinationOrg": "decomps" } ] }
 *
 * CSV headers: url,destinationOrg,mirror,category,notes
 * Plain text: one URL per line, # comments allowed.
 */
export interface RepositoryListEntry {
  url: string;
  host: string;
  path: string[];
  owner: string;
  repo: string;
  destinationOrg: string | null;
  mirror: boolean;
  category: string;
  notes: string;
  key: string;
}

export interface RepositoryListIssue {
  row: number;
  level: "error" | "warning";
  message: string;
}

export interface RepositoryListResult {
  format: "json" | "csv" | "urls";
  entries: RepositoryListEntry[];
  issues: RepositoryListIssue[];
}

const MAX_CHARS = 2_000_000;
const MAX_ROWS = 5_000;
const ORG_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function optionalText(value: unknown, field: string): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error(field + " must be a string");
  return value.trim();
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("mirror must be true or false");
}

function parseUrl(raw: string): Pick<RepositoryListEntry, "url" | "host" | "path" | "owner" | "repo" | "key"> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid repository URL"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port) {
    throw new Error("repository URL must be HTTPS without credentials, query, port or fragment");
  }
  const path = u.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (path.length < 2 || path.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error("URL must identify a repository (owner and name)");
  }
  if (u.hostname.toLowerCase() === "github.com" && path.length !== 2) {
    throw new Error("GitHub URL must contain only owner/repository");
  }
  const repo = path[path.length - 1].replace(/\.git$/i, "");
  if (!repo || repo === "." || repo === "..") throw new Error("repository name is missing");
  path[path.length - 1] = repo;
  const host = u.hostname.toLowerCase();
  // GitLab groups can be nested, so the repository name is the final segment.
  const owner = path[0];
  return {
    url: "https://" + host + "/" + path.join("/"),
    host, path, owner, repo,
    key: host + "/" + path.join("/").toLowerCase(),
  };
}

/** RFC 4180 fields, quoted commas/newlines and escaped double quotes. */
function csvRows(input: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [], field = "", quoted = false, atStart = true;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; }
      else { field += ch; }
    } else if (ch === '"' && atStart) {
      quoted = true; atStart = false;
    } else if (ch === ',') {
      row.push(field); field = ""; atStart = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell.trim())) result.push(row);
      row = []; field = ""; atStart = true;
    } else if (ch === '"') {
      throw new Error("unexpected quote in CSV field");
    } else {
      field += ch; atStart = false;
    }
  }
  if (quoted) throw new Error("unclosed quoted CSV field");
  row.push(field);
  if (row.some((cell) => cell.trim())) result.push(row);
  return result;
}

export function parseRepositoryList(raw: string): RepositoryListResult {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("Repository list is empty");
  if (text.length > MAX_CHARS) throw new Error("List exceeds 2 MB");
  const issues: RepositoryListIssue[] = [];
  const objects: Array<{ value: unknown; row: number }> = [];
  let defaults: Record<string, unknown> = {};
  let format: RepositoryListResult["format"];

  if (text.startsWith("{")) {
    format = "json";
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("Invalid JSON"); }
    const root = record(parsed);
    if (!root || root.version !== 1 || !Array.isArray(root.repositories)) {
      throw new Error("JSON requires version: 1 and a repositories array");
    }
    defaults = root.defaults == null ? {} : (record(root.defaults) ?? (() => { throw new Error("defaults must be an object"); })());
    const rootKeys = new Set(["version", "defaults", "repositories"]);
    if (Object.keys(root).some((key) => !rootKeys.has(key))) throw new Error("Unknown JSON list field");
    const defaultKeys = new Set(["destinationOrg", "mirror"]);
    if (Object.keys(defaults).some((key) => !defaultKeys.has(key))) throw new Error("Unknown JSON defaults field");
    root.repositories.forEach((value, i) => objects.push({ value, row: i + 1 }));
  } else if (/^\s*url\s*,/i.test(text)) {
    format = "csv";
    const data = csvRows(text);
    const header = data.shift()!.map((part) => part.trim());
    if (new Set(header).size !== header.length || !header.includes("url")) {
      throw new Error("CSV requires a unique 'url' header");
    }
    const allowed = new Set(["url", "destinationOrg", "mirror", "category", "notes"]);
    if (header.some((key) => !allowed.has(key))) {
      throw new Error("Unsupported CSV column; use url,destinationOrg,mirror,category,notes");
    }
    for (let i = 0; i < data.length; i++) {
      const fields = data[i];
      if (fields.length !== header.length) {
        issues.push({ row: i + 2, level: "error", message: "CSV column count does not match header" });
        continue;
      }
      const item: Record<string, string> = {};
      header.forEach((name, j) => { item[name] = fields[j]; });
      objects.push({ value: item, row: i + 2 });
    }
  } else {
    format = "urls";
    text.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) objects.push({ value: { url: trimmed }, row: i + 1 });
    });
  }

  if (objects.length > MAX_ROWS) throw new Error("List exceeds 5,000 repositories");
  const defaultOrg = optionalText(defaults.destinationOrg, "defaults.destinationOrg");
  if (defaultOrg && (!ORG_NAME.test(defaultOrg) || defaultOrg === "." || defaultOrg === "..")) {
    throw new Error("Invalid defaults.destinationOrg");
  }
  const defaultMirror = optionalBoolean(defaults.mirror, true);
  const entries: RepositoryListEntry[] = [];
  const seen = new Map<string, RepositoryListEntry>();
  const targets = new Map<string, string>();
  for (const { value, row } of objects) {
    try {
      const item = record(value);
      if (!item) throw new Error("entry must be an object");
      const allowedKeys = new Set(["url", "destinationOrg", "mirror", "category", "notes"]);
      if (Object.keys(item).some((key) => !allowedKeys.has(key))) {
        throw new Error("unknown repository-list entry field");
      }
      const url = optionalText(item.url, "url");
      const parsed = parseUrl(url);
      const destinationOrg = optionalText(item.destinationOrg, "destinationOrg") || defaultOrg || null;
      if (destinationOrg && (!ORG_NAME.test(destinationOrg) || destinationOrg === "." || destinationOrg === "..")) {
        throw new Error("invalid destinationOrg");
      }
      const mirror = optionalBoolean(item.mirror, defaultMirror);
      const category = optionalText(item.category, "category");
      const notes = optionalText(item.notes, "notes");
      if (category.length > 100 || notes.length > 2_000) throw new Error("category or notes exceed size limit");
      const entry: RepositoryListEntry = { ...parsed, destinationOrg, mirror, category, notes };
      const prior = seen.get(entry.key);
      if (prior) {
        if (prior.destinationOrg !== destinationOrg || prior.mirror !== mirror) {
          issues.push({ row, level: "error", message: "Conflicting duplicate: " + entry.url });
        } else {
          issues.push({ row, level: "warning", message: "Duplicate skipped: " + entry.url });
        }
        continue;
      }
      seen.set(entry.key, entry);
      if (destinationOrg) {
        // A Gitea owner cannot have two repositories with identical names.
        const target = destinationOrg.toLowerCase() + "/" + parsed.repo.toLowerCase();
        const previousSource = targets.get(target);
        if (previousSource && previousSource !== entry.key) {
          issues.push({ row, level: "error", message: "Destination name collision at " + target + " (" + previousSource + ")" });
        } else targets.set(target, entry.key);
      }
      entries.push(entry);
    } catch (error) {
      issues.push({ row, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (entries.length === 0 && !issues.some((issue) => issue.level === "error")) {
    issues.push({ row: 0, level: "error", message: "No repositories found" });
  }
  return { format, entries, issues };
}
