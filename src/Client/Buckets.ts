import * as Effect from "effect/Effect";
import type { ConfigError, HubError } from "../Errors.ts";
import { HubClient } from "../Http/Client.ts";
import type {
  BucketDetail,
  BucketSettingsBody,
  CreateBucketBody,
} from "./Types.ts";
import { validateHubName } from "./Validation.ts";

/**
 * Hub bucket operations.
 *
 * Buckets are repo type `bucket`, and `POST /api/repos/create` does **not**
 * handle them — hence the dedicated `/api/buckets` endpoints below.
 *
 * Like `./ServiceAccounts.ts`, these are plain Effects over
 * {@link HubClient} with no Alchemy dependency.
 */

const seg = (value: string): string => encodeURIComponent(value);

const bucketsPath = (namespace: string): string =>
  `/api/buckets/${seg(namespace)}`;

const bucketPath = (namespace: string, name: string): string =>
  `${bucketsPath(namespace)}/${seg(name)}`;

/**
 * Create a bucket, then re-`GET` it to obtain the authoritative identifiers.
 *
 * The re-read is not belt-and-braces: the create response's `id` field is
 * **not** dependable as the 24-hex repo id — on `GET` the field of that name
 * carries the `namespace/name` string instead, and the create payload has
 * not been verified to differ. Only `GET`'s `_id` is known to be the hex id
 * that a token's `repoIds` accepts, so that is what this returns.
 *
 * A duplicate create answers `409` with the existing bucket in the body.
 * That is free idempotency, so it is treated as success — but the id still
 * comes from the follow-up `GET`, never from the error body.
 */
export const createBucket = (input: {
  namespace: string;
  name: string;
  body?: CreateBucketBody;
}): Effect.Effect<
  { bucket: BucketDetail; adopted: boolean },
  HubError | ConfigError,
  HubClient
> =>
  Effect.gen(function* () {
    yield* validateHubName(input.namespace, "namespace");
    yield* validateHubName(input.name, "name");
    const client = yield* HubClient;

    const adopted = yield* client
      .request({
        method: "POST",
        path: bucketPath(input.namespace, input.name),
        body: input.body ?? {},
      })
      .pipe(
        Effect.as(false),
        // 409 means the bucket is already there. Adopt it rather than
        // failing: the caller asked for a bucket with this name to exist,
        // and one does.
        Effect.catchTag("Conflict", () => Effect.succeed(true)),
      );

    const bucket = yield* getBucket({
      namespace: input.namespace,
      name: input.name,
    });
    return { bucket, adopted };
  });

/**
 * Fetch one bucket. Read `_id` (24-hex) for a token's `repoIds`; `id` is the
 * `namespace/name` string.
 */
export const getBucket = (input: {
  namespace: string;
  name: string;
}): Effect.Effect<BucketDetail, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    return yield* client.json<BucketDetail>({
      method: "GET",
      path: bucketPath(input.namespace, input.name),
    });
  });

/** Fetch one bucket, or `undefined` when it does not exist. */
export const findBucket = (input: {
  namespace: string;
  name: string;
}): Effect.Effect<BucketDetail | undefined, HubError, HubClient> =>
  getBucket(input).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed(undefined as BucketDetail | undefined),
    ),
  );

/** List a namespace's buckets, optionally filtered by the Hub's `search`. */
export const listBuckets = (input: {
  namespace: string;
  search?: string;
}): Effect.Effect<ReadonlyArray<BucketDetail>, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    const body = yield* client.json<ReadonlyArray<BucketDetail>>({
      method: "GET",
      path: bucketsPath(input.namespace),
      searchParams: { search: input.search },
    });
    return Array.isArray(body) ? body : [];
  });

/**
 * Update a bucket's mutable settings (`private`, CDN attachments).
 *
 * `region` is fixed at creation and is not settable here — changing it means
 * a new bucket.
 */
export const updateBucketSettings = (input: {
  namespace: string;
  name: string;
  body: BucketSettingsBody;
}): Effect.Effect<void, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({
      method: "PUT",
      path: `${bucketPath(input.namespace, input.name)}/settings`,
      body: input.body,
    });
  });

/** Attach a resource group to a bucket, or pass `null` to detach. */
export const setBucketResourceGroup = (input: {
  namespace: string;
  name: string;
  resourceGroupId: string | null;
}): Effect.Effect<void, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({
      method: "POST",
      path: `${bucketPath(input.namespace, input.name)}/resource-group`,
      body: { resourceGroupId: input.resourceGroupId },
    });
  });

/** Delete a bucket and everything in it. Absent is treated as deleted. */
export const deleteBucket = (input: {
  namespace: string;
  name: string;
}): Effect.Effect<void, HubError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client
      .request({
        method: "DELETE",
        path: bucketPath(input.namespace, input.name),
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });

/**
 * Assemble the create body, dropping keys the caller left `undefined` so the
 * Hub applies its own defaults instead of receiving explicit nulls.
 *
 * Exported so the request shape can be asserted directly in tests.
 */
export const buildCreateBucketBody = (props: {
  private?: boolean;
  region?: CreateBucketBody["region"];
  cdn?: CreateBucketBody["cdn"];
  resourceGroupId?: string;
}): CreateBucketBody => {
  const body: Record<string, unknown> = {};
  if (props.private !== undefined) body.private = props.private;
  if (props.region !== undefined) body.region = props.region;
  if (props.cdn !== undefined) body.cdn = props.cdn;
  if (props.resourceGroupId !== undefined) {
    body.resourceGroupId = props.resourceGroupId;
  }
  return body as CreateBucketBody;
};
