import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  Credentials,
  DEFAULT_ENDPOINT,
  fromEnv,
  fromToken,
  normalizeEndpoint,
} from "../../src/Auth/Credentials.ts";
import { ConfigError } from "../../src/Errors.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/**
 * A `ConfigProvider` over a fixed map that records every path it is asked
 * for, so a test can assert *when* — and how often — the token is read.
 */
const countingProvider = (values: Record<string, string>) => {
  const reads: Array<string> = [];
  const provider = ConfigProvider.make((path) => {
    const key = path.map(String).join("_");
    reads.push(key);
    const value = values[key];
    return Effect.succeed(
      value === undefined ? undefined : ConfigProvider.makeValue(value),
    );
  });
  return { layer: ConfigProvider.layer(provider), reads };
};

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

describe("fromEnv", () => {
  test("builds with the variable ABSENT — a noop plan needs no token", async () => {
    // The whole point of the lazy shape. Alchemy builds the `providers:`
    // Layer eagerly at stack start, so an eager token read failed EVERY plan
    // and deploy — including ones where all HF resources are noop.
    const { layer, reads } = countingProvider({});

    const credentials = await run(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Credentials;
        }),
        fromEnv().pipe(Layer.provide(layer)),
      ),
    );

    expect(credentials.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(reads).not.toContain("HF_ADMIN_TOKEN");
  });

  test("the missing-token failure surfaces at USE, not at build", async () => {
    const { layer } = countingProvider({});

    const failure = await run(
      Effect.provide(
        Effect.gen(function* () {
          const credentials = yield* Credentials;
          return yield* credentials.token;
        }),
        fromEnv().pipe(Layer.provide(layer)),
      ).pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toContain("HF_ADMIN_TOKEN");
    expect(failure.message).toContain("org.serviceAccounts.write");
  });

  test("the `env` override names the overridden variable everywhere", async () => {
    const { layer } = countingProvider({});

    const failure = await run(
      Effect.provide(
        Effect.gen(function* () {
          const credentials = yield* Credentials;
          return yield* credentials.token;
        }),
        fromEnv({ env: "HF_SA_TOKEN" }).pipe(Layer.provide(layer)),
      ).pipe(Effect.flip),
    );

    expect(failure.message).toContain("HF_SA_TOKEN");
    expect(failure.message).not.toContain("HF_ADMIN_TOKEN");
  });

  test("resolves the token, redacted, when the variable is present", async () => {
    const { layer } = countingProvider({ HF_SA_TOKEN: "hf_env" });

    const token = await run(
      Effect.provide(
        Effect.gen(function* () {
          const credentials = yield* Credentials;
          return yield* credentials.token;
        }),
        fromEnv({ env: "HF_SA_TOKEN" }).pipe(Layer.provide(layer)),
      ),
    );

    expect(Redacted.isRedacted(token)).toBe(true);
    expect(Redacted.value(token)).toBe("hf_env");
    // A `Redacted` must not leak through string coercion — this is what keeps
    // it out of log lines and error messages.
    expect(String(token)).not.toContain("hf_env");
  });

  test("reads the variable at most once however many resources reconcile", async () => {
    const { layer, reads } = countingProvider({ HF_ADMIN_TOKEN: "hf_env" });

    await run(
      Effect.provide(
        Effect.gen(function* () {
          const credentials = yield* Credentials;
          yield* credentials.token;
          yield* credentials.token;
          yield* credentials.token;
        }),
        fromEnv().pipe(Layer.provide(layer)),
      ),
    );

    expect(reads.filter((key) => key === "HF_ADMIN_TOKEN")).toHaveLength(1);
  });

  test("still resolves the endpoint eagerly, and still rejects a bad one", async () => {
    const { layer } = countingProvider({ HF_ENDPOINT: "huggingface.co" });

    const failure = await run(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Credentials;
        }),
        fromEnv().pipe(Layer.provide(layer)),
      ).pipe(Effect.flip),
    );

    expect(failure._tag).toBe("ConfigError");
    expect(failure.message).toContain("HF_ENDPOINT");
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
    expect(Redacted.value(await run(credentials.token))).toBe("hf_x");
    expect(credentials.endpoint).toBe("https://h");
  });

  test("accepts an Effect — the seam for state-sourced tokens", async () => {
    // A future change may feed this from Alchemy state rather than the
    // environment; the read must stay deferred and memoized when it does.
    let resolutions = 0;
    const source = Effect.sync(() => {
      resolutions += 1;
      return Redacted.make("hf_from_state");
    });

    const credentials = await run(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Credentials;
        }),
        fromToken(source),
      ),
    );

    expect(resolutions).toBe(0);
    expect(Redacted.value(await run(credentials.token))).toBe("hf_from_state");
    expect(Redacted.value(await run(credentials.token))).toBe("hf_from_state");
    expect(resolutions).toBe(1);
  });

  test("an Effect that fails surfaces its ConfigError at use", async () => {
    const credentials = await run(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Credentials;
        }),
        fromToken(Effect.fail(new ConfigError({ message: "no token in state" }))),
      ),
    );

    const failure = await run(credentials.token.pipe(Effect.flip));
    expect(failure.message).toBe("no token in state");
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
