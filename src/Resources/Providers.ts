import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { fromEnv, type FromEnvOptions } from "../Auth/Credentials.ts";
import { layer as hubClientLayer } from "../Http/Client.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
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
 */
export const providers = (options?: FromEnvOptions) =>
  Layer.effect(
    Providers,
    Provider.collection([Bucket, ServiceAccount, ServiceAccountToken]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BucketProvider(),
        ServiceAccountProvider(),
        ServiceAccountTokenProvider(),
      ),
    ),
    Layer.provideMerge(hubClientLayer),
    Layer.provideMerge(fromEnv(options)),
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
