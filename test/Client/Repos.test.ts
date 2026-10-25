import { describe, expect, test } from "bun:test";
import { buildCreateRepoBody, createRepo, deleteRepo, findRepo, getRepo, setRepoResourceGroup } from "../../src/Client/Repos.ts";
import { runStub, stubHub } from "../support.ts";

const NS = "MicroAGI-Labs";
const HEX = "6a6f8f4083f1c297d4dbb0d7";
const detail = (o: Record<string, unknown> = {}) => ({ _id: HEX, id: `${NS}/eh-registry`, private: true, resourceGroup: null, ...o });
const ref = { type: "dataset" as const, namespace: NS, name: "eh-registry" };

describe("buildCreateRepoBody", () => {
  test("a dataset: type, name, organization, and only the keys given", () => {
    expect(buildCreateRepoBody({ ...ref, private: true })).toEqual({ type: "dataset", name: "eh-registry", organization: NS, private: true });
    expect(buildCreateRepoBody({ ...ref, resourceGroupId: "rg" })).toEqual({ type: "dataset", name: "eh-registry", organization: NS, resourceGroupId: "rg" });
  });
  test("a model sends no type (the Hub's default)", () => {
    expect(buildCreateRepoBody({ type: "model", namespace: NS, name: "m" })).toEqual({ name: "m", organization: NS });
  });
});

describe("repo operations", () => {
  test("create, then re-GET with the resource group for the authoritative _id", async () => {
    const { layer, calls } = stubHub((req) => (req.method === "POST" ? { body: { url: "u", name: "eh-registry", id: `${NS}/eh-registry` } } : { body: detail() }));
    const r = await runStub(createRepo({ ...ref, private: true }), layer);
    expect(r.adopted).toBe(false);
    expect(r.repo._id).toBe(HEX);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/repos/create", body: { type: "dataset", name: "eh-registry", organization: NS, private: true } });
    expect(calls[1]).toMatchObject({ method: "GET", path: `/api/datasets/${NS}/eh-registry`, searchParams: { "expand[]": "resourceGroup" } });
  });

  test("a duplicate create (409) is adoption", async () => {
    const { layer } = stubHub((req) => (req.method === "POST" ? { status: 409, body: { error: "exists" } } : { body: detail() }));
    expect((await runStub(createRepo(ref), layer)).adopted).toBe(true);
  });

  test("find: absent is undefined; get fails", async () => {
    const { layer } = stubHub(() => ({ status: 404, body: { error: "not found" } }));
    expect(await runStub(findRepo(ref), layer)).toBeUndefined();
    const { layer: l2 } = stubHub(() => ({ body: detail() }));
    expect((await runStub(getRepo(ref), l2)).id).toBe(`${NS}/eh-registry`);
  });

  test("into a resource group and out of it; delete absorbs 404 only", async () => {
    const { layer, calls } = stubHub(() => ({ body: {} }));
    await runStub(setRepoResourceGroup({ ...ref, resourceGroupId: "rg1" }), layer);
    await runStub(setRepoResourceGroup({ ...ref, resourceGroupId: null }), layer);
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", `/api/datasets/${NS}/eh-registry/resource-group`, { resourceGroupId: "rg1" }],
      ["POST", `/api/datasets/${NS}/eh-registry/resource-group`, { resourceGroupId: null }],
    ]);
    const { layer: gone, calls: dc } = stubHub(() => ({ status: 404, body: {} }));
    await runStub(deleteRepo(ref), gone);
    expect(dc[0]).toMatchObject({ method: "DELETE", path: "/api/repos/delete", body: { type: "dataset", name: "eh-registry", organization: NS } });
  });

  test("no operation ever sends a visibility change", async () => {
    const { layer, calls } = stubHub((req) => (req.method === "POST" && req.path === "/api/repos/create" ? { body: {} } : { body: detail() }));
    await runStub(createRepo({ ...ref, private: true }), layer);
    await runStub(setRepoResourceGroup({ ...ref, resourceGroupId: "x" }), layer);
    expect(calls.filter((c) => c.path.endsWith("/settings"))).toEqual([]);
  });
});
