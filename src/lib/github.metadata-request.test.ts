import { describe, expect, test } from "bun:test";
import { isSingleRepositoryMetadataRequest } from "./github";

describe("interactive GitHub metadata lookup classification", () => {
  test("recognizes only single-repository GET lookups", () => {
    expect(isSingleRepositoryMetadataRequest("GET", "/repos/zeldaret/oot")).toBe(true);
    expect(isSingleRepositoryMetadataRequest("get", "https://api.github.com/repos/n64decomp/sm64")).toBe(true);
    expect(isSingleRepositoryMetadataRequest("GET", "https://ghe.example.com/api/v3/repos/org/repo")).toBe(true);

    expect(isSingleRepositoryMetadataRequest("POST", "/repos/zeldaret/oot")).toBe(false);
    expect(isSingleRepositoryMetadataRequest("GET", "/repos/zeldaret/oot/issues")).toBe(false);
    expect(isSingleRepositoryMetadataRequest("GET", "/user/repos")).toBe(false);
    expect(isSingleRepositoryMetadataRequest("GET", "")).toBe(false);
  });
});
