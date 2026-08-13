# @microagi/alchemy-hf

Hugging Face provider for [Alchemy v2](https://v2.alchemy.run) — Effect-native Infrastructure-as-Code. Alchemy ships only AWS + Cloudflare providers out of the box; this package covers the Hugging Face Hub's organization service accounts, service-account tokens, and buckets.

Unlike [`@microagi/alchemy-gcp`](https://github.com/MicroAGI-Labs/alchemy-v2-gcp), there is no `@distilled.cloud/*` SDK for the Hub, so this package carries a small typed HTTP client of its own. It is built on `effect/unstable/http` (Effect v4 ships an `HttpClient` in-tree — `@effect/platform` is not involved), and every lifecycle handler returns an `Effect`, never a `Promise`.

## Two entrypoints

| Import | Contains | Depends on |
|---|---|---|
| `@microagi/alchemy-hf/client` | The typed Hub client: `createServiceAccount`, `createToken`, `rotateToken`, `createBucket`, … as plain Effects | `effect` only |
| `@microagi/alchemy-hf` | The above, **plus** the Alchemy `Resource`s and the `providers()` bundle | `effect` + `alchemy` |

The split exists because credentials are minted in two very different places. A stack deploys them declaratively; a long-running controller mints and revokes them per-tenant at runtime, with no engine, no state store, and no reason to load `alchemy/Provider`. Nothing reachable from the `/client` subpath imports Alchemy.

The resources are a thin lifecycle wrapper over the client operations — there is exactly one HTTP implementation and one set of wire types.

## Install

```sh
bun add @microagi/alchemy-hf alchemy@next effect
# or
npm install @microagi/alchemy-hf alchemy@next effect
```

`alchemy` and `effect` are peer dependencies and must resolve to a single instance in your tree, or the `Context.Service` tag identity that carries credentials will not match. (`alchemy` is only needed if you use the package root; the `/client` subpath does not touch it.)

The `next` dist-tag is required for `alchemy` because `latest` still points at the v1 line; v2 betas live under `next`.

## Authenticate

Every operation needs an **organization admin token** carrying `org.serviceAccounts.write` (bucket operations additionally need write access in the namespace). Mint one under *Settings → Organization → Tokens*.

```sh
export HF_ADMIN_TOKEN=hf_...
```

The variable is deliberately **not** the conventional `HF_TOKEN` that `huggingface_hub` and the CLI pick up. The token here is far more privileged than a researcher's repo token, and keeping the names distinct stops an inherited shell environment from silently driving infrastructure. Override it with `providers({ env: "MY_VAR" })` if you must.

The token is held as `Redacted<string>` from the moment it is read until `HttpClientRequest.bearerToken` formats the header. It never appears in a log line, an error message, a request URL, or plan output.

Set `HF_ENDPOINT` to point at a self-hosted Enterprise Hub; it defaults to `https://huggingface.co`.

### Prerequisite: an Enterprise organization

Organization service accounts are an **Enterprise Hub** feature. On any other plan the endpoints answer `403`, which this package surfaces as a `Forbidden` error. Buckets likewise require the feature to be enabled for the namespace.

## Resources

### `HuggingFace.ServiceAccount`

A machine identity within an organization, separate from any human member.

```ts
const trainer = yield* HF.ServiceAccount("Trainer", {
  organization: "MicroAGI-Labs",
  name: "research-trainer",
  description: "Pulls weights and writes eval outputs",
});
// trainer.id -> the Hub's `_id`, needed by ServiceAccountToken
```

| Prop | Mutability |
|---|---|
| `organization` | identity — replaces |
| `name` | **immutable** — replaces |
| `description` | **immutable** — replaces |

The Hub exposes no update endpoint for service accounts, so `diff` turns *any* prop change into a replacement. Replacing an account destroys every token on it.

Outputs: `{ id, organization, name }`.

### `HuggingFace.ServiceAccountToken`

A token on a service account. **The plaintext value is disclosed exactly once**, at creation and at each rotation; no endpoint ever returns it again.

```ts
const token = yield* HF.ServiceAccountToken("TrainerToken", {
  organization: "MicroAGI-Labs",
  serviceAccountId: trainer.id,
  displayName: "trainer",
  repoIds: [datasets.bucketId],           // 24-hex _id — see below
  repoPermissions: ["repo.content.read"],
});
// token.value is Redacted<string>
```

Outputs: `{ tokenId, displayName, value: Redacted<string>, version }`.

- The value is persisted in Alchemy state as `Redacted<string>`. Alchemy's state encoder round-trips `Redacted` losslessly (its `__redacted__` marker), so the real value survives while staying opaque to logs and plan output. This is the same pattern as `SeededSecret` in the research-infra stack and `Cloudflare.Calls.App.secret` upstream.
- **Scope changes update in place** via `PATCH`; the persisted value carries forward untouched.
- **Rotation is driven by `version`.** Bump it (default `1`) and the next deploy rotates: the Hub mints a new value, and the old one stops working *immediately*. The committed bump is the audit trail.
- **Losing state loses the value.** The token still exists on the Hub, but nothing can recover its plaintext. The reconciler detects this and fails with an explicit instruction to bump `version` rather than persisting an empty secret that would fail confusingly at use time.
- Only `organization` and `serviceAccountId` are immutable; changing either replaces.

`permissions` is the closed 13-value enum (`repo.content.read`, `repo.write`, `inference.serverless.write`, `inference.endpoints.infer.write`, `inference.endpoints.write`, `org.read`, `org.write`, `collection.read`, `collection.write`, `resourceGroup.write`, `job.write`, `org.serviceAccounts.read`, `org.serviceAccounts.write`). `repoIds` + `repoPermissions` override the org-wide `permissions` for the listed repos. `endpointPatterns` is capped at 20 entries of ≤256 characters. All of this is validated locally, before any request.

Deletion uses `DELETE .../service-accounts/{id}/tokens/{tokenId}`. Note that `POST /api/organizations/{name}/settings/tokens/{tokenId}/revoke` revokes an organization *member's* token and does **not** apply to service accounts.

### `HuggingFace.Bucket`

Hub object storage under a namespace, addressed as `namespace/name`. Buckets are repo type `bucket` and are **not** creatable via `POST /api/repos/create`, hence the dedicated `/api/buckets` endpoints.

```ts
const datasets = yield* HF.Bucket("Datasets", {
  namespace: "MicroAGI-Labs",
  name: "datasets",
  private: true,
  region: "eu",
});
```

Outputs: `{ bucketId, fullName, namespace, name, url }`.

| Prop | Mutability |
|---|---|
| `namespace`, `name` | identity — replaces |
| `region` | **immutable** — replaces (data cannot move between regions) |
| `private`, `cdn` | mutable via `PUT .../settings` |
| `resourceGroupId` | mutable via `POST .../resource-group`; clearing it detaches |

A duplicate create answers `409` carrying the existing bucket. That is free idempotency, so it is treated as adoption rather than an error.

#### `_id` vs `id` — read this before wiring a token

The Hub uses both field names on the bucket endpoints, and they mean different things:

```jsonc
// GET /api/buckets/MicroAGI-Labs/datasets
{
  "_id": "6a6f8f4083f1c297d4dbb0d7",   // 24-hex repo id  -> this goes in repoIds
  "id":  "MicroAGI-Labs/datasets",     // namespace/name  -> NOT a repo id
  "repoType": "bucket"
}
```

This is why the outputs are named `bucketId` (the 24-hex `_id`) and `fullName` (the `namespace/name` string) rather than reusing `id` for either. It is also why the provider **always re-`GET`s the bucket after a create or a 409 adopt** instead of reading an id out of the create/error response: the create payload's `id` field has not been verified to be the hex form, and on `GET` that field name carries the `namespace/name` string. Only `GET`'s `_id` is known to be the value `repoIds` accepts.

`ServiceAccountToken` validates `repoIds` against `^[0-9a-fA-F]{24}$` before issuing any request, so passing `bucket.fullName` by mistake fails immediately with a message naming `bucketId`.

## Unverified: bucket ids in a token's `repoIds`

Hugging Face's bucket documentation advises scoping a token to specific buckets, and `repoIds` is the only field that could express that. **But the OpenAPI description does not confirm that a bucket's `_id` is accepted there** — `repoIds` is documented generically for repositories, and buckets are a distinct repo type.

This package therefore validates the *shape* of a `repoId` but cannot validate that the Hub honours a bucket id in that position. **This needs a one-shot empirical test**: mint a token with `repoIds: [<bucket _id>]` and `repoPermissions: ["repo.content.read"]`, then attempt a read against the bucket with it and a read against an unrelated repo. If bucket ids turn out to be rejected (or silently ignored, granting broader access than intended), the fix belongs in this package and the README should be updated to say so.

Until that test is run, treat bucket-scoped tokens as unproven and prefer a dedicated service account per trust boundary.

## Rate limits are per account, not per token

Hugging Face keys its rate limits to the **account**, not the token. Minting several tokens on one service account does not multiply the quota — they all draw from the same bucket, and one noisy workload will throttle the others. Separate service accounts are separate identities with separate quotas, so split by workload at the *service account* level when throughput matters; use multiple tokens on one account only when you want independent revocation and scope within a single quota.

## Use — the Alchemy path

`alchemy.run.ts`:

```ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HF from "@microagi/alchemy-hf";

export default Alchemy.Stack(
  "research",
  {
    providers: HF.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const datasets = yield* HF.Bucket("Datasets", {
      namespace: "MicroAGI-Labs",
      name: "datasets",
      private: true,
      region: "eu",
    });

    const reader = yield* HF.ServiceAccount("Reader", {
      organization: "MicroAGI-Labs",
      name: "datasets-reader",
    });

    yield* HF.ServiceAccountToken("ReaderToken", {
      organization: "MicroAGI-Labs",
      serviceAccountId: reader.id,
      displayName: "datasets-reader",
      repoIds: [datasets.bucketId],
      repoPermissions: ["repo.content.read"],
      version: 1,
    });
  }),
);
```

```sh
bun alchemy plan ./alchemy.run.ts
bun alchemy deploy ./alchemy.run.ts
bun alchemy destroy ./alchemy.run.ts
```

`providers()` does not provide an HTTP client — Alchemy's `Stack` provides `FetchHttpClient.layer` once at the top level, matching the AWS, Cloudflare and GCP provider bundles.

## Use — the runtime path

For a controller that mints and revokes credentials dynamically, import the client subpath and wire the three layers yourself. No Alchemy, no state store.

```ts
import * as HF from "@microagi/alchemy-hf/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const Hub = HF.hubClientLayer.pipe(
  Layer.provide(HF.credentialsFromEnv()),        // or credentialsFromToken(...)
  Layer.provide(FetchHttpClient.layer),
);

const ORG = "MicroAGI-Labs";

/** Mint an isolated identity + a bucket-scoped token for one tenant. */
const provision = (tenant: string, bucketId: string) =>
  Effect.gen(function* () {
    const account = yield* HF.createServiceAccount({
      organization: ORG,
      body: { name: `tenant-${tenant}`, description: `ephemeral: ${tenant}` },
    });

    const token = yield* HF.createToken({
      organization: ORG,
      serviceAccountId: account._id,
      body: {
        displayName: `tenant-${tenant}`,
        repoIds: [bucketId],
        repoPermissions: ["repo.content.read"],
      },
    });

    // Disclosed exactly once — hand it to the workload now or lose it.
    return {
      serviceAccountId: account._id,
      tokenId: token.tokenId,
      value: Redacted.value(token.value),
    };
  });

/** Tear the identity down. Deleting the account invalidates its tokens too. */
const deprovision = (serviceAccountId: string) =>
  HF.deleteServiceAccount({ organization: ORG, serviceAccountId });

await Effect.runPromise(
  provision("42", "6a6f8f4083f1c297d4dbb0d7").pipe(Effect.provide(Hub)),
);
```

Other operations on the same entrypoint: `getServiceAccount`, `listServiceAccounts`, `findServiceAccountByName`, `patchToken`, `rotateToken`, `deleteToken`, `findToken`, `createBucket`, `getBucket`, `findBucket`, `listBuckets`, `updateBucketSettings`, `setBucketResourceGroup`, `deleteBucket`.

## Errors

The Hub's OpenAPI description declares **no error responses on any of these operations**, so nothing can be generated from it. Non-2xx responses are classified defensively by status into tagged errors — `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `RateLimited`, `ServerError`, `UnexpectedStatus`, plus `TransportError` and `DecodeError` — so lifecycle code reads the same as it does against a distilled SDK:

```ts
yield* getBucket({ namespace, name }).pipe(
  Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
);
```

Each error carries `status`, `method`, `url`, a best-effort `message` extracted from the body, and the parsed `body` itself — which is what makes the bucket 409-adopt path possible. Request bodies are never attached (they can carry a token), and the bearer token appears in none of these fields.

Local validation failures (a malformed `repoId`, too many endpoint patterns, an unknown permission) surface as `ConfigError` **before** any request is made.

## Adoption

Neither service accounts nor buckets carry a label, tag, or writable metadata channel, so there is no way to stamp `(app, stage, id)` ownership onto them the way the GCP provider does with labels or a description marker. Ownership is therefore proven only by the identifier already in Alchemy state:

- `read` finds the object **and** the id in state matches → plain attributes, silent adoption.
- `read` finds the object by name with no matching state → `Unowned`, so the engine refuses unless the operator passes `--adopt` (or `adopt(true)`).
- Nothing found → `undefined`, so the engine creates.

`ServiceAccountToken` is the exception: a token exists on a service account only because this resource minted it, and the value in state is itself the proof of ownership.

## Development

```sh
bun install
bun tsc --noEmit     # native TS7 compiler
CI=1 bun test        # unit tests; no network, HTTP is stubbed at both levels
bun run build
```

Tests never reach the network. `test/support.ts` provides two doubles: `stubHttp` replaces `HttpClient` and exercises the *real* client layer (URL assembly, auth header, status classification), while `stubHub` replaces `HubClient` and records the requests, which is how the operations and the reconcilers are tested.

## License

Apache-2.0.
