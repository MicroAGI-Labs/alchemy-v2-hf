import { describe, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import type { ServiceAccountToken } from "../../src/Resources/ServiceAccountToken.ts";
import {
  buildTokenBody,
  diffTokenProps,
  serviceAccountTokenService,
  type ServiceAccountTokenProps,
  tokenScopeMatches,
} from "../../src/Resources/ServiceAccountToken.ts";
import { stubHub } from "../support.ts";
import { drive, driveFailure } from "./lifecycle.ts";

/**
 * `Effect.fn` erases the handler's input type to `any`, so `drive` cannot
 * infer the attributes shape. Annotating the locals restores it — and keeps
 * the assertions honest about what the reconciler actually returns.
 */
type TokenAttrs = ServiceAccountToken["Attributes"];

const ORG = "MicroAGI-Labs";
const SA = "6a6f8f4083f1c297d4dbb0d7";
const REPO = "b".repeat(24);

const base: ServiceAccountTokenProps = {
  organization: ORG,
  serviceAccountId: SA,
  displayName: "trainer",
  permissions: ["repo.content.read"],
};

/** A service-account GET carrying one token's metadata. */
const accountWith = (token: Record<string, unknown>) => ({
  _id: SA,
  user: "u",
  name: "trainer",
  createdAt: "",
  accessTokens: [token],
});

const existingToken = {
  _id: "tok_1",
  displayName: "trainer",
  createdAt: "",
  permissions: ["repo.content.read"],
};

describe("buildTokenBody", () => {
  test("always carries displayName and omits unset keys", () => {
    expect(buildTokenBody({ displayName: "trainer" })).toEqual({
      displayName: "trainer",
    });
  });

  test("passes every supplied scope field through", () => {
    expect(
      buildTokenBody({
        displayName: "trainer",
        permissions: ["org.read"],
        repoIds: [REPO],
        repoPermissions: ["repo.write"],
        endpointPatterns: ["https://x/*"],
        skipNetworkSecurity: true,
      }),
    ).toEqual({
      displayName: "trainer",
      permissions: ["org.read"],
      repoIds: [REPO],
      repoPermissions: ["repo.write"],
      endpointPatterns: ["https://x/*"],
      skipNetworkSecurity: true,
    });
  });
});

describe("tokenScopeMatches", () => {
  test("ignores ordering within a scope list", () => {
    expect(
      tokenScopeMatches(
        { displayName: "trainer", permissions: ["org.read", "org.write"] },
        {
          _id: "t",
          displayName: "trainer",
          createdAt: "",
          permissions: ["org.write", "org.read"],
        },
      ),
    ).toBe(true);
  });

  test("detects a changed displayName", () => {
    expect(
      tokenScopeMatches({ displayName: "renamed" }, existingToken as never),
    ).toBe(false);
  });

  test("treats an absent skipNetworkSecurity as false on both sides", () => {
    expect(
      tokenScopeMatches({ displayName: "trainer" }, {
        _id: "t",
        displayName: "trainer",
        createdAt: "",
      }),
    ).toBe(true);
  });
});

describe("ServiceAccountToken diff", () => {
  test("a scope change updates in place", () => {
    expect(
      diffTokenProps(base, { ...base, permissions: ["repo.write"] }),
    ).toBeUndefined();
  });

  test("a version bump updates in place — rotation keeps the token id", () => {
    expect(diffTokenProps(base, { ...base, version: 2 })).toBeUndefined();
  });

  test("moving to another service account replaces", () => {
    expect(
      diffTokenProps(base, { ...base, serviceAccountId: "c".repeat(24) }),
    ).toEqual({ action: "replace" });
  });

  test("moving organization replaces", () => {
    expect(diffTokenProps(base, { ...base, organization: "Other" })).toEqual({
      action: "replace",
    });
  });
});

describe("ServiceAccountToken stables", () => {
  test("`value` is never stable — a stale secret must not be handed to consumers", () => {
    // `stables` controls what a downstream `token.value` reference resolves
    // to at PLAN time: the engine substitutes the OLD concrete value for any
    // listed attribute (Plan.ts `withStables`, Output.ts's proxy). Since a
    // `version` bump is an update, not a replace, listing `value` would hand
    // every consumer in that deploy the pre-rotation plaintext — which
    // `rotateToken` invalidated the moment it ran — as a literal, with no
    // dependency edge to even order it correctly.
    expect(serviceAccountTokenService.stables).not.toContain("value");
  });

  test("`tokenId` is not stable either — the re-mint path changes it", () => {
    // When the token was deleted out of band, reconcile mints a fresh one
    // with a new `_id`.
    expect(serviceAccountTokenService.stables).not.toContain("tokenId");
  });
});

describe("ServiceAccountToken reconcile", () => {
  test("greenfield mints a token and persists the value redacted", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: accountWith({ ...existingToken, _id: "none" }) }
        : {
            status: 201,
            body: {
              token: "hf_minted",
              tokenInfo: { _id: "tok_1", displayName: "trainer", createdAt: "" },
            },
          },
    );

    const attrs: TokenAttrs = await drive(
      serviceAccountTokenService.reconcile,
      { news: { ...base, displayName: "fresh" }, olds: undefined, output: undefined },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]!.path).toBe(
      `/api/organizations/${ORG}/service-accounts/${SA}/tokens`,
    );
    expect(attrs.tokenId).toBe("tok_1");
    expect(attrs.version).toBe(1);
    expect(Redacted.value(attrs.value)).toBe("hf_minted");
  });

  test("a steady-state deploy issues no write and carries the value forward", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: accountWith(existingToken),
    }));

    const attrs: TokenAttrs = await drive(
      serviceAccountTokenService.reconcile,
      {
        news: base,
        olds: base,
        output: {
          tokenId: "tok_1",
          displayName: "trainer",
          value: Redacted.make("hf_existing"),
          version: 1,
        },
      },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(Redacted.value(attrs.value)).toBe("hf_existing");
  });

  test("a scope change PATCHes in place and keeps the persisted value", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: accountWith(existingToken) }
        : { status: 200, body: {} },
    );

    const attrs: TokenAttrs = await drive(
      serviceAccountTokenService.reconcile,
      {
        news: { ...base, permissions: ["repo.write"], repoIds: [REPO] },
        olds: base,
        output: {
          tokenId: "tok_1",
          displayName: "trainer",
          value: Redacted.make("hf_existing"),
          version: 1,
        },
      },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.body).toEqual({
      displayName: "trainer",
      permissions: ["repo.write"],
      repoIds: [REPO],
    });
    // PATCH does not mint a new value.
    expect(Redacted.value(attrs.value)).toBe("hf_existing");
    expect(attrs.version).toBe(1);
  });

  test("bumping version rotates and re-persists the new value", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: accountWith(existingToken) }
        : {
            status: 200,
            body: {
              token: "hf_rotated",
              tokenInfo: { _id: "tok_1", displayName: "trainer", createdAt: "" },
            },
          },
    );

    const attrs: TokenAttrs = await drive(
      serviceAccountTokenService.reconcile,
      {
        news: { ...base, version: 2 },
        olds: base,
        output: {
          tokenId: "tok_1",
          displayName: "trainer",
          value: Redacted.make("hf_old"),
          version: 1,
        },
      },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]!.path).toBe(
      `/api/organizations/${ORG}/service-accounts/${SA}/tokens/tok_1/rotate`,
    );
    expect(Redacted.value(attrs.value)).toBe("hf_rotated");
    expect(attrs.version).toBe(2);
    expect(attrs.tokenId).toBe("tok_1");
  });

  test("a rotation that also changes scope rotates then patches", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: accountWith(existingToken) }
        : req.path.endsWith("/rotate")
          ? {
              status: 200,
              body: {
                token: "hf_rotated",
                tokenInfo: { _id: "tok_1", displayName: "trainer", createdAt: "" },
              },
            }
          : { status: 200, body: {} },
    );

    await drive(
      serviceAccountTokenService.reconcile,
      {
        news: { ...base, version: 3, permissions: ["org.write"] },
        olds: base,
        output: {
          tokenId: "tok_1",
          displayName: "trainer",
          value: Redacted.make("hf_old"),
          version: 2,
        },
      },
      layer,
    );

    expect(calls.map((c) => `${c.method} ${c.path.split("/").pop()}`)).toEqual([
      "GET 6a6f8f4083f1c297d4dbb0d7",
      "POST rotate",
      "PATCH tok_1",
    ]);
  });

  test("a token whose value is missing from state fails with workable remedies", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: accountWith(existingToken),
    }));

    const failure = await driveFailure(
      serviceAccountTokenService.reconcile,
      { news: base, olds: base, output: undefined },
      layer,
    );

    const message = (failure as { message: string }).message;
    expect((failure as { _tag: string })._tag).toBe("ConfigError");
    expect(message).toContain("value is not in Alchemy state");
    // The remedies must be ones that actually work. Bumping `version` is NOT
    // one of them: branch 3a is gated on `output !== undefined`, and after
    // state loss `read` returns undefined (no value in state) so nothing is
    // adopted — the bumped deploy lands here again, identically. The message
    // must therefore say so rather than send the operator round the loop.
    expect(message).toContain("bumping `version` will not help");
    expect(message).toContain("delete the token in the Hub UI");
    expect(message).toContain("change `displayName`");
    // Crucially, it did not silently mint or rotate anything.
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("bumping version does not rescue a lost value — it fails identically", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: accountWith(existingToken),
    }));

    const failure = await driveFailure(
      serviceAccountTokenService.reconcile,
      { news: { ...base, version: 2 }, olds: base, output: undefined },
      layer,
    );

    expect((failure as { _tag: string })._tag).toBe("ConfigError");
    // No rotate was attempted: rotating a token that live consumers may be
    // using, during a routine deploy the operator did not ask to rotate, is
    // worse than failing.
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("a stale tokenId mints a fresh token instead of adopting a same-named one", async () => {
    // The token was deleted in the Hub UI and someone re-minted one with the
    // same display name. Adopting it would pair the NEW token's id with the
    // DELETED token's plaintext still sitting in state.
    const { layer, calls } = stubHub((req) =>
      req.method === "GET"
        ? { status: 200, body: accountWith(existingToken) }
        : {
            status: 201,
            body: {
              token: "hf_fresh",
              tokenInfo: { _id: "tok_9", displayName: "trainer", createdAt: "" },
            },
          },
    );

    const attrs: TokenAttrs = await drive(
      serviceAccountTokenService.reconcile,
      {
        news: base,
        olds: base,
        output: {
          tokenId: "tok_gone",
          displayName: "trainer",
          value: Redacted.make("hf_stale"),
          version: 1,
        },
      },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(attrs.tokenId).toBe("tok_9");
    expect(Redacted.value(attrs.value)).toBe("hf_fresh");
  });

  test("a non-hex repoId is rejected before any request", async () => {
    const { layer, calls } = stubHub(() => ({ status: 200 }));

    const failure = await driveFailure(
      serviceAccountTokenService.reconcile,
      {
        news: { ...base, repoIds: [`${ORG}/datasets`] },
        olds: undefined,
        output: undefined,
      },
      layer,
    );

    expect((failure as { _tag: string })._tag).toBe("ConfigError");
    expect((failure as { message: string }).message).toContain("bucketId");
    expect(calls).toHaveLength(0);
  });

  test("more than 20 endpoint patterns is rejected before any request", async () => {
    const { layer, calls } = stubHub(() => ({ status: 200 }));

    const failure = await driveFailure(
      serviceAccountTokenService.reconcile,
      {
        news: {
          ...base,
          endpointPatterns: Array.from({ length: 21 }, (_, i) => `https://x/${i}`),
        },
        olds: undefined,
        output: undefined,
      },
      layer,
    );

    expect((failure as { message: string }).message).toContain("at most 20");
    expect(calls).toHaveLength(0);
  });
});

