import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Credentials } from "../Auth/Credentials.ts";
import {
  type ConfigError,
  DecodeError,
  fromStatus,
  type HubError,
  messageFromBody,
  TransportError,
} from "../Errors.ts";

/**
 * Minimal typed HTTP client for the Hugging Face Hub REST API.
 *
 * There is no `@distilled.cloud/*` package for the Hub, so this is the layer
 * that plays the role distilled plays in `@microagi/alchemy-gcp`: it turns
 * one HTTP exchange into an `Effect` with a tagged error channel, so
 * lifecycle handlers can write `Effect.catchTag("NotFound", …)` and
 * `Effect.catchTag("Conflict", …)` exactly as they do over there.
 *
 * Built on `effect/unstable/http` (Effect v4 ships HttpClient in-tree; the
 * separate `@effect/platform` package is not needed). Alchemy's `Stack`
 * already provides `FetchHttpClient.layer` at the top level — see
 * `vendor/alchemy/packages/alchemy/src/Stack.ts` — so, mirroring the GCP
 * provider, {@link layer} does **not** re-provide an HTTP client.
 */

/** One request against the Hub. `path` is absolute, e.g. `/api/buckets/ns`. */
export type HubRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  /** JSON request body. Omitted entirely when `undefined`. */
  readonly body?: unknown;
  /**
   * Query string parameters. Entries whose value is `undefined` are dropped,
   * so callers can pass optional props straight through.
   */
  readonly searchParams?: Readonly<Record<string, string | undefined>>;
};

/** A 2xx response. `body` is `undefined` for `204`/empty bodies. */
export type HubResponse = {
  readonly status: number;
  readonly body: unknown;
  /** The `Link` header, when the Hub paginates (`<url>; rel="next"`). */
  readonly link?: string;
};

/**
 * Service shape of {@link HubClient}.
 *
 * `request` fails on any non-2xx with the tagged error for that status, so
 * the happy path never has to check `status`. The one place a status still
 * matters is bucket creation, where a `409` carries the existing bucket and
 * is caught deliberately.
 *
 * `ConfigError` is in the channel because the admin token is resolved lazily,
 * at request time — see
 * {@link import("../Auth/Credentials.ts").HuggingFaceCredentials}. A missing
 * token surfaces here rather than at Layer construction.
 */
export type HubClientService = {
  readonly request: (
    req: HubRequest,
  ) => Effect.Effect<HubResponse, HubError | ConfigError>;
  /** Same as `request`, but narrows the decoded body to `A`. */
  readonly json: <A>(
    req: HubRequest,
  ) => Effect.Effect<A, HubError | ConfigError>;
  /** Resolved Hub base URL, for error messages and docs links. */
  readonly endpoint: string;
};

export class HubClient extends Context.Service<HubClient, HubClientService>()(
  "@microagi/alchemy-hf/HubClient",
) {}

/**
 * Compose the request URL. Exported for tests — URL assembly (in particular
 * dropping `undefined` search params and never double-slashing) is the kind
 * of thing that is easier to assert directly than through a stub.
 *
 * @internal
 */
export const buildUrl = (endpoint: string, req: HubRequest): string => {
  const url = new URL(`${endpoint}${req.path}`);
  for (const [key, value] of Object.entries(req.searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
};

/**
 * Build a {@link HubClient} from the ambient `HttpClient` and
 * {@link Credentials}.
 *
 * The token is resolved per request (the credentials carry a memoized Effect,
 * not a value) and applied with `HttpClientRequest.bearerToken`, which accepts
 * a `Redacted` directly — the plaintext is never materialised in this module.
 */
export const layer: Layer.Layer<
  HubClient,
  never,
  HttpClient.HttpClient | Credentials
> = Layer.effect(
  HubClient,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const credentials = yield* Credentials;

    const request = (
      req: HubRequest,
    ): Effect.Effect<HubResponse, HubError | ConfigError> =>
      Effect.gen(function* () {
        const url = buildUrl(credentials.endpoint, req);
        // Resolved here, not at Layer build: a stack whose HF resources are
        // all noop never reaches this line and so never needs a token.
        const token = yield* credentials.token;
        let httpRequest = HttpClientRequest.make(req.method)(url).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
        );
        if (req.body !== undefined) {
          httpRequest = yield* HttpClientRequest.bodyJson(
            httpRequest,
            req.body,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new TransportError({
                  method: req.method,
                  url,
                  message: `Failed to encode the request body as JSON: ${String(cause)}`,
                  cause,
                }),
            ),
          );
        }

        const response = yield* http.execute(httpRequest).pipe(
          Effect.mapError(
            (cause) =>
              new TransportError({
                method: req.method,
                url,
                message: `${req.method} ${url} failed before a response was received: ${cause.reason._tag}`,
                cause,
              }),
          ),
        );

        // Read the body as text first and parse leniently: the Hub returns
        // `204` with no body on deletes, and serves HTML (an error page or a
        // login redirect) when a token is rejected at the edge rather than by
        // the API. Both would blow up a strict JSON decode with a message
        // that says nothing useful about what actually went wrong.
        const text = yield* response.text.pipe(
          Effect.mapError(
            (cause) =>
              new TransportError({
                method: req.method,
                url,
                message: `${req.method} ${url} returned ${response.status} but the body could not be read: ${cause.reason._tag}`,
                cause,
              }),
          ),
        );
        const body = parseJson(text);

        if (response.status >= 200 && response.status < 300) {
          const link = response.headers["link"];
          return { status: response.status, body, ...(link ? { link } : {}) } satisfies HubResponse;
        }

        return yield* Effect.fail(
          fromStatus({
            status: response.status,
            method: req.method,
            url,
            message: messageFromBody(
              body,
              `${req.method} ${url} failed with HTTP ${response.status}`,
            ),
            body,
          }),
        );
      });

    const json = <A>(
      req: HubRequest,
    ): Effect.Effect<A, HubError | ConfigError> =>
      request(req).pipe(
        Effect.flatMap((response) =>
          response.body === undefined
            ? Effect.fail(
                new DecodeError({
                  status: response.status,
                  method: req.method,
                  url: buildUrl(credentials.endpoint, req),
                  message: `Expected a JSON body from ${req.method} ${req.path} but the response was empty.`,
                }),
              )
            : Effect.succeed(response.body as A),
        ),
      );

    return { request, json, endpoint: credentials.endpoint };
  }),
);

/**
 * Parse a response body as JSON, returning `undefined` for an empty body and
 * the raw text for anything that is not JSON (an HTML error page). Never
 * throws — classification of the result is the caller's job.
 *
 * @internal
 */
export const parseJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
};
