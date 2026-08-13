import { describe, expect, test } from "bun:test";
import {
  bucketService,
  bucketSettingsMatch,
  type BucketProps,
  diffBucketProps,
} from "../../src/Resources/Bucket.ts";
import { stubHub } from "../support.ts";
import { drive, driveFailure } from "./lifecycle.ts";

const NS = "MicroAGI-Labs";
const HEX = "6a6f8f4083f1c297d4dbb0d7";

const base: BucketProps = { namespace: NS, name: "datasets", private: true };

const detail = (overrides: Record<string, unknown> = {}) => ({
  _id: HEX,
  id: `${NS}/datasets`,
  private: true,
  cdnRegions: [],
  ...overrides,
});

describe("Bucket diff", () => {
  test("toggling private updates in place", () => {
    expect(diffBucketProps(base, { ...base, private: false })).toBeUndefined();
  });

  test("changing cdn updates in place", () => {
    expect(
      diffBucketProps(base, {
        ...base,
        cdn: [{ provider: "gcp", region: "eu" }],
      }),
    ).toBeUndefined();
  });

  test("renaming replaces", () => {
    expect(diffBucketProps(base, { ...base, name: "other" })).toEqual({
      action: "replace",
    });
  });

  test("changing region replaces — data cannot move between regions", () => {
    expect(
      diffBucketProps(
        { ...base, region: "eu" },
        { ...base, region: "us" },
      ),
    ).toEqual({ action: "replace" });
  });

  test("adding a region to a bucket that never declared one replaces", () => {
    // The Hub picked the original region (quite possibly `us`) and
    // `PUT .../settings` cannot move data between regions, so treating this
    // as a no-op would report success with the data in the wrong
    // jurisdiction.
    expect(diffBucketProps(base, { ...base, region: "eu" })).toEqual({
      action: "replace",
    });
  });

  test("leaving region unset on both sides still does not replace", () => {
    expect(diffBucketProps(base, { ...base, private: false })).toBeUndefined();
  });

  test("dropping the region prop is not a change — it means 'whatever it is'", () => {
    expect(diffBucketProps({ ...base, region: "eu" }, base)).toBeUndefined();
  });
});

