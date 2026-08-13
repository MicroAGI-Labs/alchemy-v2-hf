import * as Effect from "effect/Effect";
import { ConfigError } from "../Errors.ts";
import {
  HUB_PERMISSIONS,
  HUB_REPO_PERMISSIONS,
  type HubPermission,
  type HubRepoPermission,
} from "./Types.ts";

/**
 * Client-side validation for Hub inputs.
 *
 * The Hub rejects bad input with an opaque `400` whose message rarely names
 * the offending field, so — exactly as `ArtifactRegistry/Validation.ts` does
 * in the GCP provider — the cheap, unambiguous checks run locally first and
 * fail with a typed {@link ConfigError} that says what to do instead.
 */

/**
 * A repo `_id` is a 24-character hex string (a MongoDB ObjectId). It is
 * **not** the `namespace/name` form the Hub shows in URLs and returns in the
 * `id` field of `GET /api/buckets/{ns}/{name}`.
 *
 * @internal
 */
export const REPO_ID_RE = /^[0-9a-fA-F]{24}$/;

/** True when `value` has the shape of a 24-hex repo `_id`. */
export const isRepoId = (value: string): boolean => REPO_ID_RE.test(value);

/**
 * Validate the `repoIds` of a service-account token.
 *
 * The most common mistake is passing `namespace/name` (or a `Bucket`
 * resource's `fullName` output) where the 24-hex `_id` is required, so the
 * message points at where the right value comes from.
 */
export const validateRepoIds = (
  repoIds: ReadonlyArray<string> | undefined,
): Effect.Effect<void, ConfigError> => {
  if (!repoIds) return Effect.void;
  const invalid = repoIds.filter((id) => !isRepoId(id));
  if (invalid.length === 0) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message:
        `Invalid \`repoIds\` entr${invalid.length === 1 ? "y" : "ies"}: ` +
        `expected a 24-hex repo _id (e.g. from Bucket's \`bucketId\` output), got ` +
        `${invalid.map((id) => JSON.stringify(id)).join(", ")}. ` +
        `A repo id is NOT the \`namespace/name\` string — fetch it with ` +
        `\`GET /api/buckets/{namespace}/{name}\` and read the \`_id\` field ` +
        `(the \`id\` field of that same response is the \`namespace/name\` string).`,
    }),
  );
};

/** Max number of endpoint patterns the Hub accepts on one token. */
export const MAX_ENDPOINT_PATTERNS = 20;
/** Max length of a single endpoint pattern. */
export const MAX_ENDPOINT_PATTERN_LENGTH = 256;

/** Validate the `endpointPatterns` of a service-account token. */
export const validateEndpointPatterns = (
  patterns: ReadonlyArray<string> | undefined,
): Effect.Effect<void, ConfigError> => {
  if (!patterns) return Effect.void;
  if (patterns.length > MAX_ENDPOINT_PATTERNS) {
    return Effect.fail(
      new ConfigError({
        message:
          `\`endpointPatterns\` has ${patterns.length} entries; the Hub accepts at most ` +
          `${MAX_ENDPOINT_PATTERNS}. Widen the patterns or split the workload across tokens.`,
      }),
    );
  }
  const tooLong = patterns.filter(
    (p) => p.length > MAX_ENDPOINT_PATTERN_LENGTH,
  );
  if (tooLong.length > 0) {
    return Effect.fail(
      new ConfigError({
        message:
          `\`endpointPatterns\` entries must be at most ${MAX_ENDPOINT_PATTERN_LENGTH} characters; ` +
          `${tooLong.length} exceed${tooLong.length === 1 ? "s" : ""} that limit ` +
          `(longest is ${Math.max(...tooLong.map((p) => p.length))}).`,
      }),
    );
  }
  return Effect.void;
};

/**
 * Validate the org-wide `permissions` of a token. The Hub's enum is closed,
 * and an unknown value produces a `400` naming nothing.
 */
export const validatePermissions = (
  permissions: ReadonlyArray<string> | undefined,
): Effect.Effect<void, ConfigError> => {
  if (!permissions) return Effect.void;
  const unknown = permissions.filter(
    (p) => !HUB_PERMISSIONS.includes(p as HubPermission),
  );
  if (unknown.length === 0) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message:
        `Unknown token permission${unknown.length === 1 ? "" : "s"} ` +
        `${unknown.map((p) => JSON.stringify(p)).join(", ")}. Valid values: ` +
        `${HUB_PERMISSIONS.join(", ")}.`,
    }),
  );
};

/** Validate the per-repository `repoPermissions` of a token. */
export const validateRepoPermissions = (
  repoPermissions: ReadonlyArray<string> | undefined,
): Effect.Effect<void, ConfigError> => {
  if (!repoPermissions) return Effect.void;
  const unknown = repoPermissions.filter(
    (p) => !HUB_REPO_PERMISSIONS.includes(p as HubRepoPermission),
  );
  if (unknown.length === 0) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message:
        `Unknown repo permission${unknown.length === 1 ? "" : "s"} ` +
        `${unknown.map((p) => JSON.stringify(p)).join(", ")}. Valid values: ` +
        `${HUB_REPO_PERMISSIONS.join(", ")}.`,
    }),
  );
};

/**
 * Run every token-shape check. Called by both the client's token operations
 * and the `ServiceAccountToken` resource, so a runtime caller gets the same
 * early failures the Alchemy path does.
 */
export const validateTokenInput = (input: {
  permissions?: ReadonlyArray<string>;
  repoIds?: ReadonlyArray<string>;
  repoPermissions?: ReadonlyArray<string>;
  endpointPatterns?: ReadonlyArray<string>;
}): Effect.Effect<void, ConfigError> =>
  Effect.gen(function* () {
    yield* validatePermissions(input.permissions);
    yield* validateRepoPermissions(input.repoPermissions);
    yield* validateRepoIds(input.repoIds);
    yield* validateEndpointPatterns(input.endpointPatterns);
  });

/**
 * A Hub namespace (user or organization) or bucket name. The Hub allows
 * alphanumerics, hyphens, underscores and dots, 1–96 characters, and does
 * not permit a leading or trailing separator.
 *
 * @internal
 */
export const HUB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}[A-Za-z0-9]$|^[A-Za-z0-9]$/;

/** Validate a namespace or bucket name before it is spliced into a URL path. */
export const validateHubName = (
  value: string,
  field: string,
): Effect.Effect<void, ConfigError> => {
  if (HUB_NAME_RE.test(value)) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message:
        `\`${field}\` ${JSON.stringify(value)} is not a valid Hugging Face name: ` +
        `use 1–96 characters of letters, digits, \`.\`, \`-\` or \`_\`, starting and ` +
        `ending with a letter or digit.`,
    }),
  );
};
