/**
 * `@microagi/alchemy-hf/client` — the standalone Hugging Face Hub client.
 *
 * This entrypoint depends on **`effect` only**. Nothing reachable from here
 * imports `alchemy/Resource` or `alchemy/Provider`, so a long-running
 * process (an in-cluster controller minting per-tenant credentials, a CLI, a
 * test harness) can use it without the IaC engine, a state store, or a
 * stack.
 *
 * ```ts
 * import * as HF from "@microagi/alchemy-hf/client";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
 *
 * const HubLayer = HF.hubClientLayer.pipe(
 *   Layer.provide(HF.credentialsFromEnv()),
 *   Layer.provide(FetchHttpClient.layer),
 * );
 *
 * const program = Effect.gen(function* () {
 *   const account = yield* HF.createServiceAccount({
 *     organization: "MicroAGI-Labs",
 *     body: { name: "tenant-42", description: "ephemeral" },
 *   });
 *   const token = yield* HF.createToken({
 *     organization: "MicroAGI-Labs",
 *     serviceAccountId: account._id,
 *     body: { displayName: "tenant-42", permissions: ["repo.content.read"] },
 *   });
 *   return token.value; // Redacted<string>, disclosed exactly once
 * }).pipe(Effect.provide(HubLayer));
 * ```
 *
 * The Alchemy resources at the package root are a lifecycle wrapper over
 * exactly these operations — there is no second HTTP implementation.
 */

export {
  Credentials,
  DEFAULT_ENDPOINT,
  DEFAULT_TOKEN_ENV_VAR,
  type FromEnvOptions,
  fromEnv as credentialsFromEnv,
  fromToken as credentialsFromToken,
  type HuggingFaceCredentials,
  normalizeEndpoint,
  type TokenSource,
} from "../Auth/Credentials.ts";

export {
  buildUrl,
  HubClient,
  type HubClientService,
  type HubRequest,
  type HubResponse,
  layer as hubClientLayer,
  parseJson,
} from "../Http/Client.ts";

export {
  BadRequest,
  ConfigError,
  Conflict,
  DecodeError,
  Forbidden,
  type HubError,
  type HubErrorFields,
  NotFound,
  RateLimited,
  ServerError,
  TransportError,
  Unauthorized,
  UnexpectedStatus,
} from "../Errors.ts";

export * from "./Buckets.ts";
export * from "./Repos.ts";
export * from "./ResourceGroups.ts";
export * from "./ServiceAccounts.ts";
export * from "./Types.ts";
export {
  isRepoId,
  MAX_ENDPOINT_PATTERN_LENGTH,
  MAX_ENDPOINT_PATTERNS,
  validateEndpointPatterns,
  validateHubName,
  validatePermissions,
  validateRepoIds,
  validateRepoPermissions,
  validateTokenInput,
} from "./Validation.ts";
