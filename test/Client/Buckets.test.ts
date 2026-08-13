import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  buildCreateBucketBody,
  createBucket,
  deleteBucket,
  findBucket,
  listBuckets,
  setBucketResourceGroup,
  updateBucketSettings,
} from "../../src/Client/Buckets.ts";
import { runStub, stubHub } from "../support.ts";

const NS = "MicroAGI-Labs";
const HEX = "6a6f8f4083f1c297d4dbb0d7";

const detail = (overrides: Record<string, unknown> = {}) => ({
  _id: HEX,
  id: `${NS}/datasets`,
  author: NS,
  private: true,
  repoType: "bucket",
  cdnRegions: [],
  ...overrides,
});

describe("buildCreateBucketBody", () => {
  test("omits keys the caller left unset", () => {
    expect(buildCreateBucketBody({ private: true })).toEqual({ private: true });
  });

  test("passes through every supplied key", () => {
    expect(
      buildCreateBucketBody({
        private: false,
        region: "eu",
        cdn: [{ provider: "gcp", region: "eu" }],
        resourceGroupId: "rg_1",
      }),
    ).toEqual({
      private: false,
      region: "eu",
      cdn: [{ provider: "gcp", region: "eu" }],
      resourceGroupId: "rg_1",
    });
  });
});

describe("createBucket", () => {
  test("creates, then re-GETs to take _id from the authoritative endpoint", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "POST"
        ? // The create reply's `id` is the namespace/name form, which is
          // exactly why it must not be used as the repo id.
          { status: 200, body: { url: "u", name: "datasets", id: `${NS}/datasets` } }
        : { status: 200, body: detail() },
    );

    const result = await runStub(
      createBucket({ namespace: NS, name: "datasets", body: { private: true } }),
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(calls[0]!.path).toBe(`/api/buckets/${NS}/datasets`);
    expect(calls[0]!.body).toEqual({ private: true });
    expect(result.adopted).toBe(false);
    expect(result.bucket._id).toBe(HEX);
    expect(result.bucket.id).toBe(`${NS}/datasets`);
  });

  test("a 409 duplicate-create is adopted, and the id still comes from the GET", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "POST"
        ? {
            status: 409,
            // The 409 body carries an `id`, which is deliberately ignored.
            body: { error: "already exists", url: "u", id: `${NS}/datasets` },
          }
        : { status: 200, body: detail() },
    );

    const result = await runStub(
      createBucket({ namespace: NS, name: "datasets" }),
      layer,
    );

    expect(result.adopted).toBe(true);
    expect(result.bucket._id).toBe(HEX);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  test("a non-409 failure is not swallowed", async () => {
    const { layer } = stubHub(() => ({ status: 403, body: { error: "nope" } }));
    const failure = await Effect.runPromise(
      createBucket({ namespace: NS, name: "datasets" }).pipe(
        Effect.flip,
        Effect.provide(layer),
      ),
    );
    expect(failure._tag).toBe("Forbidden");
  });

  test("an invalid namespace fails before any request", async () => {
    const { layer, calls } = stubHub(() => ({ status: 200 }));
    const failure = await Effect.runPromise(
      createBucket({ namespace: "bad namespace!", name: "datasets" }).pipe(
        Effect.flip,
        Effect.provide(layer),
      ),
    );
    expect(failure._tag).toBe("ConfigError");
    expect(calls).toHaveLength(0);
  });
});

describe("bucket reads and updates", () => {
  test("findBucket turns a 404 into undefined", async () => {
    const { layer } = stubHub(() => ({ status: 404, body: { error: "no" } }));
    expect(await runStub(findBucket({ namespace: NS, name: "x" }), layer)).toBeUndefined();
  });

  test("listBuckets forwards the search term", async () => {
    const { layer, calls } = stubHub(() => ({ status: 200, body: [detail()] }));
    const found = await runStub(
      listBuckets({ namespace: NS, search: "data" }),
      layer,
    );
    expect(calls[0]!.path).toBe(`/api/buckets/${NS}`);
    expect(calls[0]!.searchParams).toEqual({ search: "data" });
    expect(found).toHaveLength(1);
  });

  test("settings PUT uses cdnRegions, not cdn", async () => {
    const { layer, calls } = stubHub(() => ({ status: 200 }));
    await runStub(
      updateBucketSettings({
        namespace: NS,
        name: "datasets",
        body: { private: false, cdnRegions: [{ provider: "aws", region: "us" }] },
      }),
      layer,
    );
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.path).toBe(`/api/buckets/${NS}/datasets/settings`);
    expect(calls[0]!.body).toEqual({
      private: false,
      cdnRegions: [{ provider: "aws", region: "us" }],
    });
  });

  test("a null resourceGroupId detaches the resource group", async () => {
    const { layer, calls } = stubHub(() => ({ status: 200 }));
    await runStub(
      setBucketResourceGroup({
        namespace: NS,
        name: "datasets",
        resourceGroupId: null,
      }),
      layer,
    );
    expect(calls[0]!.path).toBe(`/api/buckets/${NS}/datasets/resource-group`);
    expect(calls[0]!.body).toEqual({ resourceGroupId: null });
  });

  test("deleting an absent bucket succeeds", async () => {
    const { layer } = stubHub(() => ({ status: 404, body: { error: "no" } }));
    await runStub(deleteBucket({ namespace: NS, name: "gone" }), layer);
  });
});
