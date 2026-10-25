import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import {
  type Credentials,
  fromEnv,
  type FromEnvOptions,
} from "../Auth/Credentials.ts";
import { ConfigError } from "../Errors.ts";
import { layer as hubClientLayer } from "../Http/Client.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { Repo, RepoProvider } from "./Repo.ts";
import { ResourceGroup, ResourceGroupProvider } from "./ResourceGroup.ts";
import { ServiceAccount, ServiceAccountProvider } from "./ServiceAccount.ts";
import {
  ServiceAccountToken,
  ServiceAccountTokenProvider,
} from "./ServiceAccountToken.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "HuggingFace",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Bundle the Hugging Face resource providers, the Hub HTTP client, and
 * env-backed credentials into a single Layer for
 * `Alchemy.Stack({ providers })`.
 *
 * `FetchHttpClient.layer` is provided once at the Stack level (see
 * `vendor/alchemy/packages/alchemy/src/Stack.ts`), so — mirroring
 * `AWS/Providers.ts`, `Cloudflare/Providers.ts` and the GCP provider — it is
 * deliberately not re-provided here.
 *
 * ```ts
 * export default Alchemy.Stack("research", {
 *   providers: HF.providers(),
 *   state: Alchemy.localState(),
 * }, program);
 * ```
 *
 * Pass `credentials` to source the token from somewhere other than the
 * environment (see {@link ProvidersOptions.credentials}).
 */
export type ProvidersOptions = FromEnvOptions & {
  /**
   * Credentials Layer to use instead of the default {@link fromEnv} one.
   *
   * The bundle satisfies {@link Credentials} internally (via
   * `Layer.provideMerge`), so a caller cannot override it from the outside —
   * a Layer provided around `providers()` is simply shadowed. This option is
   * the supported seam for sourcing the admin token from somewhere other than
   * the process environment: a secret manager, or the consuming stack's own
   * Alchemy state (see {@link import("../Auth/Credentials.ts").fromToken},
   * whose `Effect` token source keeps the read lazy and memoized).
   *
   * A build-time failure is treated exactly like a malformed `HF_ENDPOINT`:
   * the bundle is `Layer.orDie`d, because no reconciler can recover from a
   * provider Layer that will not build. Keep recoverable failure inside the
   * lazy `token` Effect, where it surfaces as a typed error on the operation
   * that needed the token.
   *
   * When supplied, `env` / `endpointEnv` are unused — the caller's Layer owns
   * both the token and the endpoint.
   */
  credentials?: Layer.Layer<Credentials, ConfigError>;
};

export const providers = (options?: ProvidersOptions) =>
  Layer.effect(
    Providers,
    Provider.collection([Bucket, Repo, ResourceGroup, ServiceAccount, ServiceAccountToken]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BucketProvider(),
        RepoProvider(),
        ResourceGroupProvider(),
        ServiceAccountProvider(),
        ServiceAccountTokenProvider(),
      ),
    ),
    Layer.provideMerge(hubClientLayer),
    Layer.provideMerge(options?.credentials ?? fromEnv(options)),
    // Only a *malformed* `HF_ENDPOINT` can fail this Layer now: the admin
    // token is resolved lazily, inside the request path, so a stack whose
    // Hugging Face resources are all `noop` builds (and plans) without a
    // token at all. A bad endpoint is still a build-time configuration
    // failure no reconciler can recover from — same treatment as
    // `AWS/Providers.ts` and the GCP provider. Resource lifecycle handlers
    // surface their own typed errors, including the missing-token
    // `ConfigError`, normally.
    Layer.orDie,
  );
