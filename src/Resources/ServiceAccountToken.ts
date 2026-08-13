import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  createToken,
  deleteToken,
  findToken,
  patchToken,
  rotateToken,
} from "../Client/ServiceAccounts.ts";
import type {
  HubPermission,
  HubRepoPermission,
  TokenBody,
  TokenInfo,
} from "../Client/Types.ts";
import { validateTokenInput } from "../Client/Validation.ts";
import { ConfigError } from "../Errors.ts";
import type * as HF from "./Providers.ts";

/**
 * A token on a Hugging Face organization service account.
 *
 * The plaintext value is returned by the Hub **exactly once**, at creation
 * and at each rotation, and no endpoint will ever disclose it again. It is
 * therefore persisted in Alchemy state as a `Redacted<string>` — the same
 * shape `apps/cluster/seeded-secret.ts` uses in the research-infra stack,
 * and the same shape `Cloudflare.Calls.App.secret` uses upstream. Alchemy's
 * state encoder (`State/StateEncoding.ts`) round-trips `Redacted` losslessly
 * via its `__redacted__` marker, so the real value survives in state while
 * staying opaque to logs and plan output.
 *
 * Consequences worth internalising:
 *
 * - Losing state loses the value. The token still exists on the Hub, but it
 *   cannot be recovered — bump {@link ServiceAccountTokenProps.version} to
 *   rotate and obtain a fresh one.
 * - Rotation invalidates the previous value **immediately**. Anything still
 *   holding it starts failing the moment the deploy lands.
 *
 * @section Creating a ServiceAccountToken
 * @example A token scoped to one bucket
 * ```typescript
 * const token = yield* HF.ServiceAccountToken("TrainerToken", {
 *   organization: "MicroAGI-Labs",
 *   serviceAccountId: trainer.id,
 *   displayName: "trainer",
 *   repoIds: [datasets.bucketId],          // 24-hex _id, not namespace/name
 *   repoPermissions: ["repo.content.read"],
 * });
 * // token.value is Redacted<string>
 * ```
 */
export type ServiceAccountTokenProps = {
  /** Organization owning the service account. Identity — replaces on change. */
  organization: string;
  /**
   * Id of the parent service account (a `ServiceAccount`'s `id` output).
   * Identity — replaces on change, because the token belongs to the account.
   */
  serviceAccountId: string;
  /** Human-readable label shown in the Hub UI. Updated in place. */
  displayName: string;
  /**
   * Organization-wide permissions. Ignored for any repo listed in
   * {@link repoIds}, which takes its grants from {@link repoPermissions}.
   */
  permissions?: ReadonlyArray<HubPermission>;
  /**
   * Repositories the token is scoped to, as 24-hex repo `_id`s — **not**
   * `namespace/name` strings. For a bucket, use the `Bucket` resource's
   * `bucketId` output, or read `_id` from
   * `GET /api/buckets/{namespace}/{name}`.
   */
  repoIds?: ReadonlyArray<string>;
  /** Grants applied to every repo in {@link repoIds}. */
  repoPermissions?: ReadonlyArray<HubRepoPermission>;
  /** Endpoint patterns the token may call. Max 20, each ≤256 characters. */
  endpointPatterns?: ReadonlyArray<string>;
  /** Exempt the token from the organization's network security policy. */
  skipNetworkSecurity?: boolean;
  /**
   * Rotation counter, default `1`. Bumping it rotates the token on the next
   * deploy: the Hub mints a new value, the old one stops working
   * immediately, and the new value replaces the one in state. The committed
   * bump is the audit trail — same convention as `SeededSecret`.
   */
  version?: number;
};

export type ServiceAccountToken = Resource<
  "HuggingFace.ServiceAccountToken",
  ServiceAccountTokenProps,
  {
    /** Server-assigned token id. Survives rotation. */
    tokenId: string;
    /** Label shown in the Hub UI. */
    displayName: string;
    /** The plaintext token, redacted. Persisted in state; opaque in logs. */
    value: Redacted.Redacted<string>;
    /** The `version` that minted the current value. */
    version: number;
  },
  never,
  HF.Providers
>;

