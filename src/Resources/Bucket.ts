import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  buildCreateBucketBody,
  createBucket,
  deleteBucket,
  findBucket,
  setBucketResourceGroup,
  updateBucketSettings,
} from "../Client/Buckets.ts";
import type {
  BucketCdn,
  BucketDetail,
  BucketRegion,
} from "../Client/Types.ts";
import type * as HF from "./Providers.ts";

/**
 * A Hugging Face Hub bucket — object storage under a user or organization
 * namespace, addressed as `namespace/name`.
 *
 * Buckets are repo type `bucket` and are **not** creatable through
 * `POST /api/repos/create`; they have their own `/api/buckets` endpoints,
 * which is why this resource exists separately from any repo resource.
 *
 * @section Creating a Bucket
 * @example A private EU bucket, scoped into a token
 * ```typescript
 * const datasets = yield* HF.Bucket("Datasets", {
 *   namespace: "MicroAGI-Labs",
 *   name: "datasets",
 *   private: true,
 *   region: "eu",
 * });
 *
 * yield* HF.ServiceAccountToken("ReaderToken", {
 *   organization: "MicroAGI-Labs",
 *   serviceAccountId: reader.id,
 *   displayName: "datasets-reader",
 *   repoIds: [datasets.bucketId],        // NOT datasets.fullName
 *   repoPermissions: ["repo.content.read"],
 * });
 * ```
 */
export type BucketProps = {
  /** Owning user or organization. Identity — replaces on change. */
  namespace: string;
  /** Bucket name, unique within the namespace. Identity — replaces. */
  name: string;
  /** Whether the bucket is private. Mutable via the settings endpoint. */
  private?: boolean;
  /**
   * Storage region. **Immutable** — data cannot be moved between regions, so
   * a change replaces the bucket (and destroys its contents).
   */
  region?: BucketRegion;
  /** CDN attachments. Mutable via the settings endpoint. */
  cdn?: ReadonlyArray<BucketCdn>;
  /**
   * Resource group to place the bucket in. Mutable; clearing the prop
   * detaches the bucket from its resource group.
   */
  resourceGroupId?: string;
};

export type Bucket = Resource<
  "HuggingFace.Bucket",
  BucketProps,
  {
    /**
     * The 24-hex repo `_id`, e.g. `6a6f8f4083f1c297d4dbb0d7`. **This is the
     * value to pass in a `ServiceAccountToken`'s `repoIds`** — the
     * `namespace/name` form is rejected there.
     */
    bucketId: string;
    /**
     * The `namespace/name` string, e.g. `MicroAGI-Labs/datasets`. This is
     * what the Hub confusingly returns in the `id` field of
     * `GET /api/buckets/{namespace}/{name}`. Not usable in `repoIds`.
     */
    fullName: string;
    /** Owning namespace. */
    namespace: string;
    /** Bucket name. */
    name: string;
    /** Hub URL for the bucket. */
    url: string;
  },
  never,
  HF.Providers
>;

export const Bucket = Resource<Bucket>("HuggingFace.Bucket");

const toAttributes = (
  namespace: string,
  name: string,
  bucket: BucketDetail,
): Bucket["Attributes"] => ({
  bucketId: bucket._id,
  fullName: bucket.id ?? `${namespace}/${name}`,
  namespace,
  name,
  url: bucket.url ?? `https://huggingface.co/buckets/${namespace}/${name}`,
});

/**
 * Replace-vs-update decision from props alone. Identity (`namespace`,
 * `name`) and `region` are immutable; `private`, `cdn` and
 * `resourceGroupId` are synced in place.
 *
 * A `region` left unset in `news` is not treated as a change — the prop then
 * says "whatever it already is", and the Hub's choice stands. But going from
 * unset to set *is* a change: the bucket may well have been placed in `us`,
 * and `updateBucketSettings` cannot move it, so anything short of a replace
 * would report success while the data stayed in the wrong jurisdiction.
 */
export const diffBucketProps = (
  olds: BucketProps,
  news: BucketProps,
): { action: "replace" } | undefined =>
  olds.namespace !== news.namespace ||
  olds.name !== news.name ||
  (news.region !== undefined && news.region !== olds.region)
    ? { action: "replace" }
    : undefined;

