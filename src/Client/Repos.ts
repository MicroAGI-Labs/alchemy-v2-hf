import * as Effect from "effect/Effect";
import type { ConfigError, HubError } from "../Errors.ts";
import { HubClient } from "../Http/Client.ts";
import { type CreateRepoBody, type RepoDetail, type RepoType, repoTypePath } from "./Types.ts";
import { validateHubName } from "./Validation.ts";

/**
 * Hub repository operations (models, datasets, spaces): create, read, move
 * into a resource group, delete.
 *
 * **Visibility is never changed here.** A repo is created private or public
 * once; there is deliberately no settings call that sends `private` or
 * `visibility`, so nothing in this package can make a private repo public.
 */

const seg = (value: string): string => encodeURIComponent(value);

const repoPath = (type: RepoType, namespace: string, name: string): string =>
  `/api/${repoTypePath(type)}/${seg(namespace)}/${seg(name)}`;

/** Assemble the create body, dropping unset keys (the Hub's defaults apply). */
export const buildCreateRepoBody = (props: {
  type: RepoType;
  namespace: string;
  name: string;
  private?: boolean;
  resourceGroupId?: string;
  sdk?: string;
}): CreateRepoBody => {
  const body: Record<string, unknown> = { name: props.name, organization: props.namespace };
  if (props.type !== "model") body.type = props.type;
  if (props.private !== undefined) body.private = props.private;
  if (props.resourceGroupId !== undefined) body.resourceGroupId = props.resourceGroupId;
  if (props.sdk !== undefined) body.sdk = props.sdk;
  return body as CreateRepoBody;
};

/** Fetch one repo, with its resource group. Read `_id` for a token's `repoIds`. */
export const getRepo = (input: {
  type: RepoType;
  namespace: string;
  name: string;
}): Effect.Effect<RepoDetail, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    return yield* client.json<RepoDetail>({
      method: "GET",
      path: repoPath(input.type, input.namespace, input.name),
      searchParams: { "expand[]": "resourceGroup" },
    });
  });

/** Fetch one repo, or `undefined` when it does not exist (or the token cannot see it). */
export const findRepo = (input: {
  type: RepoType;
  namespace: string;
  name: string;
}): Effect.Effect<RepoDetail | undefined, HubError | ConfigError, HubClient> =>
  getRepo(input).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined as RepoDetail | undefined)));

/**
 * Create a repo, then re-`GET` it for the authoritative `_id`. A duplicate
 * create (`409`) is adoption: the repo the caller asked for exists.
 */
export const createRepo = (input: {
  type: RepoType;
  namespace: string;
  name: string;
  private?: boolean;
  resourceGroupId?: string;
  sdk?: string;
}): Effect.Effect<{ repo: RepoDetail; adopted: boolean }, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    yield* validateHubName(input.namespace, "namespace");
    yield* validateHubName(input.name, "name");
    const client = yield* HubClient;
    const adopted = yield* client
      .request({ method: "POST", path: "/api/repos/create", body: buildCreateRepoBody(input) })
      .pipe(
        Effect.as(false),
        Effect.catchTag("Conflict", () => Effect.succeed(true)),
      );
    const repo = yield* getRepo(input);
    return { repo, adopted };
  });

/** Put a repo into a resource group, or pass `null` to take it out. */
export const setRepoResourceGroup = (input: {
  type: RepoType;
  namespace: string;
  name: string;
  resourceGroupId: string | null;
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    yield* client.request({
      method: "POST",
      path: `${repoPath(input.type, input.namespace, input.name)}/resource-group`,
      body: { resourceGroupId: input.resourceGroupId },
    });
  });

/** Delete a repo and everything in it. Absent is treated as deleted. */
export const deleteRepo = (input: {
  type: RepoType;
  namespace: string;
  name: string;
}): Effect.Effect<void, HubError | ConfigError, HubClient> =>
  Effect.gen(function* () {
    const client = yield* HubClient;
    const body: Record<string, unknown> = { name: input.name, organization: input.namespace };
    if (input.type !== "model") body.type = input.type;
    yield* client
      .request({ method: "DELETE", path: "/api/repos/delete", body })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });
