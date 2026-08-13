import * as Config from "effect/Config";
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
 */
export type HuggingFaceCredentials = {
  /** Organization admin token, redacted. */
  readonly token: Redacted.Redacted<string>;
  /**
   * Hub base URL. Defaults to `https://huggingface.co`; override for a
   * self-hosted Enterprise Hub deployment.
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
 * Failure is a typed {@link ConfigError} rather than a defect: a missing
 * token is a user-fixable configuration problem, and the message names the
 * variable plus the scope the token needs.
 */
export const fromEnv = (options?: FromEnvOptions) =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const envVar = options?.env ?? DEFAULT_TOKEN_ENV_VAR;
      const token = yield* Config.redacted(envVar).pipe(
        Effect.mapError(
          () =>
            new ConfigError({
              message:
                `Hugging Face admin token not found: set ${envVar} to an organization ` +
                `admin token with the \`org.serviceAccounts.write\` permission ` +
                `(Settings → Organization → Tokens on an Enterprise org).`,
            }),
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

/**
 * Build a {@link Credentials} Layer from a token already in hand. Useful for
 * tests and for stacks that source the token from another resource (e.g. a
 * `SeededSecret`) rather than from the ambient environment.
 */
export const fromToken = (
  token: Redacted.Redacted<string> | string,
  endpoint = DEFAULT_ENDPOINT,
) =>
  Layer.effect(
    Credentials,
    Effect.map(
      normalizeEndpoint(endpoint),
      (normalized) =>
        ({
          token: Redacted.isRedacted(token) ? token : Redacted.make(token),
          endpoint: normalized,
        }) satisfies HuggingFaceCredentials,
    ),
  );

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
