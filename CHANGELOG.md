# Changelog

All notable changes to `@microagi/alchemy-hf`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-08-13

Initial release.

### Added

- **Standalone Hub client** (`@microagi/alchemy-hf/client`) — the Hugging Face
  Hub REST operations as plain Effects over a typed `HubClient` service, built
  on `effect/unstable/http`. Depends on `effect` only: nothing reachable from
  this entrypoint imports `alchemy`, so a long-running controller can mint and
  revoke credentials at runtime without the IaC engine. Covers service-account
  create/get/list/delete, token create/patch/rotate/delete/find, and bucket
  create/get/list/settings/resource-group/delete.
- **`Credentials`** — a `Context.Service` holding the organization admin token
  as `Redacted<string>`, with `fromEnv` (default `HF_ADMIN_TOKEN`, overridable)
  and `fromToken` Layers. The token is never unwrapped outside
  `HttpClientRequest.bearerToken`.
- **Tagged errors** — the Hub declares no error responses on any of these
  operations, so non-2xx statuses are classified defensively into
  `BadRequest` / `Unauthorized` / `Forbidden` / `NotFound` / `Conflict` /
  `RateLimited` / `ServerError` / `UnexpectedStatus`, plus `TransportError`,
  `DecodeError` and a local `ConfigError`. Each carries the parsed response
  body, which is what makes the bucket 409-adopt path possible.
- **`HuggingFace.ServiceAccount`** — organization service accounts. Every prop
  is identity or immutable (the Hub has no update endpoint), so any change
  replaces. Idempotent create: a name collision falls back to a list scan and
  adopts.
- **`HuggingFace.ServiceAccountToken`** — tokens on a service account. The
  once-only plaintext value is persisted in Alchemy state as
  `Redacted<string>`; scope changes `PATCH` in place and carry the value
  forward; a `version` bump rotates and re-persists. A token whose value is
  missing from state fails with an explicit instruction to bump `version`
  rather than persisting an empty secret. `repoIds` are validated as 24-hex
  repo `_id`s, `permissions` against the closed 13-value enum, and
  `endpointPatterns` against the 20 × 256-character limits — all before any
  request.
- **`HuggingFace.Bucket`** — Hub buckets (repo type `bucket`, which
  `POST /api/repos/create` does not handle). `private` and `cdn` sync in
  place, `region` and identity replace, and a duplicate-create `409` is
  treated as adoption. Outputs are named `bucketId` (the 24-hex `_id`, the
  value a token's `repoIds` accepts) and `fullName` (the `namespace/name`
  string) because the Hub uses `_id` and `id` for those two different things
  on the same payload. The provider always re-`GET`s after a create or adopt
  so the id comes from the one endpoint known to return the hex form.
- **`providers()`** — the resource bundle plus the Hub client and env-backed
  credentials, for `Alchemy.Stack({ providers })`. An HTTP client is
  deliberately not re-provided; `Stack` supplies `FetchHttpClient.layer`.

### Known unknowns

- It is **unverified whether the Hub accepts a bucket `_id` in a token's
  `repoIds`**. The bucket documentation advises scoping tokens to buckets, but
  the OpenAPI description does not confirm bucket ids are accepted in that
  field. Needs a one-shot empirical test; see the README.
