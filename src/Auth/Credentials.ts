import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ConfigError } from "../Errors.ts";

/**
 * Default environment variable the Hugging Face admin token is read from.
 *
 * `HF_ADMIN_TOKEN` deliberately differs from the conventional `HF_TOKEN`
 * that `huggingface_hub` and the CLI pick up: the token this provider needs
 * is an **organization admin** token with `org.serviceAccounts.write`, which
 * is far more privileged than the read/write repo token most tooling uses.
 * Keeping the two variables distinct stops a shell that happens to have a
 * researcher's `HF_TOKEN` exported from silently driving infrastructure.
 */
export const DEFAULT_TOKEN_ENV_VAR = "HF_ADMIN_TOKEN";

/**
 * Resolved Hugging Face credentials.
 *
 * The token stays a `Redacted<string>` end-to-end — it is only unwrapped
 * inside `HttpClientRequest.bearerToken`, which formats the header without
 * ever exposing the value to a logger or an error message.
 *
 * `token` is an **Effect, not a value**, and that is deliberate. Alchemy
 * builds the whole `providers:` Layer eagerly when a stack starts, before it
 * knows whether any Hugging Face resource will actually be touched. With an
 * eagerly-resolved token, a colleague running a routine `plan` — where every
 * HF resource is a `noop` — had to hold an org-admin token they have no
 * business needing, or the run died at Layer construction. Deferring the read
 * to the moment a request is issued moves the failure from *build* to *use*.
 *
 * The Effect is memoized by its producer ({@link fromEnv} / {@link fromToken}),
 * so a deploy touching several HF resources resolves it once.
 */
export type HuggingFaceCredentials = {
  /**
   * Resolves the organization admin token, redacted. Fails with a
   * {@link ConfigError} naming the environment variable when it is absent.
   */
  readonly token: Effect.Effect<Redacted.Redacted<string>, ConfigError>;
  /**
   * Hub base URL. Defaults to `https://huggingface.co`; override for a
   * self-hosted Enterprise Hub deployment.
   *
   * Unlike the token this stays eager: it has a default and cannot fail in a
   * way an operator can only discover at request time.
   */
  readonly endpoint: string;
};

/**
 * `Context.Service` carrying the Hugging Face admin bearer token.
 *
 * There is no distilled SDK for the Hub, so unlike the GCP provider (which
 * re-exports `@distilled.cloud/gcp`'s tag) this tag is declared here and is
 * the one and only tag the {@link import("../Http/Client.ts").HubClient}
 * layer resolves against. Provide it with {@link fromEnv} or
 * {@link fromToken}.
 */
export class Credentials extends Context.Service<
  Credentials,
  HuggingFaceCredentials
>()("@microagi/alchemy-hf/Credentials") {}

/** Default Hub base URL. */
export const DEFAULT_ENDPOINT = "https://huggingface.co";

export type FromEnvOptions = {
  /** Environment variable holding the token. Default `HF_ADMIN_TOKEN`. */
  env?: string;
  /**
   * Environment variable holding the Hub base URL. Default `HF_ENDPOINT`.
   * Absent or empty falls back to {@link DEFAULT_ENDPOINT}.
   */
  endpointEnv?: string;
};

/**
 * Build a {@link Credentials} Layer that reads the admin token from the
 * environment (via Effect's `Config`, so an alternate `ConfigProvider` works
 * too).
 *
 * **Building this Layer never fails on a missing token.** The read is
 * deferred into the `token` Effect (see {@link HuggingFaceCredentials}) and
 * memoized with `Effect.cached`, so the variable is consulted the first time
 * a request is actually issued and at most once per Layer instance. A stack
 * whose Hugging Face resources are all `noop` therefore needs no token at
 * all.
 *
 * Failure is a typed {@link ConfigError} rather than a defect: a missing
 * token is a user-fixable configuration problem, and the message names the
 * variable plus the scope the token needs. The endpoint stays eager — it has
 * a default, and a malformed one is worth rejecting up front.
 */
