import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  Credentials,
  DEFAULT_ENDPOINT,
  fromToken,
  normalizeEndpoint,
} from "../../src/Auth/Credentials.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("normalizeEndpoint", () => {
  test("strips trailing slashes so paths never double up", async () => {
    expect(await run(normalizeEndpoint("https://huggingface.co///"))).toBe(
      "https://huggingface.co",
    );
  });

  test("an empty value falls back to the default", async () => {
    expect(await run(normalizeEndpoint(""))).toBe(DEFAULT_ENDPOINT);
    expect(await run(normalizeEndpoint("   "))).toBe(DEFAULT_ENDPOINT);
  });

  test("a self-hosted Hub URL is kept verbatim", async () => {
    expect(await run(normalizeEndpoint("https://hub.internal:8443"))).toBe(
      "https://hub.internal:8443",
    );
  });

  test("a scheme-less endpoint is a typed ConfigError, not a defect", async () => {
    // `HubClient.buildUrl` does `new URL(`${endpoint}${path}`)`, which THROWS
    // on "huggingface.co". Inside `Effect.gen` that is an unhandled defect
    // that escapes every catchTag in the package. Catching it here keeps the
    // failure in the typed channel the rest of the module produces.
    const failure = await run(
      normalizeEndpoint("huggingface.co", "HF_ENDPOINT").pipe(Effect.flip),
    );
    expect(failure._tag).toBe("ConfigError");
    expect(failure.message).toContain("HF_ENDPOINT");
    expect(failure.message).toContain("absolute http/https URL");
  });

  test("a non-http scheme is rejected", async () => {
    const failure = await run(
      normalizeEndpoint("ftp://huggingface.co").pipe(Effect.flip),
    );
    expect(failure._tag).toBe("ConfigError");
  });
});

describe("fromToken", () => {
  test("redacts a plaintext token and normalizes the endpoint", async () => {
    const credentials = await run(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Credentials;
        }),
        fromToken("hf_x", "https://h/"),
      ),
    );
    expect(Redacted.value(credentials.token)).toBe("hf_x");
    expect(credentials.endpoint).toBe("https://h");
  });

  test("an invalid endpoint fails the layer instead of crashing later", async () => {
    const failure = await run(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Credentials;
        }),
        fromToken("hf_x", "h"),
      ).pipe(Effect.flip),
    );
    expect(failure._tag).toBe("ConfigError");
  });
});
