import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { buildUrl, HubClient, parseJson } from "../../src/Http/Client.ts";
import { stubHttp } from "../support.ts";

describe("buildUrl", () => {
  test("joins the endpoint and path without doubling the slash", () => {
    expect(
      buildUrl("https://huggingface.co", { method: "GET", path: "/api/x" }),
    ).toBe("https://huggingface.co/api/x");
  });

  test("drops search params whose value is undefined", () => {
    expect(
      buildUrl("https://huggingface.co", {
        method: "GET",
        path: "/api/buckets/ns",
        searchParams: { search: undefined },
      }),
    ).toBe("https://huggingface.co/api/buckets/ns");
  });

  test("appends search params that are present", () => {
    expect(
      buildUrl("https://huggingface.co", {
        method: "GET",
        path: "/api/buckets/ns",
        searchParams: { search: "data sets" },
      }),
    ).toBe("https://huggingface.co/api/buckets/ns?search=data+sets");
  });
});

describe("parseJson", () => {
  test("treats an empty body as absent", () => {
    expect(parseJson("")).toBeUndefined();
    expect(parseJson("   ")).toBeUndefined();
  });

  test("returns non-JSON bodies verbatim rather than throwing", () => {
    // The Hub serves an HTML error page when a request is rejected at the
    // edge; a strict decode there hides the real status.
    expect(parseJson("<html>nope</html>")).toBe("<html>nope</html>");
  });
});

describe("HubClient", () => {
  test("sends a bearer token and a JSON body, and decodes the reply", async () => {
    const { layer, calls } = stubHttp(() => ({
      status: 201,
      body: JSON.stringify({ _id: "abc" }),
    }));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HubClient;
        return yield* client.json<{ _id: string }>({
          method: "POST",
          path: "/api/organizations/Org/service-accounts",
          body: { name: "sa" },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({ _id: "abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://huggingface.co/api/organizations/Org/service-accounts",
    );
    expect(calls[0]!.authorization).toBe("Bearer hf_test_token");
    expect(calls[0]!.body).toEqual({ name: "sa" });
  });

  test("classifies non-2xx statuses into tagged errors", async () => {
    const cases: Array<[number, string]> = [
      [400, "BadRequest"],
      [401, "Unauthorized"],
      [403, "Forbidden"],
      [404, "NotFound"],
      [409, "Conflict"],
      [429, "RateLimited"],
      [503, "ServerError"],
      [418, "UnexpectedStatus"],
    ];

    for (const [status, tag] of cases) {
      const { layer } = stubHttp(() => ({
        status,
        body: JSON.stringify({ error: "nope" }),
      }));
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HubClient;
          return yield* client.request({ method: "GET", path: "/api/x" });
        }).pipe(Effect.flip, Effect.provide(layer)),
      );
      expect(failure._tag as string).toBe(tag);
    }
  });

  test("carries the error body through, so 409 can be mined for a payload", async () => {
    const { layer } = stubHttp(() => ({
      status: 409,
      body: JSON.stringify({ error: "exists", id: "MicroAGI-Labs/datasets" }),
    }));
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HubClient;
        return yield* client.request({ method: "POST", path: "/api/x" });
      }).pipe(Effect.flip, Effect.provide(layer)),
    );
    expect(failure._tag).toBe("Conflict");
    expect("body" in failure ? failure.body : undefined).toEqual({
      error: "exists",
      id: "MicroAGI-Labs/datasets",
    });
    expect(failure.message).toBe("exists");
  });

  test("a 204 with no body is a success with an undefined body", async () => {
    const { layer } = stubHttp(() => ({ status: 204 }));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HubClient;
        return yield* client.request({ method: "DELETE", path: "/api/x" });
      }).pipe(Effect.provide(layer)),
    );
    expect(result.status).toBe(204);
    expect(result.body).toBeUndefined();
  });

  test("never puts the token anywhere but the Authorization header", async () => {
    const { layer, calls } = stubHttp(() => ({ status: 200, body: "{}" }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HubClient;
        return yield* client.request({
          method: "POST",
          path: "/api/x",
          body: { a: 1 },
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(calls[0]!.url).not.toContain("hf_test_token");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("hf_test_token");
  });
});
