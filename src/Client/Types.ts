/**
 * Wire types for the Hugging Face Hub REST API.
 *
 * Hand-written rather than generated: the Hub's OpenAPI description declares
 * no error responses and models several of these payloads loosely, so these
 * types record what the API is actually observed to return. Fields the Hub
 * may omit are optional; fields it renames between endpoints are called out
 * in comments (see {@link BucketDetail} for the `_id` / `id` trap).
 */

// ---------------------------------------------------------------------------
// Service accounts
// ---------------------------------------------------------------------------

/**
 * The 13 permissions an organization service-account token can carry. Typed
 * as a union so a typo is a compile error rather than a 400 at deploy time.
 */
export type HubPermission =
  | "repo.content.read"
  | "repo.write"
  | "inference.serverless.write"
  | "inference.endpoints.infer.write"
  | "inference.endpoints.write"
  | "org.read"
  | "org.write"
  | "collection.read"
  | "collection.write"
  | "resourceGroup.write"
  | "job.write"
  | "org.serviceAccounts.read"
  | "org.serviceAccounts.write";

/** Every value of {@link HubPermission}, for runtime validation. */
export const HUB_PERMISSIONS: ReadonlyArray<HubPermission> = [
  "repo.content.read",
  "repo.write",
  "inference.serverless.write",
  "inference.endpoints.infer.write",
  "inference.endpoints.write",
  "org.read",
  "org.write",
  "collection.read",
  "collection.write",
  "resourceGroup.write",
  "job.write",
  "org.serviceAccounts.read",
  "org.serviceAccounts.write",
];

/** Per-repository grants, which override the org-wide `permissions`. */
export type HubRepoPermission = "repo.content.read" | "repo.write";

/** Every value of {@link HubRepoPermission}, for runtime validation. */
export const HUB_REPO_PERMISSIONS: ReadonlyArray<HubRepoPermission> = [
  "repo.content.read",
  "repo.write",
];

/** `POST /api/organizations/{org}/service-accounts` request body. */
export type CreateServiceAccountBody = {
  name: string;
  description?: string;
};

/**
 * `POST /api/organizations/{org}/service-accounts` → `201`.
 *
 * Note the shape drift: create returns the account's name under
 * **`fullname`**, while `get`/`list` return the same value under `name`.
 */
export type ServiceAccountCreated = {
  _id: string;
  user: string;
  fullname: string;
  description?: string;
  createdAt: string;
};

/** One entry of a service account's `accessTokens` array. Never has a value. */
export type TokenInfo = {
  _id: string;
  displayName: string;
  createdAt: string;
  lastUsedAt?: string;
  expiration?: string;
  role?: string;
  permissions?: ReadonlyArray<HubPermission>;
  repoIds?: ReadonlyArray<string>;
  repoPermissions?: ReadonlyArray<HubRepoPermission>;
  endpointPatterns?: ReadonlyArray<string>;
  /** Last four characters of the token, for identification in the UI. */
  last4?: string;
  skipNetworkSecurity?: boolean;
};

/** `GET /api/organizations/{org}/service-accounts/{id}` → `200`. */
export type ServiceAccountDetail = {
  _id: string;
  user: string;
  name: string;
  email?: string;
  description?: string;
  createdAt: string;
  /**
   * Token metadata. **Never contains the plaintext token** — a token whose
   * value has been lost can only be replaced by rotating it.
   */
  accessTokens?: ReadonlyArray<TokenInfo>;
};

/** One element of `GET /api/organizations/{org}/service-accounts` → `200`. */
export type ServiceAccountSummary = {
  _id: string;
  user: string;
  name: string;
  email?: string;
  description?: string;
  createdAt: string;
};

/** Request body shared by token create and token patch. */
export type TokenBody = {
  displayName?: string;
  permissions?: ReadonlyArray<HubPermission>;
  repoIds?: ReadonlyArray<string>;
  repoPermissions?: ReadonlyArray<HubRepoPermission>;
  endpointPatterns?: ReadonlyArray<string>;
  skipNetworkSecurity?: boolean;
};

/** `POST .../service-accounts/{id}/tokens` request body. `displayName` required. */
export type CreateTokenBody = TokenBody & { displayName: string };

/**
 * `POST .../tokens` → `201` and `POST .../tokens/{tokenId}/rotate` → `200`.
 *
 * `token` is the plaintext value and is returned **exactly once**; the Hub
 * will never disclose it again through any endpoint.
 */
export type TokenIssued = {
  token: string;
  tokenInfo: TokenInfo;
};

/** `PATCH .../tokens/{tokenId}` → `200`. Carries metadata, never a value. */
export type TokenUpdated = {
  tokenInfo?: TokenInfo;
} & Partial<TokenInfo>;

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/** Where a bucket's data is stored. */
export type BucketRegion = "us" | "eu";

/** One CDN attachment on a bucket. */
export type BucketCdn = {
  provider: "gcp" | "aws";
  region: BucketRegion;
};

/** `POST /api/buckets/{namespace}/{name}` request body — all fields optional. */
export type CreateBucketBody = {
  private?: boolean;
  resourceGroupId?: string;
  cdn?: ReadonlyArray<BucketCdn>;
  region?: BucketRegion;
};

