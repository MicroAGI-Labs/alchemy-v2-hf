import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { createRepo, deleteRepo, findRepo, setRepoResourceGroup } from "../Client/Repos.ts";
import type { RepoDetail, RepoType } from "../Client/Types.ts";
import { ConfigError } from "../Errors.ts";
import type * as HF from "./Providers.ts";

/**
 * A Hugging Face Hub repository (a model, a dataset or a space) under an
 * organization or user namespace.
 *
 * **Visibility is set at creation and never changed.** `private` is the
 * visibility a new repo is created with; for an existing repo it is an
 * assertion: a repo whose observed visibility differs fails the deploy with a
 * `ConfigError` instead of being flipped (nothing in this package sends
 * `private` or `visibility` to a settings endpoint). Leave `private` unset to
 * manage a repo whatever its visibility.
 *
 * @example A private dataset in a resource group, scoped into a token
 * ```typescript
 * const registry = yield* HF.Repo("Registry", {
 *   type: "dataset",
 *   namespace: "MicroAGI-Labs",
 *   name: "eh-registry",
 *   private: true,
 *   resourceGroupId: approvers.resourceGroupId,
 * }).pipe(RemovalPolicy.retain());
 *
 * yield* HF.ServiceAccountToken("RobotToken", {
 *   ...,
 *   repoIds: [registry.repoId],          // NOT registry.fullName
 *   repoPermissions: ["repo.content.read"],
 * });
 * ```
 */
export type RepoProps = {
  /** `model`, `dataset` or `space`. Identity: replaces on change. */
  type: RepoType;
  /** Owning organization or user. Identity: replaces on change. */
  namespace: string;
  /** Repo name. Identity: replaces on change. */
  name: string;
  /**
   * The visibility to create the repo with, and to assert on an existing one
   * (a mismatch fails; it is never changed). Unset: the Hub's default at
   * creation, not asserted afterwards.
   */
  private?: boolean;
  /** Resource group to place the repo in. Mutable; clearing it takes the repo out. */
  resourceGroupId?: string;
  /** spaces only: the SDK at creation */
  sdk?: string;
};

export type Repo = Resource<
  "HuggingFace.Repo",
  RepoProps,
  {
    /** The 24-hex repo `_id`: the value a `ServiceAccountToken`'s `repoIds` takes. */
    repoId: string;
    /** `namespace/name` */
    fullName: string;
    type: RepoType;
    namespace: string;
    name: string;
    /** the observed visibility */
    private: boolean;
    url: string;
  },
  never,
  HF.Providers
>;

export const Repo = Resource<Repo>("HuggingFace.Repo");

const webPath = (type: RepoType): string => (type === "model" ? "" : `${type}s/`);

const toAttributes = (props: Pick<RepoProps, "type" | "namespace" | "name">, repo: RepoDetail): Repo["Attributes"] => ({
  repoId: repo._id,
  fullName: repo.id ?? `${props.namespace}/${props.name}`,
  type: props.type,
  namespace: props.namespace,
  name: props.name,
  private: repo.private ?? false,
  url: `https://huggingface.co/${webPath(props.type)}${props.namespace}/${props.name}`,
});

/** Identity (`type`, `namespace`, `name`) replaces; everything else is synced in place. */
export const diffRepoProps = (olds: RepoProps, news: RepoProps): { action: "replace" } | undefined =>
  olds.type !== news.type || olds.namespace !== news.namespace || olds.name !== news.name ? { action: "replace" } : undefined;

/** Why an observed repo's visibility refuses the deploy (undefined: it does not). */
export const visibilityProblem = (desired: RepoProps, observed: RepoDetail): string | undefined =>
  desired.private === undefined || (observed.private ?? false) === desired.private
    ? undefined
    : `${desired.type} ${desired.namespace}/${desired.name} is ${observed.private ? "private" : "public"}, the stack says ${desired.private ? "private" : "public"}: visibility is never changed by this provider; change it on the Hub by hand if that is really intended, or fix the stack`;

/** @internal the reconciler, hoisted so tests can drive it against a stubbed `HubClient` */
export const repoService = {
  nuke: { skip: true },
  stables: ["repoId", "fullName", "type", "namespace", "name"] satisfies Array<keyof Repo["Attributes"]>,
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* ({ news, olds }) {
    if (!isResolved(news)) return undefined;
    if (!olds) return undefined;
    return diffRepoProps(olds, news);
  }),
  reconcile: Effect.fn(function* ({ news }) {
    const ref = { type: news.type, namespace: news.namespace, name: news.name };
    // 1. Observe; 2. create when absent (a 409 is adoption), with the visibility asked for
    let observed = yield* findRepo(ref);
    if (!observed) {
      const created = yield* createRepo({
        ...ref,
        ...(news.private !== undefined ? { private: news.private } : {}),
        ...(news.resourceGroupId !== undefined ? { resourceGroupId: news.resourceGroupId } : {}),
        ...(news.sdk !== undefined ? { sdk: news.sdk } : {}),
      });
      observed = created.repo;
    }
    // 3. Visibility is asserted, never changed
    const problem = visibilityProblem(news, observed);
    if (problem !== undefined) return yield* Effect.fail(new ConfigError({ message: problem }));
    // 4. The resource group, against the observed one
    const current = observed.resourceGroup?.id ?? null;
    const desired = news.resourceGroupId ?? null;
    if (current !== desired) yield* setRepoResourceGroup({ ...ref, resourceGroupId: desired });
    const final = (yield* findRepo(ref)) ?? observed;
    return toAttributes(news, final);
  }),
  delete: Effect.fn(function* ({ olds, output }) {
    // A Forbidden is not absorbed: it would report the repo destroyed while it and its data remain.
    yield* deleteRepo({ type: output.type ?? olds.type, namespace: output.namespace ?? olds.namespace, name: output.name ?? olds.name });
  }),
  read: Effect.fn(function* ({ olds, output }) {
    const type = output?.type ?? olds?.type;
    const namespace = output?.namespace ?? olds?.namespace;
    const name = output?.name ?? olds?.name;
    if (!type || !namespace || !name) return undefined;
    const observed = yield* findRepo({ type, namespace, name });
    if (!observed) return undefined;
    const attrs = toAttributes({ type, namespace, name }, observed);
    return output?.repoId && output.repoId === observed._id ? attrs : Unowned(attrs);
  }),
};

export const RepoProvider = () => Provider.succeed(Repo, repoService);