/** Order-insensitive comparison of two CDN lists. @internal */
const sameCdn = (
  a: ReadonlyArray<BucketCdn> | undefined,
  b: ReadonlyArray<BucketCdn> | undefined,
): boolean => {
  const key = (c: BucketCdn) => `${c.provider}:${c.region}`;
  const left = [...(a ?? [])].map(key).sort();
  const right = [...(b ?? [])].map(key).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/**
 * True when the desired mutable settings already match the observed bucket,
 * so the settings `PUT` can be skipped.
 */
export const bucketSettingsMatch = (
  desired: Pick<BucketProps, "private" | "cdn">,
  observed: BucketDetail,
): boolean =>
  (desired.private === undefined ||
    desired.private === (observed.private ?? false)) &&
  (desired.cdn === undefined || sameCdn(desired.cdn, observed.cdnRegions));

/**
 * The reconciler itself, hoisted out of {@link BucketProvider} so unit tests
 * can drive the lifecycle handlers directly against a stubbed `HubClient`.
 *
 * @internal
 */
export const bucketService = {
  nuke: { skip: true },
  stables: ["bucketId", "fullName", "namespace", "name"] satisfies Array<
    keyof Bucket["Attributes"]
  >,
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* ({ news, olds }) {
    if (!isResolved(news)) return undefined;
    if (!olds) return undefined;
    return diffBucketProps(olds, news);
  }),
  reconcile: Effect.fn(function* ({ news, output }) {
    // 1. Observe. Cloud state is authoritative; state is only a hint.
    let observed = yield* findBucket({
      namespace: news.namespace,
      name: news.name,
    });

    // 2. Ensure. `createBucket` treats the duplicate-create 409 as
    //    adoption and, either way, re-GETs the bucket so `_id` comes from
    //    the one endpoint known to return the 24-hex repo id.
    if (!observed) {
      const created = yield* createBucket({
        namespace: news.namespace,
        name: news.name,
        body: buildCreateBucketBody(news),
      });
      observed = created.bucket;
    }

    // 3. Sync mutable settings against OBSERVED state, so an out-of-band
    //    change converges and a no-op deploy issues no writes.
    //    Both fields are sent deliberately, even when only one differs: the
    //    endpoint is a `PUT`, and whether it merges or replaces is
    //    unconfirmed. Under replace semantics, omitting `private` while
    //    changing `cdn` would silently revert a private bucket to the Hub
    //    default — public. An unset prop falls back to the observed value, so
    //    "leave as is" still means leave as is.
    if (!bucketSettingsMatch(news, observed)) {
      yield* updateBucketSettings({
        namespace: news.namespace,
        name: news.name,
        body: {
          private: news.private ?? observed.private ?? false,
          cdnRegions: news.cdn ?? observed.cdnRegions ?? [],
        },
      });
    }

    // 4. Sync the resource group. `null` detaches, which is what an
    //    omitted prop means once the bucket has one attached.
    const currentResourceGroup = observed.resourceGroup?.id;
    const desiredResourceGroup = news.resourceGroupId ?? null;
    if ((currentResourceGroup ?? null) !== desiredResourceGroup) {
      yield* setBucketResourceGroup({
        namespace: news.namespace,
        name: news.name,
        resourceGroupId: desiredResourceGroup,
      });
    }

    // 5. Re-read so the returned attributes reflect the syncs above.
    const final =
      (yield* findBucket({
        namespace: news.namespace,
        name: news.name,
      })) ?? observed;
    return toAttributes(news.namespace, news.name, final);
  }),
  delete: Effect.fn(function* ({ olds, output }) {
    // `deleteBucket` already absorbs `NotFound` — an absent bucket is a
    // finished teardown. A `Forbidden` is deliberately NOT absorbed: it would
    // report the bucket destroyed while the bucket and all its data remain,
    // and drop the only state pointing at it.
    yield* deleteBucket({
      namespace: output.namespace ?? olds.namespace,
      name: output.name ?? olds.name,
    });
  }),
  read: Effect.fn(function* ({ olds, output }) {
    const namespace = output?.namespace ?? olds?.namespace;
    const name = output?.name ?? olds?.name;
    if (!namespace || !name) return undefined;

    const observed = yield* findBucket({ namespace, name });
    if (!observed) return undefined;

    const attrs = toAttributes(namespace, name, observed);

    // Buckets carry no label, tag, or description channel to stamp
    // ownership into, so the only proof available is the id already in
    // state. Anything else is reported Unowned and needs --adopt.
    return output?.bucketId && output.bucketId === observed._id
      ? attrs
      : Unowned(attrs);
  }),
};

export const BucketProvider = () =>
  Provider.succeed(Bucket, bucketService);