export const ServiceAccountToken = Resource<ServiceAccountToken>(
  "HuggingFace.ServiceAccountToken",
);

/** Default rotation counter when the prop is omitted. */
export const DEFAULT_VERSION = 1;

/**
 * Build the request body for token create/patch, omitting keys the caller
 * left unset so the Hub applies its own defaults rather than being handed
 * explicit `undefined`s (which it serialises as `null` and rejects).
 *
 * Exported so the wire shape is directly assertable in tests.
 */
export const buildTokenBody = (
  props: Pick<
    ServiceAccountTokenProps,
    | "displayName"
    | "permissions"
    | "repoIds"
    | "repoPermissions"
    | "endpointPatterns"
    | "skipNetworkSecurity"
  >,
): TokenBody & { displayName: string } => {
  const body: Record<string, unknown> = { displayName: props.displayName };
  if (props.permissions !== undefined) body.permissions = props.permissions;
  if (props.repoIds !== undefined) body.repoIds = props.repoIds;
  if (props.repoPermissions !== undefined) {
    body.repoPermissions = props.repoPermissions;
  }
  if (props.endpointPatterns !== undefined) {
    body.endpointPatterns = props.endpointPatterns;
  }
  if (props.skipNetworkSecurity !== undefined) {
    body.skipNetworkSecurity = props.skipNetworkSecurity;
  }
  return body as TokenBody & { displayName: string };
};

/** Order-insensitive comparison of two optional string lists. @internal */
const sameSet = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return (
    left.length === right.length && left.every((v, i) => v === right[i])
  );
};

/**
 * True when the desired scope already matches what the Hub reports, so the
 * `PATCH` can be skipped entirely.
 *
 * Compares against **observed** token metadata rather than `olds`, per the
 * reconciler doctrine — that is what makes the step converge after an
 * out-of-band edit or an adoption.
 */
export const tokenScopeMatches = (
  desired: Pick<
    ServiceAccountTokenProps,
    | "displayName"
    | "permissions"
    | "repoIds"
    | "repoPermissions"
    | "endpointPatterns"
    | "skipNetworkSecurity"
  >,
  observed: TokenInfo,
): boolean =>
  observed.displayName === desired.displayName &&
  sameSet(desired.permissions, observed.permissions) &&
  sameSet(desired.repoIds, observed.repoIds) &&
  sameSet(desired.repoPermissions, observed.repoPermissions) &&
  sameSet(desired.endpointPatterns, observed.endpointPatterns) &&
  (desired.skipNetworkSecurity ?? false) ===
    (observed.skipNetworkSecurity ?? false);

/**
 * Replace-vs-update decision from props alone.
 *
 * Only the token's parentage is immutable. Scope changes `PATCH` in place;
 * a `version` bump rotates in place — both keep the token id, so neither is
 * a replacement.
 */
export const diffTokenProps = (
  olds: ServiceAccountTokenProps,
  news: ServiceAccountTokenProps,
): { action: "replace" } | undefined =>
  olds.organization !== news.organization ||
  olds.serviceAccountId !== news.serviceAccountId
    ? { action: "replace" }
    : undefined;

/**
 * The reconciler itself, hoisted out of
 * {@link ServiceAccountTokenProvider} so unit tests can drive the lifecycle
 * handlers directly against a stubbed `HubClient`.
 *
 * @internal
 */
