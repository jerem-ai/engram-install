import { join } from 'node:path';
import { MemoryAdmissionService } from './admission.js';
import { loadPersistentKey } from './key-file.js';
import { createReviewAuthorizer } from './local-identity.js';
import type { ToolAuthorizer } from '../../security/authorization.js';

/**
 * Receipt key for MemoryAdmissionService.
 *
 * The key seeds the HMAC that derives candidate ids, so it MUST be stable across
 * runs. A regenerated key changes every id and the quarantine table fills with
 * duplicates of rows it already holds. That is why a short or unreadable key file
 * fails closed here instead of being replaced with a fresh one.
 */
const KEY_FILE = 'memory-admission-receipt.key';

export function admissionReceiptKeyPath(dataDir: string): string {
  return process.env.ENGRAM_ADMISSION_RECEIPT_KEY_FILE || join(dataDir, 'credentials', KEY_FILE);
}

export function loadAdmissionReceiptKey(dataDir: string): Uint8Array {
  return loadPersistentKey(admissionReceiptKeyPath(dataDir), 'Memory admission receipt key');
}

/**
 * Build the admission service every production entry point should use.
 *
 * Both the CLI indexer and the MCP server must go through here. When either one
 * runs without a service, `deriveAssertion` falls past the admission branch and
 * drops the candidate with no record, which is what silently emptied the
 * quarantine queue between 2026-08-01 and 2026-08-21.
 */
export function createMemoryAdmissionService(
  dataDir: string,
  options: { authorizer?: ToolAuthorizer } = {},
): MemoryAdmissionService {
  return new MemoryAdmissionService({
    receiptKey: loadAdmissionReceiptKey(dataDir),
    // No authorizer means promote()/reject() go unused: default to the local
    // single-operator CLI review path (src/lib/engram/local-identity.ts) so
    // the CLI works with zero configuration. A non-local caller (the OAuth
    // MCP server) passes its own tenant-bound authorizer explicitly instead.
    authorizer: options.authorizer ?? createReviewAuthorizer(dataDir),
    // Agents admit their own facts (Jeremy, 2026-10-04): nobody reviews a queue by hand.
    selfAdmission: true,
  });
}
