import { describe, expect, test } from "bun:test";
import { parseRepositoryList, trackedDestinationIssue } from "./repository-list";

describe("repository-list v1", () => {
  test("JSON defaults and per-repository overrides", () => {
    const result = parseRepositoryList(JSON.stringify({
      version: 1,
      defaults: { destinationOrg: "mirrors", mirror: true },
      repositories: [
        { url: "https://github.com/zeldaret/oot", destinationOrg: "decomps", category: "n64" },
        { url: "https://github.com/n64decomp/sm64.git", mirror: false },
      ],
    }));
    expect(result.format).toBe("json");
    expect(result.issues).toEqual([]);
    expect(result.entries.map((x) => [x.destinationOrg, x.mirror, x.repo])).toEqual([
      ["decomps", true, "oot"],
      ["mirrors", false, "sm64"],
    ]);
  });

  test("CSV handles quoted commas, quotes, and newlines", () => {
    const result = parseRepositoryList(
      'url,destinationOrg,mirror,category,notes\r\n' +
      '"https://github.com/zeldaret/oot",decomps,true,n64,"Quoted ""text"",\nsecond line"\r\n'
    );
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].notes).toBe('Quoted "text",\nsecond line');
  });

  test("plain URLs and comments", () => {
    const result = parseRepositoryList(
      "# temporary scouting list\nhttps://github.com/zeldaret/oot\n\nhttps://github.com/n64decomp/sm64\n"
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].destinationOrg).toBeNull();
  });

  test("duplicate sources are skipped and conflicting destinations are rejected", () => {
    const result = parseRepositoryList(JSON.stringify({
      version: 1,
      repositories: [
        { url: "https://github.com/zeldaret/oot", destinationOrg: "decomps" },
        { url: "https://github.com/ZELDARET/OOT.git", destinationOrg: "decomps" },
        { url: "https://github.com/zeldaret/oot", destinationOrg: "mirrors" },
      ],
    }));
    expect(result.entries).toHaveLength(1);
    expect(result.issues.map((i) => i.level)).toEqual(["warning", "error"]);
  });

  test("different upstream owners cannot occupy the same Gitea name", () => {
    const result = parseRepositoryList(JSON.stringify({
      version: 1,
      defaults: { destinationOrg: "decomps" },
      repositories: [
        { url: "https://github.com/one/same-name" },
        { url: "https://github.com/two/same-name" },
      ],
    }));
    expect(result.issues.some((i) => i.message.includes("Destination name collision"))).toBe(true);
  });

  test("nested GitLab groups keep full source path", () => {
    const result = parseRepositoryList(
      'url,destinationOrg\nhttps://gitlab.com/group/nested/project,decomps'
    );
    expect(result.entries[0].path).toEqual(["group", "nested", "project"]);
    expect(result.entries[0].repo).toBe("project");
  });

  test("invalid URLs cannot contain secrets, queries, or HTTP URLs", () => {
    for (const url of [
      "http://github.com/a/b",
      "https://name:secret@github.com/a/b",
      "https://github.com/a/b?token=secret",
      "https://github.com/a/b#readme",
      "https://github.com/a/b/issues",
    ]) {
      const result = parseRepositoryList(JSON.stringify({ version: 1, repositories: [{ url }] }));
      expect(result.issues.some((x) => x.level === "error")).toBe(true);
    }
  });

  test("rejects unsupported versions and malformed CSV", () => {
    expect(() => parseRepositoryList('{"version":2,"repositories":[]}')).toThrow();
    expect(() => parseRepositoryList('url,destinationOrg\n"https://github.com/a/b,decomps')).toThrow();
  });
  test("rejects unknown fields and malformed encoded URL path", () => {
    for (const value of [
      { version: 1, defalts: { destinationOrg: "decomps" }, repositories: [] },
      { version: 1, defaults: { destinationOrgg: "decomps" }, repositories: [] },
      { version: 1, repositories: [{ url: "https://github.com/a/b", destinationOrgg: "decomps" }] },
      { version: 1, repositories: [{ url: "https://github.com/a/b%23hidden" }] },
    ]) {
      try {
        const parsed = parseRepositoryList(JSON.stringify(value));
        expect(parsed.issues.some((issue) => issue.level === "error")).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  test("never assumes a missing destination for already-tracked repositories", () => {
    expect(trackedDestinationIssue("decomps", {})).not.toBeNull();
    expect(trackedDestinationIssue("decomps", { destinationOrg: "mirrors" })).not.toBeNull();
    expect(trackedDestinationIssue("decomps", { mirroredLocation: "mirrors/repo" })).not.toBeNull();
    expect(trackedDestinationIssue("decomps", { destinationOrg: "decomps" })).toBeNull();
    expect(trackedDestinationIssue("decomps", { mirroredLocation: "decomps/repo" })).toBeNull();
    expect(trackedDestinationIssue(null, {})).toBeNull();
  });

});