describe("bucketSettingsMatch", () => {
  test("an unset prop means 'leave as is'", () => {
    expect(bucketSettingsMatch({}, detail({ private: false }))).toBe(true);
  });

  test("cdn comparison ignores ordering", () => {
    expect(
      bucketSettingsMatch(
        {
          cdn: [
            { provider: "aws", region: "us" },
            { provider: "gcp", region: "eu" },
          ],
        },
        detail({
          cdnRegions: [
            { provider: "gcp", region: "eu" },
            { provider: "aws", region: "us" },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("a differing private flag is a mismatch", () => {
    expect(bucketSettingsMatch({ private: true }, detail({ private: false }))).toBe(
      false,
    );
  });
});

describe("Bucket reconcile", () => {
  test("greenfield creates, re-GETs for _id, and returns both identifiers", async () => {
    const { layer, calls } = stubHub((req, index) => {
      if (index === 0) return { status: 404, body: { error: "no" } };
      if (req.method === "POST") {
        return { status: 200, body: { url: "u", name: "datasets", id: `${NS}/datasets` } };
      }
      return { status: 200, body: detail({ url: "u" }) };
    });

    const attrs = await drive(
      bucketService.reconcile,
      { news: base, olds: undefined, output: undefined },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(attrs.bucketId).toBe(HEX);
    expect(attrs.fullName).toBe(`${NS}/datasets`);
    expect(attrs.namespace).toBe(NS);
    expect(attrs.url).toBe("u");
  });

  test("a duplicate-create 409 is adopted and still sources _id from the GET", async () => {
    const { layer, calls } = stubHub((req, index) => {
      if (index === 0) return { status: 404, body: { error: "no" } };
      if (req.method === "POST") {
        return {
          status: 409,
          body: { error: "already exists", url: "u", id: `${NS}/datasets` },
        };
      }
      return { status: 200, body: detail() };
    });

    const attrs = await drive(
      bucketService.reconcile,
      { news: base, olds: undefined, output: undefined },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(attrs.bucketId).toBe(HEX);
  });

  test("a steady-state deploy issues no writes", async () => {
    const { layer, calls } = stubHub(() => ({ status: 200, body: detail() }));

    await drive(
      bucketService.reconcile,
      {
        news: base,
        olds: base,
        output: {
          bucketId: HEX,
          fullName: `${NS}/datasets`,
          namespace: NS,
          name: "datasets",
          url: "u",
        },
      },
      layer,
    );

    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("a drifted private flag is converged with a settings PUT", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: detail({ private: false }) }
        : { status: 200, body: {} },
    );

    await drive(
      bucketService.reconcile,
      { news: base, olds: base, output: undefined },
      layer,
    );

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/api/buckets/${NS}/datasets/settings`);
    // The full settings body goes out, not just the differing field: the
    // endpoint is a PUT and its merge semantics are unconfirmed.
    expect(put?.body).toEqual({ private: true, cdnRegions: [] });
  });

  test("a cdn-only change still sends `private`, so a PUT cannot make the bucket public", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: detail({ private: true, cdnRegions: [] }) }
        : { status: 200, body: {} },
    );

    await drive(
      bucketService.reconcile,
      {
        // `private` deliberately unset: "leave as is" must survive the PUT.
        news: {
          namespace: NS,
          name: "datasets",
          cdn: [{ provider: "gcp", region: "eu" }],
        },
        olds: base,
        output: undefined,
      },
      layer,
    );

    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      private: true,
      cdnRegions: [{ provider: "gcp", region: "eu" }],
    });
  });

  test("attaching and detaching a resource group", async () => {
    const attach = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: detail() }
        : { status: 200, body: {} },
    );
    await drive(
      bucketService.reconcile,
      { news: { ...base, resourceGroupId: "rg_1" }, olds: base, output: undefined },
      attach.layer,
    );
    expect(
      attach.calls.find((c) => c.path.endsWith("/resource-group"))?.body,
    ).toEqual({ resourceGroupId: "rg_1" });

    const detach = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: detail({ resourceGroup: { id: "rg_1" } }) }
        : { status: 200, body: {} },
    );
    await drive(
      bucketService.reconcile,
      { news: base, olds: base, output: undefined },
      detach.layer,
    );
    expect(
      detach.calls.find((c) => c.path.endsWith("/resource-group"))?.body,
    ).toEqual({ resourceGroupId: null });
  });
});

describe("Bucket delete", () => {
  const output = {
    bucketId: HEX,
    fullName: `${NS}/datasets`,
    namespace: NS,
    name: "datasets",
    url: "u",
  };

  test("an absent bucket is a finished teardown", async () => {
    const { layer } = stubHub(() => ({ status: 404, body: { error: "no" } }));
    await drive(bucketService.delete, { olds: base, output }, layer);
  });

  test("a 403 fails the destroy rather than reporting deleted data as gone", async () => {
    // Swallowing this would drop the bucket from state while the bucket AND
    // ALL ITS DATA remain live on the Hub.
    const { layer } = stubHub(() => ({ status: 403, body: { error: "nope" } }));

    const failure = await driveFailure(
      bucketService.delete,
      { olds: base, output },
      layer,
    );

    expect((failure as { _tag: string })._tag).toBe("Forbidden");
  });
});

describe("Bucket read", () => {
  test("a matching bucketId in state proves ownership", async () => {
    const { layer } = stubHub(() => ({ status: 200, body: detail() }));
    const attrs = (await drive(
      bucketService.read,
      {
        olds: base,
        output: {
          bucketId: HEX,
          fullName: `${NS}/datasets`,
          namespace: NS,
          name: "datasets",
          url: "u",
        },
      },
      layer,
    )) as object;
    expect(Object.getOwnPropertySymbols(attrs)).toHaveLength(0);
  });

  test("a pre-existing bucket with no state is Unowned", async () => {
    const { layer } = stubHub(() => ({ status: 200, body: detail() }));
    const attrs = (await drive(
      bucketService.read,
      { olds: base, output: undefined },
      layer,
    )) as object;
    expect(attrs).toMatchObject({ bucketId: HEX });
    expect(
      Object.getOwnPropertySymbols(attrs).some((s) =>
        String(s).includes("Unowned"),
      ),
    ).toBe(true);
  });

  test("an absent bucket reads as undefined", async () => {
    const { layer } = stubHub(() => ({ status: 404, body: { error: "no" } }));
    expect(
      await drive(bucketService.read, { olds: base, output: undefined }, layer),
    ).toBeUndefined();
  });
});
