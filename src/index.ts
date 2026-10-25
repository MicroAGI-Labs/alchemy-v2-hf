/**
 * `@microagi/alchemy-hf` — Hugging Face provider for Alchemy v2.
 *
 * This entrypoint carries the Alchemy resources (`ServiceAccount`,
 * `ServiceAccountToken`, `Bucket`, `Repo`, `ResourceGroup`) plus the `providers()` bundle, and
 * re-exports the whole standalone client for convenience.
 *
 * A runtime consumer that must **not** pull in the Alchemy engine should
 * import `@microagi/alchemy-hf/client` instead — that subpath reaches only
 * `effect`.
 */

export {
  Credentials,
  DEFAULT_ENDPOINT,
  DEFAULT_TOKEN_ENV_VAR,
  type FromEnvOptions,
  fromEnv,
  fromEnv as credentialsFromEnv,
  fromToken,
  fromToken as credentialsFromToken,
  type HuggingFaceCredentials,
  normalizeEndpoint,
  type TokenSource,
} from "./Auth/Credentials.ts";

export {
  buildUrl,
  HubClient,
  type HubClientService,
  type HubRequest,
  type HubResponse,
  layer as hubClientLayer,
  parseJson,
} from "./Http/Client.ts";

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
} from "./Errors.ts";

export * from "./Client/Buckets.ts";
export * from "./Client/Repos.ts";
export * from "./Client/ResourceGroups.ts";
export * from "./Client/ServiceAccounts.ts";
export * from "./Client/Types.ts";
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
} from "./Client/Validation.ts";

export * from "./Resources/index.ts";
