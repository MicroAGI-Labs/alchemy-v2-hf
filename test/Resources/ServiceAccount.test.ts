import { describe, expect, test } from "bun:test";
import {
  diffServiceAccountProps,
  serviceAccountService,
  type ServiceAccountProps,
} from "../../src/Resources/ServiceAccount.ts";
import { stubHub } from "../support.ts";
import { drive } from "./lifecycle.ts";

const ORG = "MicroAGI-Labs";
const SA = "6a6f8f4083f1c297d4dbb0d7";

const base: ServiceAccountProps = {
  organization: ORG,
  name: "trainer",
  description: "d",
};

describe("ServiceAccount diff", () => {
  test("no change is not a replacement", () => {
    expect(diffServiceAccountProps(base, { ...base })).toBeUndefined();
  });

  test("renaming replaces — there is no update endpoint", () => {
    expect(diffServiceAccountProps(base, { ...base, name: "other" })).toEqual({
      action: "replace",
    });
  });

  test("changing the description replaces for the same reason", () => {
    expect(
      diffServiceAccountProps(base, { ...base, description: "new" }),
    ).toEqual({ action: "replace" });
  });

  test("moving organization replaces", () => {
    expect(
      diffServiceAccountProps(base, { ...base, organization: "Other" }),
    ).toEqual({ action: "replace" });
  });
});

describe("ServiceAccount reconcile", () => {
  test("greenfield creates and returns the server id", async () => {
    const { layer, calls } = stubHub((req) =>
      req.method === "POST"
        ? {
            status: 201,
            body: {
              _id: SA,
              user: "u",
              fullname: "trainer",
              createdAt: "",
            },
          }
        : { status: 200, body: [] },
    );

    const attrs = await drive(
      serviceAccountService.reconcile,
      { news: base, olds: undefined, output: undefined },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]!.body).toEqual({ name: "trainer", description: "d" });
    expect(attrs).toEqual({ id: SA, organization: ORG, name: "trainer" });
  });

  test("an existing account of the same name is adopted rather than re-created", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: [{ _id: SA, user: "u", name: "trainer", createdAt: "" }],
    }));

    const attrs = await drive(
      serviceAccountService.reconcile,
      { news: base, olds: undefined, output: undefined },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(attrs.id).toBe(SA);
  });

  test("a create that loses a race falls back to the name scan", async () => {
    const { layer, calls } = stubHub((req, index) => {
      if (index === 0) return { status: 200, body: [] };
      if (req.method === "POST") return { status: 409, body: { error: "exists" } };
      return {
        status: 200,
        body: [{ _id: SA, user: "u", name: "trainer", createdAt: "" }],
      };
    });

    const attrs = await drive(
      serviceAccountService.reconcile,
      { news: base, olds: undefined, output: undefined },
      layer,
    );

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(attrs.id).toBe(SA);
  });

  test("a steady-state deploy verifies the id and writes nothing", async () => {
    const { layer, calls } = stubHub(() => ({
      status: 200,
      body: { _id: SA, user: "u", name: "trainer", createdAt: "" },
    }));

    const attrs = await drive(
      serviceAccountService.reconcile,
      {
        news: base,
        olds: base,
        output: { id: SA, organization: ORG, name: "trainer" },
      },
      layer,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(attrs.id).toBe(SA);
  });
});

describe("ServiceAccount read", () => {
  test("an id hit in state proves ownership", async () => {
    const { layer } = stubHub(() => ({
      status: 200,
      body: { _id: SA, user: "u", name: "trainer", createdAt: "" },
    }));

    const attrs = await drive(
      serviceAccountService.read,
      { olds: base, output: { id: SA, organization: ORG, name: "trainer" } },
      layer,
    );

    // Owned: plain attributes, so the engine adopts silently.
    expect(attrs).toEqual({ id: SA, organization: ORG, name: "trainer" });
  });

  test("a name-only match is reported Unowned so --adopt is required", async () => {
    const { layer } = stubHub(() => ({
      status: 200,
      body: [{ _id: SA, user: "u", name: "trainer", createdAt: "" }],
    }));

    const attrs = (await drive(
      serviceAccountService.read,
      { olds: base, output: undefined },
      layer,
    )) as object;

    // The brand is a non-enumerable symbol, so equality on the visible
    // fields still holds; what changes is the engine's routing.
    expect(attrs).toMatchObject({ id: SA, name: "trainer" });
    expect(
      Object.getOwnPropertySymbols(attrs).some((s) =>
        String(s).includes("Unowned"),
      ),
    ).toBe(true);
  });

  test("an absent account reads as undefined", async () => {
    const { layer } = stubHub(() => ({ status: 200, body: [] }));
    expect(
      await drive(
        serviceAccountService.read,
        { olds: base, output: undefined },
        layer,
      ),
    ).toBeUndefined();
  });
});
