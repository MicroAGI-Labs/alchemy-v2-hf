import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  isRepoId,
  validateEndpointPatterns,
  validateHubName,
  validatePermissions,
  validateRepoIds,
  validateRepoPermissions,
} from "../../src/Client/Validation.ts";

/** Run a validator and return `undefined` on success or the message on failure. */
const check = (effect: Effect.Effect<void, { message: string }>) =>
  Effect.runSync(
    effect.pipe(
      Effect.map(() => undefined),
      Effect.catch((e) => Effect.succeed(e.message)),
    ),
  );

describe("isRepoId", () => {
  test("accepts a 24-hex ObjectId in either case", () => {
    expect(isRepoId("6a6f8f4083f1c297d4dbb0d7")).toBe(true);
    expect(isRepoId("6A6F8F4083F1C297D4DBB0D7")).toBe(true);
  });

  test("rejects the namespace/name form and wrong lengths", () => {
    expect(isRepoId("MicroAGI-Labs/datasets")).toBe(false);
    expect(isRepoId("6a6f8f4083f1c297d4dbb0d")).toBe(false);
    expect(isRepoId("6a6f8f4083f1c297d4dbb0d77")).toBe(false);
    expect(isRepoId("")).toBe(false);
  });
});

describe("validateRepoIds", () => {
  test("an absent list is fine", () => {
    expect(check(validateRepoIds(undefined))).toBeUndefined();
  });

  test("names the offending value and where the right one comes from", () => {
    const message = check(validateRepoIds(["MicroAGI-Labs/datasets"]));
    expect(message).toContain('"MicroAGI-Labs/datasets"');
    expect(message).toContain("24-hex repo _id");
    expect(message).toContain("bucketId");
    expect(message).toContain("`_id`");
  });

  test("reports every invalid entry at once", () => {
    const message = check(validateRepoIds(["a/b", "6a6f8f4083f1c297d4dbb0d7", "c"]));
    expect(message).toContain('"a/b"');
    expect(message).toContain('"c"');
    expect(message).not.toContain("6a6f8f4083f1c297d4dbb0d7");
  });
});

describe("validateEndpointPatterns", () => {
  test("20 patterns is the limit, 21 is not", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    expect(check(validateEndpointPatterns(make(20)))).toBeUndefined();
    expect(check(validateEndpointPatterns(make(21)))).toContain("at most 20");
  });

  test("256 characters is the per-pattern limit", () => {
    expect(check(validateEndpointPatterns(["x".repeat(256)]))).toBeUndefined();
    expect(check(validateEndpointPatterns(["x".repeat(257)]))).toContain(
      "at most 256 characters",
    );
  });
});

describe("permission enums", () => {
  test("all 13 org permissions are accepted", () => {
    expect(
      check(
        validatePermissions([
          "repo.content.read",
          "repo.write",
          "inference.serverless.write",
          "inference.endpoints.infer.write",
          "inference.endpoints.write",
          "org.read",
          "org.write",
          "collection.read",
          "collection.write",
          "resourceGroup.write",
          "job.write",
          "org.serviceAccounts.read",
          "org.serviceAccounts.write",
        ]),
      ),
    ).toBeUndefined();
  });

  test("an unknown permission is named alongside the valid set", () => {
    const message = check(validatePermissions(["repo.read"]));
    expect(message).toContain('"repo.read"');
    expect(message).toContain("repo.content.read");
  });

  test("repoPermissions only allows the two repo-scoped grants", () => {
    expect(check(validateRepoPermissions(["repo.write"]))).toBeUndefined();
    expect(check(validateRepoPermissions(["org.read"]))).toContain('"org.read"');
  });
});

describe("validateHubName", () => {
  test("accepts realistic namespaces and bucket names", () => {
    for (const name of ["MicroAGI-Labs", "datasets", "a", "a.b_c-d", "x1"]) {
      expect(check(validateHubName(name, "namespace"))).toBeUndefined();
    }
  });

  test("rejects anything that would break out of a URL path", () => {
    for (const name of ["", "a/b", "with space", "-leading", "trailing-"]) {
      expect(check(validateHubName(name, "namespace"))).toContain("namespace");
    }
  });
});