export const fromEnv = (options?: FromEnvOptions) =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const envVar = options?.env ?? DEFAULT_TOKEN_ENV_VAR;
      // Pin the `ConfigProvider` that is in scope where the Layer is built.
      // Without this the deferred read would resolve against whatever
      // provider happens to be ambient at *request* time — i.e. the default
      // environment provider, silently ignoring a caller that wired an
      // alternate `ConfigProvider` around the Layer.
      const configProvider = yield* ConfigProvider.ConfigProvider;
      const token = yield* Effect.cached(
        Config.redacted(envVar).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
          Effect.mapError(
            () =>
              new ConfigError({
                message:
                  `Hugging Face admin token not found: set ${envVar} to an organization ` +
                  `admin token with the \`org.serviceAccounts.write\` permission ` +
                  `(Settings → Organization → Tokens on an Enterprise org).`,
              }),
          ),
        ),
      );
      const endpointVar = options?.endpointEnv ?? "HF_ENDPOINT";
      const endpoint = yield* Config.string(endpointVar).pipe(
        Effect.orElseSucceed(() => DEFAULT_ENDPOINT),
      );
      return {
        token,
        endpoint: yield* normalizeEndpoint(endpoint, endpointVar),
      } satisfies HuggingFaceCredentials;
    }),
  );

/** A token supplied directly, or an Effect that resolves one on demand. */
export type TokenSource =
  | Redacted.Redacted<string>
  | string
  | Effect.Effect<Redacted.Redacted<string> | string, ConfigError>;

/**
 * Build a {@link Credentials} Layer from a token already in hand — or from an
 * Effect that produces one.
 *
 * The Effect form is the seam for sourcing the token from somewhere other
 * than the ambient environment (Alchemy state, a `SeededSecret`, a secret
 * manager) without the read happening at Layer-build time. It is memoized
 * with `Effect.cached` exactly as {@link fromEnv} does, so it runs at most
 * once per Layer instance no matter how many resources reconcile.
 */
export const fromToken = (token: TokenSource, endpoint = DEFAULT_ENDPOINT) =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const normalized = yield* normalizeEndpoint(endpoint);
      const resolve = Effect.isEffect(token)
        ? yield* Effect.cached(Effect.map(token, redact))
        : Effect.succeed(redact(token));
      return {
        token: resolve,
        endpoint: normalized,
      } satisfies HuggingFaceCredentials;
    }),
  );

/** @internal */
const redact = (
  token: Redacted.Redacted<string> | string,
): Redacted.Redacted<string> =>
  Redacted.isRedacted(token) ? token : Redacted.make(token);

/**
 * Strip trailing slashes so path concatenation never produces `//api/...`,
 * which the Hub's router treats as a distinct (404) path, and validate that
 * what is left is an absolute `http`/`https` URL.
 *
 * The validation is not cosmetic. `HubClient` composes the request URL with
 * `new URL(`${endpoint}${path}`)`, which **throws** on a scheme-less value
 * like `huggingface.co`. A throw inside `Effect.gen` is an unhandled defect,
 * not a typed failure, so it escapes every `catchTag` the rest of the
 * package relies on and surfaces as an opaque crash. Failing here keeps a
 * misconfigured endpoint in the typed {@link ConfigError} channel, where the
 * message can name the variable and show the expected shape.
 *
 * @internal
 */
export const normalizeEndpoint = (
  endpoint: string,
  /** Name used in the error message — an env var, or the parameter. */
  source = "endpoint",
): Effect.Effect<string, ConfigError> => {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return Effect.succeed(DEFAULT_ENDPOINT);

  const fail = Effect.fail(
    new ConfigError({
      message:
        `Invalid Hugging Face endpoint ${JSON.stringify(endpoint)} (from ${source}): ` +
        `it must be an absolute http/https URL, e.g. ${DEFAULT_ENDPOINT}.`,
    }),
  );

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail;
  return Effect.succeed(trimmed);
};