export const serviceAccountTokenService = {
  nuke: { skip: true },
  // `value` is stable in the engine's sense: it is set on create/rotate and
  // can never be re-read from the API, so the engine must carry it forward
  // rather than treat its absence from a read as drift.
  stables: ["tokenId", "value"] satisfies Array<
    keyof ServiceAccountToken["Attributes"]
  >,
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* ({ news, olds }) {
    if (!isResolved(news)) return undefined;
    if (!olds) return undefined;
    return diffTokenProps(olds, news);
  }),
  reconcile: Effect.fn(function* ({ news, output }) {
    yield* validateTokenInput(news);
    const version = news.version ?? DEFAULT_VERSION;

    // 1. Observe. There is no list-tokens endpoint, so this reads the
    //    parent account and scans `accessTokens` — by id, then by
    //    displayName for cold recovery.
    const observed = yield* findToken({
      organization: news.organization,
      serviceAccountId: news.serviceAccountId,
      tokenId: output?.tokenId,
      displayName: news.displayName,
    }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

    // 2. Ensure. Missing → mint. This is also the path taken when the
    //    token was deleted out of band.
    if (!observed) {
      const issued = yield* createToken({
        organization: news.organization,
        serviceAccountId: news.serviceAccountId,
        body: buildTokenBody(news),
      });
      return {
        tokenId: issued.tokenId,
        displayName: news.displayName,
        value: issued.value,
        version,
};
      }

      // 3a. Rotate when the version counter moved. Rotation preserves the
      //     token id and its scope, and invalidates the old value at once.
      if (output !== undefined && output.version !== version) {
        const issued = yield* rotateToken({
          organization: news.organization,
          serviceAccountId: news.serviceAccountId,
          tokenId: observed._id,
        });
        // Scope may also have changed in the same deploy; apply it after
        // rotating so both land.
        if (!tokenScopeMatches(news, observed)) {
          yield* patchToken({
            organization: news.organization,
            serviceAccountId: news.serviceAccountId,
            tokenId: observed._id,
            body: buildTokenBody(news),
          });
        }
        return {
          tokenId: issued.tokenId || observed._id,
          displayName: news.displayName,
          value: issued.value,
          version,
        };
      }

      // 3b. The token exists but its value is not in state. The Hub cannot
      //     disclose it again, so there is nothing to converge on — refuse
      //     loudly instead of persisting an empty secret that would fail at
      //     use time with a far more confusing error.
      if (output?.value === undefined) {
        return yield* Effect.fail(
          new ConfigError({
            message:
              `Token "${news.displayName}" (${observed._id}) exists on service account ` +
              `${news.serviceAccountId} but its value is not in Alchemy state, and the ` +
              `Hub discloses a token value only when it is minted or rotated. ` +
              `Bump \`version\` (currently ${version}) to rotate and obtain a usable value — ` +
              `note that this invalidates the existing token immediately — or delete the ` +
              `token in the Hub UI and re-deploy to mint a fresh one.`,
          }),
        );
      }

      // 3c. Sync scope in place. Diffed against observed state, so an
      //     out-of-band edit converges back. The PATCH does not mint a new
      //     value, so the persisted one carries forward untouched.
      if (!tokenScopeMatches(news, observed)) {
        yield* patchToken({
          organization: news.organization,
          serviceAccountId: news.serviceAccountId,
          tokenId: observed._id,
          body: buildTokenBody(news),
        });
      }

      return {
        tokenId: observed._id,
        displayName: news.displayName,
        value: output.value,
        version,
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      yield* deleteToken({
        organization: olds.organization,
        serviceAccountId: olds.serviceAccountId,
        tokenId: output.tokenId,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Forbidden", () => Effect.void),
      );
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const organization = olds?.organization;
      const serviceAccountId = olds?.serviceAccountId;
      if (!organization || !serviceAccountId) return undefined;

      const observed = yield* findToken({
        organization,
        serviceAccountId,
        tokenId: output?.tokenId,
        displayName: output?.displayName ?? olds.displayName,
      }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (!observed) return undefined;

      // A token whose value is absent from state cannot be described by a
      // complete Attributes record — the Hub will not disclose the value
      // again, and inventing an empty `Redacted` would hand downstream
      // consumers a secret that silently fails at use time. Report it as
      // not-readable; `reconcile` then observes the same token and fails
      // with the actionable "bump `version` to rotate" message.
      if (output?.value === undefined) return undefined;

      // Deliberately NOT Unowned: a token exists on a service account only
      // because this resource minted it, and the value in state is itself
      // the proof of ownership — nobody else could hold it.
      return {
        tokenId: observed._id,
        displayName: observed.displayName,
        value: output.value,
        version: output.version ?? olds.version ?? DEFAULT_VERSION,
      };
    }),
  };

export const ServiceAccountTokenProvider = () =>
  Provider.succeed(ServiceAccountToken, serviceAccountTokenService);
