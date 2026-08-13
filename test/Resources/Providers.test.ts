import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Credentials, fromToken } from "../../src/Auth/Credentials.ts";
import { providers } from "../../src/Resources/Providers.ts";

/**
 * Build the bundle and pull the {@link Credentials} it resolved back out.
 *
 * `providers()` satisfies Credentials internally with `Layer.provideMerge`,
 * so the resolved service is part of the built Layer's context — which is
 * exactly why a caller cannot override it from the outside and why the
 * `credentials` option exists.
 */
const resolveCredentials = (
  layer: ReturnType<typeof providers>,
): Promise<Credentials["Service"]> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Credentials, Effect.succeed).pipe(
        Effect.provide(layer),
        // `Stack` provides this once at the top level in a real deploy; the
        // bundle deliberately does not re-provide it.
        Effect.provide(FetchHttpClient.layer),
      ),
    ),
  );

describe("providers({ credentials })", () => {
  test("a caller-supplied Credentials layer replaces the env-backed one", async () => {
    const credentials = await resolveCredentials(
      providers({
        env: "HF_NEVER_READ",
        credentials: fromToken(Effect.succeed(Redacted.make("hf_from_caller"))),
      }),
    );
    expect(Redacted.value(await Effect.runPromise(credentials.token))).toBe(
      "hf_from_caller",
    );
  });

  test("without the option the environment variable is still the source", async () => {
    process.env.HF_PROVIDERS_TEST_TOKEN = "hf_from_env";
    try {
      const credentials = await resolveCredentials(
        providers({ env: "HF_PROVIDERS_TEST_TOKEN" }),
      );
      expect(Redacted.value(await Effect.runPromise(credentials.token))).toBe(
        "hf_from_env",
      );
    } finally {
      delete process.env.HF_PROVIDERS_TEST_TOKEN;
    }
  });
});
