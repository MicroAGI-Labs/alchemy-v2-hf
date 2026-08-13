import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ConfigError, HubError } from "../Errors.ts";
import { HubClient } from "../Http/Client.ts";
import type {
  CreateServiceAccountBody,
  CreateTokenBody,
  ServiceAccountCreated,
  ServiceAccountDetail,
  ServiceAccountSummary,
  TokenInfo,
  TokenBody,
  TokenIssued,
  TokenUpdated,
} from "./Types.ts";
import { validateTokenInput } from "./Validation.ts";

/**
 * Organization service-account and service-account-token operations.
 *
 * These are plain Effects over {@link HubClient} — no Alchemy `Resource` or
 * `Provider` anywhere in the import graph — so a long-running controller can
 * mint and revoke credentials at runtime with nothing but `effect` and this
 * module. The Alchemy resources under `../Resources/` are a thin lifecycle
 * wrapper around exactly these calls.
 *
 * Every operation needs a token with `org.serviceAccounts.write` on an
 * Enterprise organization.
 */

/** Percent-encode one path segment so a name can never break out of the path. */
const seg = (value: string): string => encodeURIComponent(value);

const serviceAccountsPath = (organization: string): string =>
  `/api/organizations/${seg(organization)}/service-accounts`;

const serviceAccountPath = (organization: string, id: string): string =>
  `${serviceAccountsPath(organization)}/${seg(id)}`;

const tokensPath = (organization: string, serviceAccountId: string): string =>
  `${serviceAccountPath(organization, serviceAccountId)}/tokens`;

const tokenPath = (
  organization: string,
  serviceAccountId: string,
  tokenId: string,
): string => `${tokensPath(organization, serviceAccountId)}/${seg(tokenId)}`;

/**
 * Create an organization service account.
 *
 * `201` carries the account's name under `fullname` (list/get call the same
 * value `name`); {@link normalizeCreated} smooths that over.
 */
export const createServiceAccount = (input: {
  organization: string;
  body: CreateServiceAccountBody;
}): Effect.Effect<ServiceAccountCreated, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    return yield* client.json<ServiceAccountCreated>({
      method: "POST",
      path: serviceAccountsPath(input.organization),
      body: input.body,
    });
  });

/** Fetch one service account, including its token metadata. */
export const getServiceAccount = (input: {
  organization: string;
  serviceAccountId: string;
}): Effect.Effect<ServiceAccountDetail, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    return yield* client.json<ServiceAccountDetail>({
      method: "GET",
      path: serviceAccountPath(input.organization, input.serviceAccountId),
    });
  });

/**
 * List an organization's service accounts.
 *
 * The endpoint takes no query parameters — filtering by name is a
 * client-side scan (see {@link findServiceAccountByName}).
 */
export const listServiceAccounts = (input: {
  organization: string;
}): Effect.Effect<ReadonlyArray<ServiceAccountSummary>, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    const body = yield* client.json<ReadonlyArray<ServiceAccountSummary>>({
      method: "GET",
      path: serviceAccountsPath(input.organization),
    });
    return Array.isArray(body) ? body : [];
  });

/**
 * Find a service account by its `name`, or `undefined` if the organization
 * has none. Used for idempotent create and for adoption.
 */
export const findServiceAccountByName = (input: {
  organization: string;
  name: string;
}): Effect.Effect<ServiceAccountSummary | undefined, HubError, HubClient> =>
  listServiceAccounts({ organization: input.organization }).pipe(
    Effect.map((accounts) =>
      accounts.find((account) => account.name === input.name),
    ),
  );

/** Delete a service account. Every token it owns is invalidated with it. */
export const deleteServiceAccount = (input: {
  organization: string;
  serviceAccountId: string;
}): Effect.Effect<void, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({
      method: "DELETE",
      path: serviceAccountPath(input.organization, input.serviceAccountId),
    });
  });

/**
 * Mint a token on a service account.
 *
 * The returned `token` is the plaintext value and is disclosed **exactly
 * once** — no endpoint will ever return it again. It is handed back as a
 * `Redacted<string>` so it cannot be logged by accident; persist it
 * immediately or it is lost and the token must be rotated to obtain a
 * usable value.
 */
export const createToken = (input: {
  organization: string;
  serviceAccountId: string;
  body: CreateTokenBody;
}): Effect.Effect<
  IssuedToken,
  HubError | ConfigError,
  HubClient
