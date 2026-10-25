import * as Effect from "effect/Effect";
import type { ConfigError, HubError } from "../Errors.ts";
import { HubClient } from "../Http/Client.ts";
import type {
  CreateResourceGroupBody,
  OrganizationMember,
  ResourceGroupDetail,
  ResourceGroupRole,
  ResourceGroupUser,
} from "./Types.ts";
import { validateHubName } from "./Validation.ts";

/**
 * Resource groups (Team and Enterprise plans) and the organization's member
 * list, as plain Effects over {@link HubClient}.
 *
 * A private repo inside a resource group is reachable only by the group's
 * members (and the organization's admins, who manage every group). A member's
 * group role is independent of their organization role, so an org `read`
 * member with group `write` can write the group's repos and nothing else.
 */

const seg = (value: string): string => encodeURIComponent(value);
const groupsPath = (org: string): string => `/api/organizations/${seg(org)}/resource-groups`;

/** List an organization's resource groups. */
export const listResourceGroups = (input: {
  organization: string;
}): Effect.Effect<ReadonlyArray<ResourceGroupDetail>, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    const body = yield* client.json<ReadonlyArray<ResourceGroupDetail>>({ method: "GET", path: groupsPath(input.organization) });
    return Array.isArray(body) ? body : [];
  });

/** Fetch one resource group (its users and repos). */
export const getResourceGroup = (input: {
  organization: string;
  id: string;
}): Effect.Effect<ResourceGroupDetail, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    return yield* client.json<ResourceGroupDetail>({ method: "GET", path: `${groupsPath(input.organization)}/${seg(input.id)}` });
  });

/** The resource group of that name, read in full, or `undefined`. */
export const findResourceGroupByName = (input: {
  organization: string;
  name: string;
}): Effect.Effect<ResourceGroupDetail | undefined, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const all = yield* listResourceGroups(input);
    const hit = all.find((g) => g.name === input.name);
    return hit === undefined ? undefined : yield* getResourceGroup({ organization: input.organization, id: hit.id });
  });

/** Create a resource group; the reply's `id` is re-read with {@link getResourceGroup}. */
export const createResourceGroup = (input: {
  organization: string;
  body: CreateResourceGroupBody;
}): Effect.Effect<ResourceGroupDetail, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    yield* validateHubName(input.organization, "organization");
    const client = yield* HubClient;
    const created = yield* client.json<{ id: string }>({ method: "POST", path: groupsPath(input.organization), body: input.body });
    return yield* getResourceGroup({ organization: input.organization, id: created.id });
  });

/** Update a resource group's name or description. */
export const updateResourceGroup = (input: {
  organization: string;
  id: string;
  body: { name?: string; description?: string };
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({ method: "PATCH", path: `${groupsPath(input.organization)}/${seg(input.id)}`, body: input.body });
  });

/** Turn a group's auto-join on or off (this package's resource keeps it off). */
export const setResourceGroupAutoJoin = (input: {
  organization: string;
  id: string;
  enabled: boolean;
  role?: ResourceGroupRole;
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({
      method: "POST",
      path: `${groupsPath(input.organization)}/${seg(input.id)}/settings`,
      body: { autoJoin: input.role !== undefined ? { enabled: input.enabled, role: input.role } : { enabled: input.enabled } },
    });
  });

/** Add members (who are not yet in the group: adding one twice answers 403). */
export const addResourceGroupUsers = (input: {
  organization: string;
  id: string;
  users: ReadonlyArray<ResourceGroupUser>;
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    if (input.users.length === 0) return;
    const client = yield* HubClient;
    yield* client.request({
      method: "POST",
      path: `${groupsPath(input.organization)}/${seg(input.id)}/users`,
      body: { users: input.users },
    });
  });

/** Change a member's role in the group. */
export const setResourceGroupUserRole = (input: {
  organization: string;
  id: string;
  user: string;
  role: ResourceGroupRole;
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({
      method: "PATCH",
      path: `${groupsPath(input.organization)}/${seg(input.id)}/users/${seg(input.user)}`,
      body: { role: input.role },
    });
  });

/** Remove a member from the group. Absent is treated as removed. */
export const removeResourceGroupUser = (input: {
  organization: string;
  id: string;
  user: string;
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client
      .request({ method: "DELETE", path: `${groupsPath(input.organization)}/${seg(input.id)}/users/${seg(input.user)}` })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });

/** Delete a resource group. Absent is treated as deleted. */
export const deleteResourceGroup = (input: {
  organization: string;
  id: string;
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client
      .request({ method: "DELETE", path: `${groupsPath(input.organization)}/${seg(input.id)}` })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });

/**
 * The changes that make a group's members exactly `desired`: who to add, whose
 * role to change, who to remove. Usernames compare case-insensitively (the Hub
 * treats them so); the desired spelling is kept.
 */
export const planResourceGroupUsers = (
  current: ReadonlyArray<ResourceGroupUser>,
  desired: ReadonlyArray<ResourceGroupUser>,
): { add: ResourceGroupUser[]; change: ResourceGroupUser[]; remove: string[] } => {
  const key = (u: string) => u.toLowerCase();
  const have = new Map(current.map((u) => [key(u.user), u]));
  const want = new Map(desired.map((u) => [key(u.user), u]));
  const add: ResourceGroupUser[] = [];
  const change: ResourceGroupUser[] = [];
  for (const [k, u] of want) {
    const h = have.get(k);
    if (h === undefined) add.push(u);
    else if (h.role !== u.role) change.push({ user: h.user, role: u.role });
  }
  const remove = [...have].filter(([k]) => !want.has(k)).map(([, u]) => u.user);
  return { add, change, remove };
};

/** The `rel="next"` URL of a `Link` header, as a path and its query (only on `endpoint`'s host). */
export const nextPage = (
  link: string | undefined,
  endpoint: string,
): { path: string; searchParams: Record<string, string> } | undefined => {
  const m = link === undefined ? null : /<([^>]+)>;\s*rel="next"/.exec(link);
  if (m?.[1] === undefined) return undefined;
  const url = new URL(m[1], endpoint);
  if (url.host !== new URL(endpoint).host) return undefined;
  return { path: url.pathname, searchParams: Object.fromEntries(url.searchParams) };
};

/**
 * Every member of an organization (`GET /api/organizations/{org}/members`,
 * followed page by page through the `Link` header). `verifiedEmail` is present
 * only for members whose email matches the organization's verified email domain.
 */
export const listOrganizationMembers = (input: {
  organization: string;
}): Effect.Effect<ReadonlyArray<OrganizationMember>, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    const out: OrganizationMember[] = [];
    let req: { path: string; searchParams?: Record<string, string> } | undefined = {
      path: `/api/organizations/${seg(input.organization)}/members`,
    };
    for (let page = 0; req !== undefined && page < 1000; page++) {
      const res = yield* client.request({ method: "GET", ...req });
      if (Array.isArray(res.body)) out.push(...(res.body as OrganizationMember[]));
      req = nextPage(res.link, client.endpoint);
    }
    return out;
  });
