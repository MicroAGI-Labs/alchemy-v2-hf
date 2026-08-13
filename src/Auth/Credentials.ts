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
      const endpoint = yield* Config.string(
        options?.endpointEnv ?? "HF_ENDPOINT",
      ).pipe(Effect.orElseSucceed(() => DEFAULT_ENDPOINT));
      return {
        token,
        endpoint: normalizeEndpoint(endpoint),
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
  Layer.succeed(Credentials, {
    token: Redacted.isRedacted(token) ? token : Redacted.make(token),
    endpoint: normalizeEndpoint(endpoint),
  } satisfies HuggingFaceCredentials);

/**
 * Strip trailing slashes so path concatenation never produces `//api/...`,
 * which the Hub's router treats as a distinct (404) path.
 *
 * @internal
 */
export const normalizeEndpoint = (endpoint: string): string =>
  endpoint.replace(/\/+$/, "") || DEFAULT_ENDPOINT;
