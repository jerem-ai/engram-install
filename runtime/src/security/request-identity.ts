import type { RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { validateAccessContext, type AccessContext } from '../lib/access-context.js';

const IDENTITY_MARKER = 'engramVerifiedIdentity';
const OPAQUE_VALUE = /^[\x21-\x7e]{1,256}$/;

export interface AuthorizationGrant {
  id: string;
  issuedAt: number;
}

export interface VerifiedRequestIdentity {
  accessContext: AccessContext;
  issuer: string;
  resource: string;
  clientId: string;
  scopes: readonly string[];
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
  authorizationVersion: string;
  authorizationGrant?: AuthorizationGrant;
}

export interface AudienceBoundVerifierOptions {
  verifier: OAuthTokenVerifier;
  issuer: URL;
  resource: URL;
  authorizationVersion: string;
  maxTokenAgeSeconds?: number;
  clockSkewSeconds?: number;
  now?: () => number;
}

interface VerifiedTokenExtra extends Record<string, unknown> {
  issuer: string;
  tenantId: string;
  principalId: string;
  tokenId: string;
  issuedAt: number;
  authorizationVersion: string;
  authorizationId?: string;
  authorizationIssuedAt?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthInfo;
    securityIdentity?: VerifiedRequestIdentity;
  }
}

/**
 * Validates resource-server claims returned by a cryptographic or introspection
 * verifier. Identity is accepted only from the verifier result; request headers,
 * bodies, MCP arguments, memory, and frontmatter are never consulted.
 */
export class AudienceBoundTokenVerifier implements OAuthTokenVerifier {
  private readonly issuer: string;
  private readonly resource: string;
  private readonly now: () => number;
  private readonly maxTokenAgeSeconds: number;
  private readonly clockSkewSeconds: number;

  constructor(private readonly options: AudienceBoundVerifierOptions) {
    this.issuer = canonicalUrl(options.issuer, 'issuer');
    this.resource = canonicalUrl(options.resource, 'resource');
    this.now = options.now ?? (() => Date.now() / 1000);
    this.maxTokenAgeSeconds = positive(options.maxTokenAgeSeconds ?? 300, 'max token age');
    this.clockSkewSeconds = nonNegative(options.clockSkewSeconds ?? 30, 'clock skew');
    opaque('authorizationVersion', options.authorizationVersion);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const authInfo = await this.options.verifier.verifyAccessToken(token);
    const now = this.now();
    const extra = verifiedExtra(authInfo.extra);
    const resource = authInfo.resource
      ? canonicalUrl(authInfo.resource, 'token resource')
      : '';

    if (resource !== this.resource) throw new Error('Token audience is invalid');
    if (canonicalUrl(new URL(extra.issuer), 'token issuer') !== this.issuer) {
      throw new Error('Token issuer is invalid');
    }
    if (extra.authorizationVersion !== this.options.authorizationVersion) {
      throw new Error('Token authorization state is stale');
    }
    if (!Number.isFinite(authInfo.expiresAt)) throw new Error('Token expiration is required');
    if (authInfo.expiresAt! <= now - this.clockSkewSeconds) throw new Error('Token is expired');
    if (!Number.isFinite(extra.issuedAt)) throw new Error('Token issue time is required');
    if (extra.issuedAt > now + this.clockSkewSeconds) throw new Error('Token issue time is in the future');
    if (now - extra.issuedAt > this.maxTokenAgeSeconds + this.clockSkewSeconds) {
      throw new Error('Token is stale');
    }

    const accessContext = validateAccessContext({
      tenantId: extra.tenantId,
      principalId: extra.principalId,
    });
    const scopes = Object.freeze(normalizeScopes(authInfo.scopes));
    const identity: VerifiedRequestIdentity = Object.freeze({
      accessContext,
      issuer: this.issuer,
      resource: this.resource,
      clientId: opaque('clientId', authInfo.clientId),
      scopes,
      tokenId: opaque('tokenId', extra.tokenId),
      issuedAt: extra.issuedAt,
      expiresAt: authInfo.expiresAt!,
      authorizationVersion: extra.authorizationVersion,
      authorizationGrant: grantFrom(extra),
    });

    return {
      ...authInfo,
      scopes: [...scopes],
      resource: new URL(this.resource),
      extra: { [IDENTITY_MARKER]: identity },
    };
  }
}

export interface AuthenticationMiddlewareOptions {
  verifier: OAuthTokenVerifier;
  resourceMetadataUrl: string;
  onDenied?: () => void;
}

/** Require and verify a bearer token on every protected HTTP request. */
export function requireVerifiedIdentity(options: AuthenticationMiddlewareOptions): RequestHandler {
  return async (req, res, next) => {
    try {
      if ('access_token' in req.query) throw new Error('Query-string tokens are forbidden');
      const header = req.header('authorization');
      if (!header) throw new Error('Missing bearer token');
      const match = /^Bearer ([^\s]+)$/.exec(header);
      if (!match) throw new Error('Malformed bearer token');
      const authInfo = await options.verifier.verifyAccessToken(match[1]);
      const identity = verifiedIdentityFromAuthInfo(authInfo);
      req.auth = authInfo;
      req.securityIdentity = identity;
      next();
    } catch {
      options.onDenied?.();
      res.set('WWW-Authenticate', `Bearer resource_metadata="${options.resourceMetadataUrl}"`);
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}

export function verifiedIdentityFromAuthInfo(authInfo: AuthInfo | undefined): VerifiedRequestIdentity {
  const value = authInfo?.extra?.[IDENTITY_MARKER];
  if (!value || typeof value !== 'object') throw new Error('Verified request identity is missing');
  return value as VerifiedRequestIdentity;
}

export function identityBinding(identity: VerifiedRequestIdentity): string {
  return [
    identity.issuer,
    identity.resource,
    identity.clientId,
    identity.accessContext.tenantId,
    identity.accessContext.principalId,
    identity.authorizationVersion,
  ].join('\u001f');
}

function verifiedExtra(value: Record<string, unknown> | undefined): VerifiedTokenExtra {
  if (!value) throw new Error('Verified token identity claims are missing');
  return value as VerifiedTokenExtra;
}

function grantFrom(extra: VerifiedTokenExtra): AuthorizationGrant | undefined {
  const hasId = extra.authorizationId !== undefined;
  const hasIssuedAt = extra.authorizationIssuedAt !== undefined;
  if (!hasId && !hasIssuedAt) return undefined;
  if (!hasId || !hasIssuedAt || !Number.isFinite(extra.authorizationIssuedAt)) {
    throw new Error('Authorization grant claims are incomplete');
  }
  return Object.freeze({
    id: opaque('authorizationId', extra.authorizationId!),
    issuedAt: extra.authorizationIssuedAt!,
  });
}

function normalizeScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes)) throw new Error('Token scopes are invalid');
  return [...new Set(scopes.map(scope => opaque('scope', scope)))].sort();
}

function canonicalUrl(url: URL, label: string): string {
  if (url.hash || url.search || url.username || url.password) {
    throw new Error(`${label} URL must not contain credentials, query, or fragment`);
  }
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new Error(`${label} URL must use HTTPS outside loopback tests`);
  }
  return url.href;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function opaque(label: string, value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_VALUE.test(value)) {
    throw new Error(`${label} must be a non-empty opaque value without whitespace or control characters`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must not be negative`);
  return value;
}
