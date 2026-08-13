import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { HubClient } from "../../src/Http/Client.ts";

/**
 * Drive a provider's lifecycle handlers directly.
 *
 * The engine passes a wide input record (`id`, `fqn`, `instanceId`,
 * `session`, `bindings`, …) that none of these reconcilers read. Filling all
 * of it in every test would bury the two or three fields that actually
 * matter, so the helper supplies benign defaults and casts once, here,
 * instead of at every call site.
 */
const baseInput = {
  id: "Test",
  fqn: "test::Test",
  instanceId: "instance",
  session: undefined,
  bindings: {},
  oldBindings: {},
  newBindings: {},
};

/** Invoke `handler` with `input` merged over the engine-shaped defaults. */
export const drive = <A, E>(
  handler: (input: never) => Effect.Effect<A, E, HubClient>,
  input: Record<string, unknown>,
  layer: Layer.Layer<HubClient>,
): Promise<A> =>
  Effect.runPromise(
    handler({ ...baseInput, ...input } as never).pipe(
      Effect.provide(layer),
    ) as Effect.Effect<A, E>,
  );

/** Same as {@link drive}, but expects failure and returns the typed error. */
export const driveFailure = <A, E>(
  handler: (input: never) => Effect.Effect<A, E, HubClient>,
  input: Record<string, unknown>,
  layer: Layer.Layer<HubClient>,
): Promise<E> =>
  Effect.runPromise(
    handler({ ...baseInput, ...input } as never).pipe(
      Effect.flip,
      Effect.provide(layer),
    ) as Effect.Effect<E>,
  );
