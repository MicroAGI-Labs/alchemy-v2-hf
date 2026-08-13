import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { fromToken } from "../src/Auth/Credentials.ts";
import type { ConfigError } from "../src/Errors.ts";
import { fromStatus, messageFromBody } from "../src/Errors.ts";
import {
  HubClient,
  type HubRequest,
  type HubResponse,
  layer as hubClientLayer,
} from "../src/Http/Client.ts";

/**
 * Test doubles. **Nothing here touches the network** — the two stubs below
 * are the only way any test in this package reaches an HTTP boundary.
 *
 * Two levels are provided because the package has two levels:
 *
 * - {@link stubHttp} replaces `HttpClient` and exercises the real
 *   {@link hubClientLayer} — used to test URL assembly, auth headers, body
 *   encoding and status→error classification.
 * - {@link stubHub} replaces `HubClient` outright and records the request
 *   objects — used to test the client operations and the resource
 *   reconcilers, where the interesting assertion is *which* calls were made
 *   with *what* body.
 */

/** One recorded exchange against the {@link stubHub} double. */
export type RecordedCall = HubRequest;

/**
 * A canned reply. Any `status` of 400 or above is failed with the same
 * tagged error the real client produces for that status, so `catchTag` paths
 * (notably the bucket 409-adopt) are exercised for real rather than faked.
 */
export type StubReply = {
  readonly status?: number;
  readonly body?: unknown;
};

/**
 * Replace `HubClient` with a handler over recorded requests.
 *
 * `handler` receives each request in order, along with its zero-based index,
 * and returns the reply.
 */
export const stubHub = (
  handler: (req: HubRequest, index: number) => StubReply,
): {
  layer: Layer.Layer<HubClient>;
  calls: Array<RecordedCall>;
} => {
  const calls: Array<RecordedCall> = [];

  const request = (req: HubRequest) =>
    Effect.suspend(() => {
      const index = calls.length;
      calls.push(req);
      const reply = handler(req, index);
      const status = reply.status ?? 200;
      if (status >= 400) {
        return Effect.fail(
          fromStatus({
            status,
            method: req.method,
            url: `https://huggingface.co${req.path}`,
            message: messageFromBody(
              reply.body,
              `stub ${req.method} ${req.path} -> ${status}`,
            ),
            body: reply.body,
          }),
        );
      }
      return Effect.succeed({ status, body: reply.body } satisfies HubResponse);
    });

  const layer = Layer.succeed(HubClient, {
    request,
    json: (req: HubRequest) => request(req).pipe(Effect.map((r) => r.body)),
    endpoint: "https://huggingface.co",
  } as unknown as HubClient["Service"]);

  return { layer, calls };
};

/** One request seen by the {@link stubHttp} double, already decoded. */
export type RecordedHttpCall = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
};

/**
 * Replace `HttpClient` with a canned responder and build the **real**
 * {@link hubClientLayer} on top, so the module under test is the actual
 * client rather than a double.
 */
export const stubHttp = (
  handler: (
    call: RecordedHttpCall,
    index: number,
  ) => { status: number; body?: string },
): {
  // `fromToken` validates its endpoint, so the composed layer carries a
  // `ConfigError` in its error channel rather than `never`.
  layer: Layer.Layer<HubClient, ConfigError>;
  calls: Array<RecordedHttpCall>;
} => {
  const calls: Array<RecordedHttpCall> = [];

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : undefined;
      const call: RecordedHttpCall = {
        method: request.method,
        url: url.toString(),
        authorization: request.headers.authorization,
        body: body === undefined ? undefined : JSON.parse(body),
      };
      const index = calls.length;
      calls.push(call);
      const reply = handler(call, index);
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.body ?? null, {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );

  const layer = hubClientLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(fromToken("hf_test_token")),
  );

  return { layer, calls };
};

/** Run an Effect against a stub layer, failing the test on an unexpected error. */
export const runStub = <A, E, LE>(
  effect: Effect.Effect<A, E, HubClient>,
  layer: Layer.Layer<HubClient, LE>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