> =>
  Effect.gen(function* () {
    yield* validateTokenInput(input.body);
    const client = yield* HubClient;
    const issued = yield* client.json<TokenIssued>({
      method: "POST",
      path: tokensPath(input.organization, input.serviceAccountId),
      body: input.body,
    });
    return toIssuedToken(issued);
  });

/**
 * Update a token's scope in place.
 *
 * Every field is optional; the Hub replaces the ones supplied. This does
 * **not** mint a new value — the existing token keeps working, so a caller
 * holding the plaintext carries it forward unchanged.
 */
export const patchToken = (input: {
  organization: string;
  serviceAccountId: string;
  tokenId: string;
  body: TokenBody;
}): Effect.Effect<TokenUpdated, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    yield* validateTokenInput(input.body);
    const client = yield* HubClient;
    const response = yield* client.request({
      method: "PATCH",
      path: tokenPath(
        input.organization,
        input.serviceAccountId,
        input.tokenId,
      ),
      body: input.body,
    });
    return (response.body ?? {}) as TokenUpdated;
  });

/**
 * Rotate a token: the Hub issues a fresh value and invalidates the old one
 * **immediately**. The token id is preserved, so scope survives rotation.
 */
export const rotateToken = (input: {
  organization: string;
  serviceAccountId: string;
  tokenId: string;
}): Effect.Effect<IssuedToken, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    const issued = yield* client.json<TokenIssued>({
      method: "POST",
      path: `${tokenPath(input.organization, input.serviceAccountId, input.tokenId)}/rotate`,
    });
    return toIssuedToken(issued);
  });

/**
 * Delete a service-account token.
 *
 * Deliberately **not** `POST /api/organizations/{name}/settings/tokens/{id}/revoke`
 * — that endpoint revokes an organization *member's* token and does not
 * apply to service accounts.
 */
export const deleteToken = (input: {
  organization: string;
  serviceAccountId: string;
  tokenId: string;
}): Effect.Effect<void, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({
      method: "DELETE",
      path: tokenPath(
        input.organization,
        input.serviceAccountId,
        input.tokenId,
      ),
    });
  });

/**
 * Find a token's metadata on a service account. There is no list-tokens
 * endpoint, so this reads the account and scans `accessTokens` — by `_id`
 * first, falling back to `displayName` for recovery when the id was lost.
 *
 * The result never contains the plaintext value; the Hub does not store one
 * it can hand back.
 */
export const findToken = (input: {
  organization: string;
  serviceAccountId: string;
  tokenId?: string;
  displayName?: string;
}): Effect.Effect<TokenInfo | undefined, HubError, HubClient> =>
  getServiceAccount({
    organization: input.organization,
    serviceAccountId: input.serviceAccountId,
  }).pipe(
    Effect.map((account) => {
      const tokens = account.accessTokens ?? [];
      const byId = input.tokenId
        ? tokens.find((token) => token._id === input.tokenId)
        : undefined;
      if (byId) return byId;
      return input.displayName
        ? tokens.find((token) => token.displayName === input.displayName)
        : undefined;
    }),
  );

/** A freshly issued token: metadata plus the once-only plaintext value. */
export type IssuedToken = {
  /** Server-assigned token id. Stable across rotation. */
  readonly tokenId: string;
  /** Token metadata as the Hub returned it. */
  readonly tokenInfo: TokenInfo;
  /** The plaintext value. Disclosed once; never retrievable again. */
  readonly value: Redacted.Redacted<string>;
};

/**
 * Wrap a raw `{ token, tokenInfo }` payload, redacting the value at the
 * boundary so nothing downstream ever handles it in the clear.
 *
 * @internal
 */
export const toIssuedToken = (issued: TokenIssued): IssuedToken => ({
  tokenId: issued.tokenInfo?._id ?? "",
  tokenInfo: issued.tokenInfo,
  value: Redacted.make(issued.token),
});

/**
 * Normalize a create response onto the `get`/`list` shape, papering over the
 * `fullname` vs `name` drift.
 */
export const normalizeCreated = (
  created: ServiceAccountCreated,
): ServiceAccountSummary => ({
  _id: created._id,
  user: created.user,
  name: created.fullname,
  description: created.description,
  createdAt: created.createdAt,
});
