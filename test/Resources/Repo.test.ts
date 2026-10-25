import { describe, expect, test } from "bun:test";
import { diffRepoProps, type RepoProps, repoService, visibilityProblem } from "../../src/Resources/Repo.ts";
import { stubHub } from "../support.ts";
import { drive, driveFailure } from "./lifecycle.ts";

const NS = "MicroAGI-Labs";
const HEX = "6a6f8f4083f1c297d4dbb0d7";
const base: RepoProps = { type: "dataset", namespace: NS, name: "eh-registry", private: true };
const detail = (o: Record<string, unknown> = {}) => ({ _id: HEX, id: `${NS}/eh-registry`, private: true, resourceGroup: null, ...o });

describe("Repo diff and visibility", () => {
  test("identity replaces; the resource group and the visibility assertion do not", () => {
    expect(diffRepoProps(base, { ...base, name: "x" })).toEqual({ action: "replace" });
    expect(diffRepoProps(base, { ...base, type: "model" })).toEqual({ action: "replace" });
    expect(diffRepoProps(base, { ...base, resourceGroupId: "rg" })).toBeUndefined();
  });
  test("a visibility other than the stack's is a problem; unset asserts nothing", () => {
    expect(visibilityProblem(base, detail({ private: false }) as never)).toMatch(/is public, the stack says private: visibility is never changed/);
    expect(visibilityProblem({ ...base, private: undefined }, detail({ private: false }) as never)).toBeUndefined();
    expect(visibilityProblem(base, detail() as never)).toBeUndefined();
  });
});

describe("Repo reconcile", () => {
  test("absent: created private in its resource group; attributes from the re-read", async () => {
    let created = false;
    const { layer, calls } = stubHub((req) => {
      if (req.method === "POST" && req.path === "/api/repos/create") {
        created = true;
        return { body: {} };
      }
      if (req.method === "GET") return created ? { body: detail({ resourceGroup: { id: "rg" } }) } : { status: 404, body: {} };
      return { body: {} };
    });
    const out = await drive(repoService.reconcile, { news: { ...base, resourceGroupId: "rg" } }, layer);
    expect(out).toMatchObject({ repoId: HEX, fullName: `${NS}/eh-registry`, private: true, url: `https://huggingface.co/datasets/${NS}/eh-registry` });
    expect(calls.find((c) => c.path === "/api/repos/create")?.body).toEqual({ type: "dataset", name: "eh-registry", organization: NS, private: true, resourceGroupId: "rg" });
    expect(calls.some((c) => c.path.endsWith("/resource-group"))).toBe(false);
  });

  test("existing: moved into its resource group; no write when nothing differs", async () => {
    const { layer, calls } = stubHub(() => ({ body: detail() }));
    await drive(repoService.reconcile, { news: { ...base, resourceGroupId: "rg" } }, layer);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ resourceGroupId: "rg" }]);
    const { layer: same, calls: c2 } = stubHub(() => ({ body: detail({ resourceGroup: { id: "rg" } }) }));
    await drive(repoService.reconcile, { news: { ...base, resourceGroupId: "rg" } }, same);
    expect(c2.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("existing with another visibility: the deploy fails and nothing is written", async () => {
    const { layer, calls } = stubHub(() => ({ body: detail({ private: false }) }));
    const e = await driveFailure(repoService.reconcile, { news: base }, layer);
    expect(e).toMatchObject({ _tag: "ConfigError" });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("read: owned only with the id in state; delete calls the delete endpoint", async () => {
    const { layer } = stubHub(() => ({ body: detail() }));
    const owned = await drive(repoService.read, { olds: base, output: { repoId: HEX, type: "dataset", namespace: NS, name: "eh-registry" } }, layer);
    expect(owned).toMatchObject({ repoId: HEX });
    const unowned = await drive(repoService.read, { olds: base, output: undefined }, layer);
    expect(unowned).toBeDefined();
    expect(await drive(repoService.read, { olds: undefined, output: undefined }, layer)).toBeUndefined();
    const { layer: d, calls } = stubHub(() => ({ body: {} }));
    await drive(repoService.delete, { olds: base, output: { type: "dataset", namespace: NS, name: "eh-registry" } }, d);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/api/repos/delete" });
  });
});
