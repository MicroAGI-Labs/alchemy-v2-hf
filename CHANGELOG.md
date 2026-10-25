# Changelog

All notable changes to `@microagi/alchemy-hf`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.0 — 2026-10-25

### Added

- **`HuggingFace.Repo`**: a model, dataset or space repository, created with
  `POST /api/repos/create` and re-read for its 24-hex `_id` (the `repoId`
  attribute, what a token's `repoIds` takes). `resourceGroupId` is synced in
  place. **Visibility is never changed**: `private` is the visibility at
  creation and an assertion afterwards; an existing repo whose visibility
  differs fails the deploy with a `ConfigError`, and no operation in the
  package sends `private` or `visibility` to a settings endpoint.
- **`HuggingFace.ResourceGroup`** (Team and Enterprise plans): `members` is
  the complete list; a deploy adds the missing members, changes differing
  roles and removes everyone else, and keeps auto-join off. Renames are
  synced in place (the group is found by the id in state).
- Client: `createRepo`, `getRepo`, `findRepo`, `setRepoResourceGroup`,
  `deleteRepo`; `listResourceGroups`, `getResourceGroup`,
  `findResourceGroupByName`, `createResourceGroup`, `updateResourceGroup`,
  `setResourceGroupAutoJoin`, `addResourceGroupUsers`,
  `setResourceGroupUserRole`, `removeResourceGroupUser`,
  `deleteResourceGroup`, `planResourceGroupUsers`; and
  `listOrganizationMembers` (every page, through the `Link` header), whose
  members carry `verifiedEmail` when it matches the organization's verified
  email domain.
- `HubResponse.link`: the response's `Link` header.
- `ServiceAccount`'s `user` attribute (its Hub username), for resource-group
  membership.

## 0.3.0 — 2026-08-13

### Added

- **`providers({ credentials })`** — supply your own `Credentials` Layer
  instead of the default env-backed one.

  The bundle satisfies `Credentials` internally with `Layer.provideMerge`, so
  a Layer provided *around* `providers()` is shadowed rather than honoured.
  There was therefore no way to source the admin token from anywhere but the
  process environment. Combined with `credentialsFromToken`'s `Effect` token
  source (0.2.0), this is the seam for reading it out of the consuming
  stack's own IaC state or a secret manager, still lazily and still memoized.

  Purely additive: omitting the option keeps the `fromEnv(options)` behaviour
  byte for byte.

## 0.2.0 — 2026-08-13

### Changed — BREAKING

- **`Credentials` resolves the admin token lazily.**
  `HuggingFaceCredentials.token` is now
  `Effect<Redacted<string>, ConfigError>` instead of `Redacted<string>`.

  Alchemy builds the whole `providers:` Layer eagerly when a stack starts, so
  an eagerly-read token failed **every** `plan` and `deploy` — including runs
  where all Hugging Face resources were `noop` and no request was ever going
  to be made. Colleagues had to hold an organization-admin token to run a
  read-only plan. The read now happens inside the request path, so the
  failure surfaces at *use* rather than at *build*.

  The Effect is memoized (`Effect.cached`) by both `fromEnv` and `fromToken`,
  so a deploy touching several HF resources reads the configuration once.
  `fromEnv` also pins the `ConfigProvider` that was in scope when the Layer
  was built, so an alternate provider is still honoured by the deferred read.

  Migration: anything that consumed `credentials.token` as a value now
  `yield*`s it. `HubClient.request` / `HubClient.json` — and therefore every
  client operation — carry `ConfigError` in their error channel alongside
  `HubError`.

  `endpoint` is unchanged and still eager: it has a default and a malformed
  one is worth rejecting up front.

### Added

- **`fromToken` accepts an Effect** (`TokenSource`), not just a
  `Redacted<string> | string`. This is the seam for sourcing the token from
  Alchemy state or a secret manager without the read happening at Layer-build
  time; it is memoized the same way `fromEnv` is. Nothing in this release
  wires state in.

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
