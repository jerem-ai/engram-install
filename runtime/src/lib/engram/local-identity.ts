import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadPersistentKey } from './key-file.js';
import { SqliteReplayGuard } from '../../security/replay-store.js';
import { ToolAuthorizer } from '../../security/authorization.js';
import type { AccessContext } from '../access-context.js';
import type { AuthorizationGrant, VerifiedRequestIdentity } from '../../security/request-identity.js';

/**
 * Local-operator identity and authorizer for single-user CLI review.
 *
 * `MemoryAdmissionService.promote()`/`.reject()` require a `ToolAuthorizer`
 * and a `VerifiedRequestIdentity`. In production those normally come from the
 * OAuth resource-server path in `src/mcp/secure-engram-http.ts`, which is
 * built for a remote, multi-tenant reviewer verified by a token issuer. That
 * path is unusable for a single operator running the CLI on their own
 * machine against their own data directory — there is no issuer to call.
 *
 * This module is that local path. It does NOT bypass the authorizer or the
 * replay guard: every call to `createLocalOperatorIdentity` mints a fresh,
 * single-use `authorizationGrant.id`, and `ToolAuthorizer` + `SqliteReplayGuard`
 * still reject any attempt to reuse one grant across two operations exactly
 * as they would for a remote caller. It only removes the requirement for an
 * OAuth token issuer, not the requirement for a fresh grant per write.
 *
 * Any reviewer who is not the local operator (a remote teammate, an
 * automated agent acting on someone else's behalf, anything crossing a
 * trust boundary) must go through the OAuth path in
 * `src/mcp/secure-engram-http.ts` instead.
 */
export const LOCAL_REVIEW_AUTHORIZATION_VERSION = 'engram-local-review-v1';

const REPLAY_KEY_FILE = 'review-replay.key';
const REPLAY_DB_FILE = 'review-replay.db';

/** Grants stay usable for this many seconds after issuance (matches ToolAuthorizer's own default). */
const LOCAL_GRANT_LIFETIME_SECONDS = 300;

function reviewReplayKeyPath(dataDir: string): string {
  return join(dataDir, 'credentials', REPLAY_KEY_FILE);
}

/**
 * Build the `ToolAuthorizer` used to authorize local memory review calls.
 *
 * The replay guard and its HMAC key both live under `dataDir`, so replay
 * protection survives process restarts: the key is loaded (or created once)
 * via the same fail-closed persistent-key scheme as the admission receipt
 * key (`src/lib/engram/key-file.ts`), and the replay guard is a SQLite file
 * at `<dataDir>/review-replay.db` rather than an in-memory set.
 */
export function createReviewAuthorizer(dataDir: string): ToolAuthorizer {
  const replayGuard = new SqliteReplayGuard(join(dataDir, REPLAY_DB_FILE));
  const replayKey = loadPersistentKey(
    reviewReplayKeyPath(dataDir),
    'Engram local review replay key',
  );
  return new ToolAuthorizer({
    authorizationVersion: LOCAL_REVIEW_AUTHORIZATION_VERSION,
    replayGuard,
    replayKey,
  });
}

/**
 * Build a fresh local-operator identity for a single review call.
 *
 * Call this once per `promote`/`reject` invocation, not once per session:
 * the `authorizationGrant.id` is single-use, and reusing an identity across
 * two operations is rejected as a replay by design.
 *
 * Note the unit mismatch this bridges: `ToolAuthorizer` measures grant age
 * in seconds (`Date.now() / 1000`), while `MemoryAdmissionService` measures
 * receipt/candidate timestamps in milliseconds. `issuedAt`/`expiresAt`/the
 * grant's `issuedAt` here are all in seconds, matching `ToolAuthorizer`'s
 * expectations — mixing in milliseconds would make every grant read as
 * already expired.
 */
export function createLocalOperatorIdentity(accessContext: AccessContext): VerifiedRequestIdentity {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const grant: AuthorizationGrant = Object.freeze({ id: randomUUID(), issuedAt: nowSeconds });
  return Object.freeze({
    accessContext,
    issuer: 'local-operator',
    resource: 'local-cli',
    clientId: 'engram-review-cli',
    scopes: Object.freeze(['engram:write']),
    tokenId: randomUUID(),
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + LOCAL_GRANT_LIFETIME_SECONDS,
    authorizationVersion: LOCAL_REVIEW_AUTHORIZATION_VERSION,
    authorizationGrant: grant,
  });
}
