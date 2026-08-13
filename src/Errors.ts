import * as Data from "effect/Data";

/**
 * Typed errors for the Hugging Face Hub provider.
 *
 * The Hub's OpenAPI description declares **no** error responses on any of
 * the operations this provider calls, so nothing can be generated from the
 * spec — every non-2xx has to be classified defensively by status code.
 * The tags below mirror the ones `@distilled.cloud/gcp` produces
 * (`NotFound`, `Conflict`, `Forbidden`, …) so lifecycle code reads the same
 * as it does in `@microagi/alchemy-gcp`:
 *
 * ```ts
 * yield* client.request(...).pipe(
 *   Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
 * );
 * ```
 *
 * Every field on these errors is safe to print. Request bodies are **not**
 * attached (they may carry a token), and the bearer token never appears in
 * `url`, `message`, or `body`.
 */

/** Fields shared by every error raised from an HTTP exchange. */
export type HubErrorFields = {
  /** HTTP status of the offending response. */
  status: number;
  /** HTTP method (`GET`, `POST`, …). */
  method: string;
  /** Request URL, without credentials. */
  url: string;
  /** Best-effort human-readable message extracted from the response body. */
  message: string;
  /**
   * Parsed response body, when the server returned JSON. Carried so callers
   * can mine it for useful payloads — most importantly the existing bucket's
   * identifier on a duplicate-create `409`.
   */
  body: unknown;
};

/** `400` — the Hub rejected the request shape or a field value. */
export class BadRequest extends Data.TaggedError("BadRequest")<HubErrorFields> {}

/** `401` — the token is missing, malformed, or revoked. */
export class Unauthorized extends Data.TaggedError(
  "Unauthorized",
)<HubErrorFields> {}

/**
 * `403` — the token authenticated but lacks the required permission (or the
 * organization is not on an Enterprise plan, which is how the Hub reports a
 * missing service-accounts entitlement).
 */
export class Forbidden extends Data.TaggedError("Forbidden")<HubErrorFields> {}

/** `404` — the organization, service account, token, or bucket is absent. */
export class NotFound extends Data.TaggedError("NotFound")<HubErrorFields> {}

/**
 * `409` — the object already exists. Bucket creation uses this as a feature:
 * the body carries the existing bucket, which the reconciler adopts.
 */
export class Conflict extends Data.TaggedError("Conflict")<HubErrorFields> {}

/** `429` — the account-wide rate limit was hit. */
export class RateLimited extends Data.TaggedError(
  "RateLimited",
)<HubErrorFields> {}

/** `5xx` — the Hub failed to serve the request. */
export class ServerError extends Data.TaggedError(
  "ServerError",
)<HubErrorFields> {}

/** Any other non-2xx status not covered by a more specific tag. */
export class UnexpectedStatus extends Data.TaggedError(
  "UnexpectedStatus",
)<HubErrorFields> {}

/** The request never produced a response (DNS, TLS, socket, abort). */
export class TransportError extends Data.TaggedError("TransportError")<{
  method: string;
  url: string;
  message: string;
  cause?: unknown;
}> {}

/** A 2xx response whose body was not the JSON shape the caller expected. */
export class DecodeError extends Data.TaggedError("DecodeError")<{
  status: number;
  method: string;
  url: string;
  message: string;
}> {}

/**
 * Local, plan-time configuration failure — an invalid prop value, a missing
 * secret in state, an unadoptable pre-existing object. Named to match
 * `@distilled.cloud/gcp`'s `ConfigError` so provider code reads identically
 * across the two packages.
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  message: string;
}> {}

/** Every error the {@link import("./Http/Client.ts").HubClient} can raise. */
export type HubError =
  | BadRequest
  | Unauthorized
  | Forbidden
  | NotFound
  | Conflict
  | RateLimited
  | ServerError
  | UnexpectedStatus
  | TransportError
  | DecodeError;

/**
 * Classify a non-2xx response into the tagged error for its status.
 *
 * @internal
 */
export const fromStatus = (fields: HubErrorFields): HubError => {
  switch (fields.status) {
    case 400:
      return new BadRequest(fields);
    case 401:
      return new Unauthorized(fields);
    case 403:
      return new Forbidden(fields);
    case 404:
      return new NotFound(fields);
    case 409:
      return new Conflict(fields);
    case 429:
      return new RateLimited(fields);
    default:
      return fields.status >= 500
        ? new ServerError(fields)
        : new UnexpectedStatus(fields);
  }
};

/**
 * Pull a human-readable message out of a Hub error body. The Hub is not
 * consistent about the envelope — `{ error }`, `{ message }`, and
 * `{ error: { message } }` all occur — so try each in turn before falling
 * back to a stringified snippet.
 *
 * @internal
 */
export const messageFromBody = (body: unknown, fallback: string): string => {
  if (typeof body === "string" && body.length > 0) return body.slice(0, 500);
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
    const nested = record.error;
    if (typeof nested === "object" && nested !== null) {
      const inner = (nested as Record<string, unknown>).message;
      if (typeof inner === "string") return inner;
    }
    return JSON.stringify(body).slice(0, 500);
  }
  return fallback;
};
