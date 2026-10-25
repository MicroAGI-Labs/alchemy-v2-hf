import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  addResourceGroupUsers,
  createResourceGroup,
  deleteResourceGroup,
  findResourceGroupByName,
  getResourceGroup,
  planResourceGroupUsers,
  removeResourceGroupUser,
  setResourceGroupAutoJoin,
  setResourceGroupUserRole,
  updateResourceGroup,
} from "../Client/ResourceGroups.ts";
import { RESOURCE_GROUP_ROLES, type ResourceGroupDetail, type ResourceGroupUser } from "../Client/Types.ts";
import { ConfigError } from "../Errors.ts";
import type * as HF from "./Providers.ts";

/**
 * A resource group of an organization (Team and Enterprise plans): the repos
 * placed in it (`HuggingFace.Repo`'s `resourceGroupId`) are reachable only by
 * its members, each with a group role, and by the organization's admins.
 *
 * `members` is the **complete** list: a deploy adds who is missing, changes
 * roles that differ and removes everyone else, so the group's membership is
 * exactly what the stack computes (e.g. from the organization's members with a
 * verified email of one domain). Auto-join is kept off: it would add members
 * the stack did not choose.
 */
export type ResourceGroupProps = {
  /** Identity: replaces on change. */
  organization: string;
  /** The group's name, unique in the organization. Renaming is synced in place. */
  name: string;
  description?: string;
  /** every member and their role (usernames; a service account's `user` too) */
  members: ReadonlyArray<ResourceGroupUser>;
};

export type ResourceGroup = Resource<
  "HuggingFace.ResourceGroup",
  ResourceGroupProps,
  {
    /** the 24-hex id: what `Repo.resourceGroupId` takes */
    resourceGroupId: string;
    organization: string;
    name: string;
    /** the members as observed after the deploy */
    members: ReadonlyArray<ResourceGroupUser>;
  },
  never,
  HF.Providers
>;

export const ResourceGroup = Resource<ResourceGroup>("HuggingFace.ResourceGroup");

/** Only the organization is identity; name, description and members are synced. */
export const diffResourceGroupProps = (olds: ResourceGroupProps, news: ResourceGroupProps): { action: "replace" } | undefined =>
  olds.organization !== news.organization ? { action: "replace" } : undefined;

/** Members whose role is not one the API takes, or who are listed twice. */
export const memberProblems = (members: ReadonlyArray<ResourceGroupUser>): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (!RESOURCE_GROUP_ROLES.includes(m.role)) problems.push(`member ${m.user}: role ${m.role} is not one of ${RESOURCE_GROUP_ROLES.join(", ")}`);
    const k = m.user.toLowerCase();
    if (seen.has(k)) problems.push(`member ${m.user} is listed twice`);
    seen.add(k);
  }
  return problems;
};

const users = (g: ResourceGroupDetail): ResourceGroupUser[] => (g.users ?? []).map((u) => ({ user: u.user, role: u.role }));

const toAttributes = (organization: string, g: ResourceGroupDetail): ResourceGroup["Attributes"] => ({
  resourceGroupId: g.id,
  organization,
  name: g.name,
  members: users(g),
});

/** @internal the reconciler, hoisted so tests can drive it against a stubbed `HubClient` */
export const resourceGroupService = {
  nuke: { skip: true },
  stables: ["resourceGroupId", "organization"] satisfies Array<keyof ResourceGroup["Attributes"]>,
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* ({ news, olds }) {
    if (!isResolved(news)) return undefined;
    if (!olds) return undefined;
    return diffResourceGroupProps(olds, news);
  }),
  reconcile: Effect.fn(function* ({ news, olds, output }) {
    const problems = memberProblems(news.members);
    if (problems.length) return yield* Effect.fail(new ConfigError({ message: problems.join("; ") }));
    const org = news.organization;
    // 1. Observe: by the id in state (a rename keeps the group), else by name
    let observed: ResourceGroupDetail | undefined;
    if (output?.resourceGroupId) {
      observed = yield* getResourceGroup({ organization: org, id: output.resourceGroupId }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined as ResourceGroupDetail | undefined)),
      );
    }
    observed ??= yield* findResourceGroupByName({ organization: org, name: olds?.name ?? news.name });
    // 2. Create with its members and auto-join off
    if (!observed) {
      observed = yield* createResourceGroup({
        organization: org,
        body: {
          name: news.name,
          ...(news.description !== undefined ? { description: news.description } : {}),
          users: news.members,
          autoJoin: { enabled: false },
        },
      });
    }
    const id = observed.id;
    // 3. Name and description
    if (observed.name !== news.name || (news.description !== undefined && observed.description !== news.description)) {
      yield* updateResourceGroup({
        organization: org,
        id,
        body: { name: news.name, ...(news.description !== undefined ? { description: news.description } : {}) },
      });
    }
    // 4. Auto-join stays off
    if (observed.autoJoin?.enabled === true) yield* setResourceGroupAutoJoin({ organization: org, id, enabled: false });
    // 5. Members: exactly the stack's
    const plan = planResourceGroupUsers(users(observed), news.members);
    yield* addResourceGroupUsers({ organization: org, id, users: plan.add });
    for (const c of plan.change) yield* setResourceGroupUserRole({ organization: org, id, user: c.user, role: c.role });
    for (const u of plan.remove) yield* removeResourceGroupUser({ organization: org, id, user: u });
    const final = yield* getResourceGroup({ organization: org, id });
    return toAttributes(org, final);
  }),
  delete: Effect.fn(function* ({ olds, output }) {
    yield* deleteResourceGroup({ organization: output.organization ?? olds.organization, id: output.resourceGroupId });
  }),
  read: Effect.fn(function* ({ olds, output }) {
    const org = output?.organization ?? olds?.organization;
    if (!org) return undefined;
    const observed = output?.resourceGroupId
      ? yield* getResourceGroup({ organization: org, id: output.resourceGroupId }).pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined as ResourceGroupDetail | undefined)),
        )
      : olds?.name
        ? yield* findResourceGroupByName({ organization: org, name: olds.name })
        : undefined;
    if (!observed) return undefined;
    const attrs = toAttributes(org, observed);
    return output?.resourceGroupId === observed.id ? attrs : Unowned(attrs);
  }),
};

export const ResourceGroupProvider = () => Provider.succeed(ResourceGroup, resourceGroupService);