describe("ServiceAccountToken delete", () => {
  test("an absent token is a finished teardown", async () => {
    const { layer } = stubHub(() => ({ status: 404, body: { error: "no" } }));
    await drive(
      serviceAccountTokenService.delete,
      { olds: base, output: { tokenId: "tok_1" } },
      layer,
    );
  });

  test("a 403 fails the destroy rather than orphaning a live token", async () => {
    // Swallowing this would drop the resource from state while the token
    // stays live on the Hub with nothing left pointing at it — strictly
    // worse than a failed destroy for a secret-bearing resource.
    const { layer } = stubHub(() => ({ status: 403, body: { error: "nope" } }));

    const failure = await driveFailure(
      serviceAccountTokenService.delete,
      { olds: base, output: { tokenId: "tok_1" } },
      layer,
    );

    expect((failure as { _tag: string })._tag).toBe("Forbidden");
  });
});

describe("ServiceAccountToken read", () => {
  test("reports not-readable when the value is absent from state", async () => {
    const { layer } = stubHub(() => ({
      status: 200,
      body: accountWith(existingToken),
    }));

    expect(
      await drive(
        serviceAccountTokenService.read,
        { olds: base, output: undefined },
        layer,
      ),
    ).toBeUndefined();
  });

  test("returns the persisted value when state has one", async () => {
    const { layer } = stubHub(() => ({
      status: 200,
      body: accountWith(existingToken),
    }));

    const attrs: TokenAttrs | undefined = await drive(
      serviceAccountTokenService.read,
      {
        olds: base,
        output: {
          tokenId: "tok_1",
          displayName: "trainer",
          value: Redacted.make("hf_existing"),
          version: 1,
        },
      },
      layer,
    );

    expect(Redacted.value(attrs!.value)).toBe("hf_existing");
  });
});
