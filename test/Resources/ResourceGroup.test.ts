import { describe, expect, test } from "bun:test";
import { diffResourceGroupProps, memberProblems, type ResourceGroupProps, resourceGroupService } from "../../src/Resources/ResourceGroup.ts";
import { stubHub } from "../support.ts";
import { drive, driveFailure } from "./lifecycle.ts";

const ORG = "MicroAGI-Labs";
const RG = "6a6f8f4083f1c297d4dbb0d8";
const base: ResourceGroupProps = {
  organization: ORG,
  name: "eh-registry-approvers",
  description: "who may approve",
  members: [
    { user: "alice", role: "write" },
    { user: "robot-sa", role: "read" },
  ],
};
const groups = `/api/organizations/${ORG}/resource-groups`;

describe("ResourceGroup props", () => {
  test("only the organization replaces", () => {
    expect(diffResourceGroupProps(base, { ...base, organization: "x" })).toEqual({ action: "replace" });
    expect(diffResourceGroupProps(base, { ...base, name: "y", members: [] })).toBeUndefined();
  });
  test("a bad role or a member twice is refused", () => {
    expect(memberProblems([{ user: "a", role: "owner" as never }, { user: "A", role: "read" }, { user: "a", role: "read" }]).join(" ")).toMatch(
      /role owner is not one of .* listed twice/,
    );
  });
});

describe("ResourceGroup reconcile", () => {
  test("absent: created with its members and auto-join off", async () => {
    const { layer, calls } = stubHub((req) => {
      if (req.method === "GET" && req.path === groups) return { body: [] };
      if (req.method === "POST" && req.path === groups) return { body: { id: RG } };
      return { body: { id: RG, name: base.name, description: base.description, users: base.members, autoJoin: { enabled: false } } };
    });
    const out = await drive(resourceGroupService.reconcile, { news: base }, layer);
    expect(out).toMatchObject({ resourceGroupId: RG, members: base.members });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: base.name, description: base.description, users: base.members, autoJoin: { enabled: false } });
    expect(calls.filter((c) => c.method === "PATCH" || c.method === "DELETE")).toEqual([]);
  });

  test("existing: members made exactly the stack's, auto-join turned off, renamed", async () => {
    const observed = {
      id: RG,
      name: "old-name",
      description: base.description,
      users: [
        { user: "alice", role: "read" },
        { user: "mallory", role: "write" },
      ],
      autoJoin: { enabled: true, role: "read" },
    };
    const { layer, calls } = stubHub((req) => (req.path === groups ? { body: [{ id: RG, name: "old-name" }] } : req.method === "GET" ? { body: observed } : { body: {} }));
    await drive(resourceGroupService.reconcile, { news: base, olds: { ...base, name: "old-name" }, output: { resourceGroupId: RG } }, layer);
    const writes = calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path.replace(groups, ""), c.body]);
    expect(writes).toEqual([
      ["PATCH", `/${RG}`, { name: base.name, description: base.description }],
      ["POST", `/${RG}/settings`, { autoJoin: { enabled: false } }],
      ["POST", `/${RG}/users`, { users: [{ user: "robot-sa", role: "read" }] }],
      ["PATCH", `/${RG}/users/alice`, { role: "write" }],
      ["DELETE", `/${RG}/users/mallory`, undefined],
    ]);
  });

  test("a bad member list fails before any call", async () => {
    const { layer, calls } = stubHub(() => ({ body: {} }));
    const e = await driveFailure(resourceGroupService.reconcile, { news: { ...base, members: [{ user: "a", role: "boss" }] } }, layer);
    expect(e).toMatchObject({ _tag: "ConfigError" });
    expect(calls).toEqual([]);
  });

  test("read and delete", async () => {
    const { layer } = stubHub(() => ({ body: { id: RG, name: base.name, users: [] } }));
    expect(await drive(resourceGroupService.read, { olds: base, output: { resourceGroupId: RG, organization: ORG } }, layer)).toMatchObject({ resourceGroupId: RG });
    expect(await drive(resourceGroupService.read, { olds: undefined, output: undefined }, layer)).toBeUndefined();
    const { layer: d, calls } = stubHub(() => ({ body: {} }));
    await drive(resourceGroupService.delete, { olds: base, output: { resourceGroupId: RG, organization: ORG } }, d);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: `${groups}/${RG}` });
  });
});
