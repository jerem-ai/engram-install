import { createHmac } from 'node:crypto';
import type { VerifiedRequestIdentity } from './request-identity.js';

export type ToolRisk = 'read' | 'write' | 'destructive' | 'external' | 'admin';
export type AuthorizationReason =
  | 'allowed'
  | 'unknown_tool'
  | 'insufficient_scope'
  | 'stale_authorization'
  | 'fresh_grant_required'
  | 'stale_grant'
  | 'future_grant'
  | 'replay_detected';

export interface ToolRule {
  scope: string;
  risk: ToolRisk;
}

export interface ReplayGuard {
  consume(key: string, expiresAtMs: number, nowMs: number): boolean;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationReason;
  requiredScope?: string;
  risk?: ToolRisk;
}

export interface ToolAuthorizerOptions {
  authorizationVersion: string;
  replayGuard: ReplayGuard;
  replayKey: Uint8Array;
  grantMaxAgeSeconds?: number;
  clockSkewSeconds?: number;
  now?: () => number;
  rules?: Readonly<Record<string, ToolRule>>;
}

export const DEFAULT_TOOL_RULES: Readonly<Record<string, ToolRule>> = Object.freeze({
  kg_memory_search: { scope: 'engram:read', risk: 'read' },
  kg_timeline_search: { scope: 'engram:read', risk: 'read' },
  engram_history_search: { scope: 'engram:read', risk: 'read' },
  kg_node: { scope: 'engram:read', risk: 'read' },
  kg_neighbors: { scope: 'engram:read', risk: 'read' },
  kg_search: { scope: 'engram:read', risk: 'read' },
  kg_paths: { scope: 'engram:read', risk: 'read' },
  kg_common: { scope: 'engram:read', risk: 'read' },
  kg_subgraph: { scope: 'engram:read', risk: 'read' },
  kg_communities: { scope: 'engram:read', risk: 'read' },
  kg_community: { scope: 'engram:read', risk: 'read' },
  kg_bridges: { scope: 'engram:read', risk: 'read' },
  kg_central: { scope: 'engram:read', risk: 'read' },
  engram_recall: { scope: 'engram:read', risk: 'read' },
  engram_gx460_recall: { scope: 'engram:read', risk: 'read' },
  engram_corpora: { scope: 'engram:read', risk: 'read' },
  engram_corpus_route: { scope: 'engram:read', risk: 'read' },
  engram_corpus_recall: { scope: 'engram:read', risk: 'read' },
  engram_x1c_recall: { scope: 'engram:read', risk: 'read' },
  engram_explain: { scope: 'engram:read', risk: 'read' },
  engram_contradiction_queue: { scope: 'engram:read', risk: 'read' },
  engram_profile: { scope: 'engram:read', risk: 'read' },
  engram_status: { scope: 'engram:read', risk: 'read' },
  kg_create_node: { scope: 'engram:write', risk: 'write' },
  kg_annotate_node: { scope: 'engram:write', risk: 'write' },
  kg_add_link: { scope: 'engram:write', risk: 'write' },
  engram_detect_contradictions: { scope: 'engram:write', risk: 'write' },
  engram_resolve_contradiction: { scope: 'engram:write', risk: 'write' },
  engram_remember: { scope: 'engram:write', risk: 'write' },
  engram_memory_promote: { scope: 'engram:write', risk: 'write' },
  engram_memory_reject: { scope: 'engram:write', risk: 'write' },
  engram_improve: { scope: 'engram:write', risk: 'write' },
  engram_forget: { scope: 'engram:delete', risk: 'destructive' },
  engram_erase: { scope: 'engram:delete', risk: 'destructive' },
  engram_export: { scope: 'engram:export', risk: 'external' },
  engram_consent_status: { scope: 'engram:consent', risk: 'read' },
  engram_consent_update: { scope: 'engram:consent', risk: 'write' },
  engram_retention_plan: { scope: 'engram:admin', risk: 'admin' },
  engram_retention_apply: { scope: 'engram:admin', risk: 'admin' },
  engram_backup_create: { scope: 'engram:admin', risk: 'admin' },
  engram_backup_restore: { scope: 'engram:admin', risk: 'admin' },
  engram_backup_rotate: { scope: 'engram:admin', risk: 'admin' },
  kg_index: { scope: 'engram:admin', risk: 'admin' },
});

export class ToolAuthorizer {
  private readonly now: () => number;
  private readonly grantMaxAgeSeconds: number;
  private readonly clockSkewSeconds: number;
  private readonly rules: Readonly<Record<string, ToolRule>>;

  constructor(private readonly options: ToolAuthorizerOptions) {
    if (options.replayKey.byteLength < 32) throw new Error('Replay HMAC key must be at least 32 bytes');
    this.now = options.now ?? (() => Date.now() / 1000);
    this.grantMaxAgeSeconds = options.grantMaxAgeSeconds ?? 120;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 30;
    this.rules = options.rules ?? DEFAULT_TOOL_RULES;
  }

  authorize(identity: VerifiedRequestIdentity, toolName: string): AuthorizationDecision {
    const rule = this.rules[toolName];
    if (!rule) return { allowed: false, reason: 'unknown_tool' };
    if (identity.authorizationVersion !== this.options.authorizationVersion) {
      return denied('stale_authorization', rule);
    }
    if (!identity.scopes.includes(rule.scope)) return denied('insufficient_scope', rule);
    if (rule.risk === 'read') return { allowed: true, reason: 'allowed', ...rule };

    const grant = identity.authorizationGrant;
    if (!grant) return denied('fresh_grant_required', rule);
    const now = this.now();
    if (grant.issuedAt > now + this.clockSkewSeconds) return denied('future_grant', rule);
    if (now - grant.issuedAt > this.grantMaxAgeSeconds + this.clockSkewSeconds) {
      return denied('stale_grant', rule);
    }

    const replayKey = createHmac('sha256', this.options.replayKey)
      .update(identity.issuer)
      .update('\0')
      .update(identity.accessContext.tenantId)
      .update('\0')
      .update(identity.accessContext.principalId)
      .update('\0')
      .update(grant.id)
      .digest('hex');
    const expiresAtMs = Math.min(
      identity.expiresAt * 1000,
      (grant.issuedAt + this.grantMaxAgeSeconds + this.clockSkewSeconds) * 1000,
    );
    if (!this.options.replayGuard.consume(replayKey, expiresAtMs, now * 1000)) {
      return denied('replay_detected', rule);
    }
    return { allowed: true, reason: 'allowed', ...rule };
  }

  ruleFor(toolName: string): ToolRule | undefined {
    return this.rules[toolName];
  }
}

function denied(reason: AuthorizationReason, rule: ToolRule): AuthorizationDecision {
  return { allowed: false, reason, requiredScope: rule.scope, risk: rule.risk };
}
