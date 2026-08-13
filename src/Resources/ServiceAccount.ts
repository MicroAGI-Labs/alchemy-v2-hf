import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  createServiceAccount,
  deleteServiceAccount,
  findServiceAccountByName,
  getServiceAccount,
  listServiceAccounts,
  normalizeCreated,
} from "../Client/ServiceAccounts.ts";
import type { ServiceAccountSummary } from "../Client/Types.ts";
import { ConfigError } from "../Errors.ts";
import type * as HF from "./Providers.ts";

/**
 * A Hugging Face organization service account — a machine identity that owns
 * tokens, separate from any human member of the org.
 *
 * Requires an **Enterprise** organization; the Hub answers `403` on other
 * plans. The admin token driving the provider needs
 * `org.serviceAccounts.write`.
 *
 * @section Creating a ServiceAccount
 * @example A service account for a training cluster
 * ```typescript
 * const trainer = yield* HF.ServiceAccount("Trainer", {
 *   organization: "MicroAGI-Labs",
 *   name: "research-trainer",
 *   description: "Pulls weights and writes eval outputs",
 * });
 * ```
 */
export type ServiceAccountProps = {
  /**
   * Organization the account belongs to (the org's Hub name, e.g.
   * `MicroAGI-Labs`). Identity — changing it replaces the resource.
   */
  organization: string;
  /**
   * Account name, unique within the organization. **Immutable** — the Hub
   * exposes no update endpoint for service accounts, so a change replaces.
   */
  name: string;
  /**
   * Free-text description. **Immutable** for the same reason as `name`; a
   * change replaces the account (and therefore every token on it).
   */
  description?: string;
};

export type ServiceAccount = Resource<
  "HuggingFace.ServiceAccount",
  ServiceAccountProps,
  {
    /** Server-assigned id (the Hub's `_id`). Pass to `ServiceAccountToken`. */
    id: string;
    /** Organization the account belongs to. */
    organization: string;
    /** Account name. */
    name: string;
  },
  never,
  HF.Providers
>;

export const ServiceAccount = Resource<ServiceAccount>(
  "HuggingFace.ServiceAccount",
);

const toAttributes = (
  organization: string,
  account: ServiceAccountSummary,
): ServiceAccount["Attributes"] => ({
  id: account._id,
  organization,
  name: account.name,
});

/**
 * Decide replace-vs-update from props alone.
 *
 * Split out as a pure function so the decision is unit-testable without an
 * engine, mirroring `diffClusterProps` in the GCP provider. **Every** prop is
 * identity or immutable here — there is no update endpoint for service
 * accounts — so any change replaces.
 */
export const diffServiceAccountProps = (
  olds: ServiceAccountProps,
  news: ServiceAccountProps,
): { action: "replace" } | undefined =>
  olds.organization !== news.organization ||
  olds.name !== news.name ||
  olds.description !== news.description
    ? { action: "replace" }
    : undefined;

/**
 * The reconciler itself, hoisted out of {@link ServiceAccountProvider} so unit
 * tests can drive the lifecycle handlers directly against a stubbed
 * `HubClient` with no engine in the loop.
 *
 * @internal
 */
export const serviceAccountService = {
  nuke: { skip: true },
  stables: ["id"] satisfies Array<keyof ServiceAccount["Attributes"]>,
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* ({ news, olds }) {
    if (!isResolved(news)) return undefined;
    if (!olds) return undefined;
    return diffServiceAccountProps(olds, news);
  }),
  reconcile: Effect.fn(function* ({ news, output }) {
    // 1. Observe. The id in state is a cache, not proof of existence, so
    //    it is verified with a GET; a miss falls back to a name scan,
    //    which is also the cold-recovery path after state loss.
    let observed: ServiceAccountSummary | undefined;
    if (output?.id) {
      observed = yield* getServiceAccount({
        organization: news.organization,
        serviceAccountId: output.id,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );
    }
    if (!observed) {
      observed = yield* findServiceAccountByName({
        organization: news.organization,
        name: news.name,
      });
    }

    // 2. Ensure. A create that loses a race with a peer reconciler comes
    //    back 409; re-scan by name rather than failing.
    if (!observed) {
      observed = yield* createServiceAccount({
        organization: news.organization,
        body: {
          name: news.name,
          ...(news.description !== undefined
            ? { description: news.description }
            : {}),
        },
      }).pipe(
        Effect.map(normalizeCreated),
        Effect.catchTag("Conflict", () =>
          findServiceAccountByName({
            organization: news.organization,
            name: news.name,
          }),
        ),
      );

      if (!observed) {
        return yield* Effect.fail(
          new ConfigError({
            message:
              `Service account ${news.name} in ${news.organization} was reported as already ` +
              `existing but did not appear in the organization's service-account list. ` +
              `It may belong to a resource group this token cannot see.`,
          }),
        );
      }
    }

    // 3. Sync. Nothing to do — the Hub has no update endpoint, and `diff`
    //    has already turned any prop change into a replacement.
    return toAttributes(news.organization, observed);
  }),
  delete: Effect.fn(function* ({ output, olds }) {
    yield* deleteServiceAccount({
      organization: output.organization ?? olds.organization,
      serviceAccountId: output.id,
    }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.catchTag("Forbidden", () => Effect.void),
    );
  }),
  read: Effect.fn(function* ({ output, olds }) {
    const organization = output?.organization ?? olds?.organization;
    const name = output?.name ?? olds?.name;
    if (!organization) return undefined;

    // Prefer the id from state: a hit proves this is the same account we
    // created, so it is owned outright.
    if (output?.id) {
      const byId = yield* getServiceAccount({
        organization,
        serviceAccountId: output.id,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );
      if (byId) {
        return toAttributes(organization, {
          _id: byId._id,
          user: byId.user,
          name: byId.name,
          description: byId.description,
          createdAt: byId.createdAt,
        });
      }
    }

    if (!name) return undefined;
    const accounts = yield* listServiceAccounts({ organization });
    const match = accounts.find((account) => account.name === name);
    if (!match) return undefined;

    // Found by name with no matching id in state. Service accounts carry
    // no label, tag, or marker channel — the `description` is a
    // user-visible, immutable prop, so stamping ownership into it is not
    // available the way it is for GCP Networks. Ownership therefore
    // cannot be proven, and the account is reported Unowned: the engine
    // fails unless the operator passes --adopt.
    return Unowned(toAttributes(organization, match));
  }),
};

export const ServiceAccountProvider = () =>
  Provider.succeed(ServiceAccount, serviceAccountService);