/**
 * `POST /api/buckets/{namespace}/{name}` → `200`.
 *
 * **Do not read an identifier out of this.** The `id` field here is not
 * reliably the 24-hex repo id (on `GET` the same field name carries the
 * `namespace/name` string instead), so the client always re-`GET`s the
 * bucket after a create to obtain the authoritative `_id`.
 */
export type BucketCreated = {
  url: string;
  name: string;
  id: string;
};

/**
 * `GET /api/buckets/{namespace}/{name}` → `200`.
 *
 * The two identifier fields are easy to mix up, and only one of them is
 * usable in a token's `repoIds`:
 *
 * - **`_id`** — the 24-hex repo id, e.g. `6a6f8f4083f1c297d4dbb0d7`. This is
 *   the value that goes into `repoIds`.
 * - **`id`** — the `namespace/name` string, e.g. `MicroAGI-Labs/datasets`.
 */
export type BucketDetail = {
  /** 24-hex repo id. The value to scope a token to this bucket. */
  _id: string;
  /** `namespace/name`, **not** a hex id. */
  id: string;
  author?: string;
  private?: boolean;
  createdAt?: string;
  updatedAt?: string;
  size?: number;
  totalFiles?: number;
  repoType?: "bucket";
  cdnRegions?: ReadonlyArray<BucketCdn>;
  resourceGroup?: { id?: string; name?: string } | null;
  url?: string;
};

/** `PUT /api/buckets/{namespace}/{name}/settings` request body. */
export type BucketSettingsBody = {
  private?: boolean;
  cdnRegions?: ReadonlyArray<BucketCdn>;
};

// ---------------------------------------------------------------------------
// Repositories (models, datasets, spaces)
// ---------------------------------------------------------------------------

/** A Hub repository type that `POST /api/repos/create` handles. */
export type RepoType = "model" | "dataset" | "space";

/** The URL path segment of a repo type: `models`, `datasets`, `spaces`. */
export const repoTypePath = (type: RepoType): string => `${type}s`;

/**
 * `POST /api/repos/create` request body. `type` is omitted for a model (the
 * Hub's default). `private` is the visibility at creation; this package never
 * changes it afterwards.
 */
export type CreateRepoBody = {
  type?: "dataset" | "space";
  name: string;
  organization?: string;
  private?: boolean;
  resourceGroupId?: string;
  /** spaces only */
  sdk?: string;
};

/**
 * `GET /api/{type}s/{namespace}/{name}?expand[]=resourceGroup` → `200`. As for
 * buckets, **`_id`** is the 24-hex repo id a token's `repoIds` takes and
 * **`id`** is the `namespace/name` string.
 */
export type RepoDetail = {
  _id: string;
  id: string;
  author?: string;
  private?: boolean;
  gated?: false | "auto" | "manual";
  sha?: string;
  lastModified?: string;
  resourceGroup?: { id?: string; name?: string; numUsers?: number } | null;
};

// ---------------------------------------------------------------------------
// Resource groups and organization members
// ---------------------------------------------------------------------------

/**
 * A member's role inside a resource group. `inherit` follows the member's
 * organization role; `no_access` removes access to the group's repos.
 */
export type ResourceGroupRole = "read" | "contributor" | "write" | "admin";

/** Every value of {@link ResourceGroupRole}, for runtime validation. */
export const RESOURCE_GROUP_ROLES: ReadonlyArray<ResourceGroupRole> = ["read", "contributor", "write", "admin"];

/** One member of a resource group, as the API takes and returns it. */
export type ResourceGroupUser = {
  /** the Hub username (a service account's `user`, too) */
  user: string;
  role: ResourceGroupRole;
};

/** `POST /api/organizations/{org}/resource-groups` request body. */
export type CreateResourceGroupBody = {
  name: string;
  description?: string;
  users?: ReadonlyArray<ResourceGroupUser>;
  repos?: ReadonlyArray<{ name: string; type: RepoType }>;
  autoJoin?: { enabled: boolean; role?: ResourceGroupRole };
};

/**
 * `GET /api/organizations/{org}/resource-groups[/{id}]`. The Hub returns `id`
 * (24-hex) for a resource group; `users` and `repos` may be omitted by the
 * list endpoint, so {@link getResourceGroup} is the authoritative read.
 */
export type ResourceGroupDetail = {
  id: string;
  name: string;
  description?: string;
  users?: ReadonlyArray<ResourceGroupUser & { type?: string }>;
  repos?: ReadonlyArray<{ name: string; type: RepoType }>;
  autoJoin?: { enabled?: boolean; role?: string } | null;
};

/**
 * One element of `GET /api/organizations/{org}/members`. `verifiedEmail` is
 * filled in only for members whose email matches the organization's
 * verified email domain (or an SSO matching domain); otherwise `null`.
 */
export type OrganizationMember = {
  _id?: string;
  user: string;
  fullname?: string;
  type?: string;
  role?: string;
  verifiedEmail?: string | null;
  isExternalCollaborator?: boolean;
  twoFaEnabled?: boolean;
  resourceGroups?: ReadonlyArray<{ id: string; name?: string; role?: string }>;
};
