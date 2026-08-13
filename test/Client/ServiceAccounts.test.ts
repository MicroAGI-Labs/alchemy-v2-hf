import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  createServiceAccount,
  createToken,
  deleteServiceAccount,
  deleteToken,
  findServiceAccountByName,
  findToken,
  normalizeCreated,
  patchToken,
  rotateToken,
} from "../../src/Client/ServiceAccounts.ts";
import { runStub, stubHub } from "../support.ts";

const ORG = "MicroAGI-Labs";
const SA = "6a6f8f4083f1c297d4dbb0d7";

describe("service account operations", () => {
  test("create posts the name and description to the org's collection", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 201,
      body: {
        _id: SA,
        user: "microagi-labs-trainer",
        fullname: "trainer",
        description: "d",
        createdAt: "2026-01-01",
      },
    }));

    const created = await runStub(
      createServiceAccount({
        organization: ORG,
        body: { name: "trainer", description: "d" },
      }),
      layer,
    );

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/organizations/MicroAGI-Labs/service-accounts",
      body: { name: "trainer", description: "d" },
    });
    // Create answers with `fullname`; list/get answer with `name`.
    expect(created.fullname).toBe("trainer");
    expect(normalizeCreated(created).name).toBe("trainer");
  });

  test("percent-encodes path segments", async () => {
    const { layer, calls } = stubHub(() => ({ status: 204 }));
    await runStub(
      deleteServiceAccount({
        organization: "org/with slash",
        serviceAccountId: "id one",
      }),
      layer,
    );
    expect(calls[0]!.path).toBe(
      "/api/organizations/org%2Fwith%20slash/service-accounts/id%20one",
    );
  });

  test("findServiceAccountByName filters the list client-side", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: [
        { _id: "a", user: "u", name: "other", createdAt: "" },
        { _id: SA, user: "u", name: "trainer", createdAt: "" },
      ],
    }));

    const found = await runStub(
      findServiceAccountByName({ organization: ORG, name: "trainer" }),
      layer,
    );

    // The endpoint takes no query params — a search param here would be
    // silently ignored, so the filter must be local.
    expect(calls[0]!.searchParams).toBeUndefined();
    expect(found?._id).toBe(SA);
  });

  test("a list reply that is not an array degrades to empty", async () => {
    const { layer } = stubHub(() => ({ status: 200, body: { error: "huh" } }));
    const found = await runStub(
      findServiceAccountByName({ organization: ORG, name: "trainer" }),
      layer,
    );
    expect(found).toBeUndefined();
  });
});

