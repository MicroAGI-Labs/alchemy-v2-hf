import { describe, expect, test } from "bun:test";
import {
  addResourceGroupUsers,
  createResourceGroup,
  deleteResourceGroup,
  findResourceGroupByName,
  listOrganizationMembers,
  nextPage,
  planResourceGroupUsers,
  removeResourceGroupUser,
  setResourceGroupAutoJoin,
  setResourceGroupUserRole,
  updateResourceGroup,
} from "../../src/Client/ResourceGroups.ts";
import { runStub, stubHub, stubHttp } from "../support.ts";

const ORG = "MicroAGI-Labs";
const RG = "6a6f8f4083f1c297d4dbb0d8";
const base = `/api/organizations/${ORG}/resource-groups`;

describe("planResourceGroupUsers", () => {
  test("add the missing, change differing roles, remove the rest; usernames case-insensitive", () => {
    const plan = planResourceGroupUsers(
      [
        { user: "Alice", role: "read" },
        { user: "bob", role: "write" },
        { user: "mallory", role: "write" },
      ],
      [
        { user: "alice", role: "write" },
        { user: "bob", role: "write" },
        { user: "carol", role: "write" },
      ],
    );
    expect(plan).toEqual({ add: [{ user: "carol", role: "write" }], change: [{ user: "Alice", role: "write" }], remove: ["mallory"] });
  });
  test("no change: nothing to do", () => {
    expect(planResourceGroupUsers([{ user: "a", role: "write" }], [{ user: "a", role: "write" }])).toEqual({ add: [], change: [], remove: [] });
  });
});

describe("resource group operations", () => {
  test("find by name reads the group in full; absent is undefined", async () => {
    const { layer, calls } = stubHub((req) =>
      req.path === base ? { body: [{ id: RG, name: "eh-registry-approvers" }] } : { body: { id: RG, name: "eh-registry-approvers", users: [{ user: "a", role: "write" }] } },
    );
    const g = await runStub(findResourceGroupByName({ organization: ORG, name: "eh-registry-approvers" }), layer);
    expect(g?.users).toEqual([{ user: "a", role: "write" }]);
    expect(calls[1]?.path).toBe(`${base}/${RG}`);
    const { layer: none } = stubHub(() => ({ body: [] }));
    expect(await runStub(findResourceGroupByName({ organization: ORG, name: "x" }), none)).toBeUndefined();
  });

  test("create posts the body and re-reads by id; the member, settings and delete calls", async () => {
    const { layer, calls } = stubHub((req) => (req.method === "POST" && req.path === base ? { body: { id: RG } } : { body: { id: RG, name: "g" } }));
    await runStub(createResourceGroup({ organization: ORG, body: { name: "g", users: [{ user: "a", role: "write" }], autoJoin: { enabled: false } } }), layer);
    await runStub(updateResourceGroup({ organization: ORG, id: RG, body: { description: "d" } }), layer);
    await runStub(setResourceGroupAutoJoin({ organization: ORG, id: RG, enabled: false }), layer);
    await runStub(setResourceGroupAutoJoin({ organization: ORG, id: RG, enabled: true, role: "read" }), layer);
    await runStub(addResourceGroupUsers({ organization: ORG, id: RG, users: [] }), layer);
    await runStub(addResourceGroupUsers({ organization: ORG, id: RG, users: [{ user: "b", role: "read" }] }), layer);
    await runStub(setResourceGroupUserRole({ organization: ORG, id: RG, user: "b", role: "write" }), layer);
    await runStub(removeResourceGroupUser({ organization: ORG, id: RG, user: "b" }), layer);
    await runStub(deleteResourceGroup({ organization: ORG, id: RG }), layer);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${base}`,
      `GET ${base}/${RG}`,
      `PATCH ${base}/${RG}`,
      `POST ${base}/${RG}/settings`,
      `POST ${base}/${RG}/settings`,
      `POST ${base}/${RG}/users`,
      `PATCH ${base}/${RG}/users/b`,
      `DELETE ${base}/${RG}/users/b`,
      `DELETE ${base}/${RG}`,
    ]);
    expect(calls[3]?.body).toEqual({ autoJoin: { enabled: false } });
    expect(calls[4]?.body).toEqual({ autoJoin: { enabled: true, role: "read" } });
    expect(calls[5]?.body).toEqual({ users: [{ user: "b", role: "read" }] });
  });

  test("removing an absent member or group is done", async () => {
    const { layer } = stubHub(() => ({ status: 404, body: {} }));
    await runStub(removeResourceGroupUser({ organization: ORG, id: RG, user: "x" }), layer);
    await runStub(deleteResourceGroup({ organization: ORG, id: RG }), layer);
  });
});

describe("organization members", () => {
  test("nextPage: the rel=next URL on the Hub's host only", () => {
    expect(nextPage('<https://huggingface.co/api/organizations/o/members?cursor=abc&limit=2>; rel="next"', "https://huggingface.co")).toEqual({
      path: "/api/organizations/o/members",
      searchParams: { cursor: "abc", limit: "2" },
    });
    expect(nextPage('<https://evil.example/x>; rel="next"', "https://huggingface.co")).toBeUndefined();
    expect(nextPage(undefined, "https://huggingface.co")).toBeUndefined();
  });

  test("every page is followed through the Link header", async () => {
    const { layer, calls } = stubHub((_req, i) =>
      i === 0
        ? { body: [{ user: "a", verifiedEmail: "a@micro-agi.com" }], link: '<https://huggingface.co/api/organizations/MicroAGI-Labs/members?cursor=c1>; rel="next"' }
        : { body: [{ user: "b", verifiedEmail: null }] },
    );
    const members = await runStub(listOrganizationMembers({ organization: ORG }), layer);
    expect(members.map((m) => m.user)).toEqual(["a", "b"]);
    expect(calls[1]).toMatchObject({ path: "/api/organizations/MicroAGI-Labs/members", searchParams: { cursor: "c1" } });
  });

  test("the real client carries the Link header", async () => {
    const { layer } = stubHttp((_c, i) =>
      i === 0
        ? { status: 200, body: JSON.stringify([{ user: "a" }]), link: '<https://huggingface.co/api/organizations/MicroAGI-Labs/members?cursor=z>; rel="next"' }
        : { status: 200, body: JSON.stringify([{ user: "b" }]) },
    );
    const members = await runStub(listOrganizationMembers({ organization: ORG }), layer);
    expect(members.map((m) => m.user)).toEqual(["a", "b"]);
  });
});
