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
    // A missing or malformed admin token is a build-time configuration
    // failure, not something a reconciler can recover from — same treatment
    // as `AWS/Providers.ts` and the GCP provider. Resource lifecycle
    // handlers still surface their own typed errors normally; this only
    // affects Layer construction.
    Layer.orDie,
  );