describe("token operations", () => {
  const issued = (token: string, id = "tok_1") => ({
    token,
    tokenInfo: { _id: id, displayName: "trainer", createdAt: "" },
  });

  test("create posts the scope and returns the value redacted", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 201,
      body: issued("hf_secret_value"),
    }));

    const result = await runStub(
      createToken({
        organization: ORG,
        serviceAccountId: SA,
        body: {
          displayName: "trainer",
          permissions: ["repo.content.read"],
          repoIds: ["a".repeat(24)],
          repoPermissions: ["repo.write"],
        },
      }),
      layer,
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(
      `/api/organizations/${ORG}/service-accounts/${SA}/tokens`,
    );
    expect(calls[0]!.body).toEqual({
      displayName: "trainer",
      permissions: ["repo.content.read"],
      repoIds: ["a".repeat(24)],
      repoPermissions: ["repo.write"],
    });
    expect(result.tokenId).toBe("tok_1");
    expect(Redacted.value(result.value)).toBe("hf_secret_value");
    // The whole point of Redacted: it must not leak through stringification.
    expect(String(result.value)).not.toContain("hf_secret_value");
  });

  test("create rejects a repoId that is not 24-hex before any request", async () => {
    const { layer, calls } = stubHub(() => ({ status: 201 }));

    const failure = await Effect.runPromise(
      createToken({
        organization: ORG,
        serviceAccountId: SA,
        body: {
          displayName: "trainer",
          repoIds: ["MicroAGI-Labs/datasets"],
        },
      }).pipe(Effect.flip, Effect.provide(layer)),
    );

    expect(failure._tag).toBe("ConfigError");
    expect(failure.message).toContain("24-hex repo _id");
    expect(failure.message).toContain("bucketId");
    // Validation runs before the HTTP call, so nothing was sent.
    expect(calls).toHaveLength(0);
  });

  test("a create response without tokenInfo fails rather than fabricating an id", async () => {
    // An empty `tokenId` would reach state, after which `findToken` degrades
    // to displayName matching and `deleteToken` issues `DELETE .../tokens/`
    // — a 404 the reconciler absorbs, so the token would never be revoked.
    const { layer } = stubHub(() => ({ status: 201, body: { token: "hf_x" } }));

    const failure = await Effect.runPromise(
      createToken({
        organization: ORG,
        serviceAccountId: SA,
        body: { displayName: "trainer" },
      }).pipe(Effect.flip, Effect.provide(layer)),
    );

    expect(failure._tag).toBe("DecodeError");
    expect(failure.message).toContain("tokenInfo._id");
  });

  test("a rotate response without a token value fails", async () => {
    const { layer } = stubHub(() => ({
      status: 200,
      body: { tokenInfo: { _id: "tok_1", displayName: "trainer", createdAt: "" } },
    }));

    const failure = await Effect.runPromise(
      rotateToken({
        organization: ORG,
        serviceAccountId: SA,
        tokenId: "tok_1",
      }).pipe(Effect.flip, Effect.provide(layer)),
    );

    expect(failure._tag).toBe("DecodeError");
  });

  test("patch targets the token and does not yield a new value", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: { tokenInfo: { _id: "tok_1", displayName: "renamed" } },
    }));

    await runStub(
      patchToken({
        organization: ORG,
        serviceAccountId: SA,
        tokenId: "tok_1",
        body: { displayName: "renamed" },
      }),
      layer,
    );

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe(
      `/api/organizations/${ORG}/service-accounts/${SA}/tokens/tok_1`,
    );
    expect(calls[0]!.body).toEqual({ displayName: "renamed" });
  });

  test("rotate posts to /rotate with no body and returns the new value", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: issued("hf_rotated"),
    }));

    const result = await runStub(
      rotateToken({
        organization: ORG,
        serviceAccountId: SA,
        tokenId: "tok_1",
      }),
      layer,
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(
      `/api/organizations/${ORG}/service-accounts/${SA}/tokens/tok_1/rotate`,
    );
    expect(calls[0]!.body).toBeUndefined();
    expect(Redacted.value(result.value)).toBe("hf_rotated");
  });

  test("delete uses the service-account token path, not the member revoke path", async () => {
    const { layer, calls } = stubHub(() => ({ status: 204 }));
    await runStub(
      deleteToken({
        organization: ORG,
        serviceAccountId: SA,
        tokenId: "tok_1",
      }),
      layer,
    );
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe(
      `/api/organizations/${ORG}/service-accounts/${SA}/tokens/tok_1`,
    );
    expect(calls[0]!.path).not.toContain("/settings/tokens");
    expect(calls[0]!.path).not.toContain("revoke");
  });

  const accountWithTwoTokens = {
    _id: SA,
    user: "u",
    name: "trainer",
    createdAt: "",
    accessTokens: [
      { _id: "tok_1", displayName: "old-name", createdAt: "" },
      { _id: "tok_2", displayName: "trainer", createdAt: "" },
    ],
  };

  test("findToken matches on _id, ignoring displayName", async () => {
    const byId = await runStub(
      findToken({
        organization: ORG,
        serviceAccountId: SA,
        tokenId: "tok_1",
        displayName: "trainer",
      }),
      stubHub(() => ({ status: 200, body: accountWithTwoTokens })).layer,
    );
    expect(byId?._id).toBe("tok_1");
  });

  test("findToken scans displayName only when no id is known", async () => {
    const byName = await runStub(
      findToken({
        organization: ORG,
        serviceAccountId: SA,
        displayName: "trainer",
      }),
      stubHub(() => ({ status: 200, body: accountWithTwoTokens })).layer,
    );
    expect(byName?._id).toBe("tok_2");
  });

  test("a supplied id that does not match reports absent, never a same-named token", async () => {
    // If this fell back to the name it would return tok_2, and the reconciler
    // would pair tok_2's id with the DELETED token's plaintext (still sitting
    // in state) — a credential that looks valid and fails at use time.
    const gone = await runStub(
      findToken({
        organization: ORG,
        serviceAccountId: SA,
        tokenId: "gone",
        displayName: "trainer",
      }),
      stubHub(() => ({ status: 200, body: accountWithTwoTokens })).layer,
    );
    expect(gone).toBeUndefined();
  });

  test("findToken never surfaces a token value — the Hub does not store one", async () => {
    const { layer } = stubHub(() => ({
      status: 200,
      body: {
        _id: SA,
        user: "u",
        name: "trainer",
        createdAt: "",
        accessTokens: [
          { _id: "tok_1", displayName: "trainer", createdAt: "", last4: "abcd" },
        ],
      },
    }));
    const found = await runStub(
      findToken({ organization: ORG, serviceAccountId: SA, tokenId: "tok_1" }),
      layer,
    );
    expect(found).toBeDefined();
    expect("token" in (found as object)).toBe(false);
  });
});
