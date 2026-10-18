export const SECURITY_SCHEMA_VERSION = 3;
export const SECURITY_POLICY_VERSION = 'engram-security-v1';

export interface AccessContext {
  tenantId: string;
  principalId: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateAccessContext(context: AccessContext | undefined): AccessContext {
  if (!context) throw new Error('Access context is required');
  const tenantId = validateIdentifier('tenantId', context.tenantId);
  const principalId = validateIdentifier('principalId', context.principalId);
  return Object.freeze({ tenantId, principalId });
}

export function accessContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AccessContext {
  return validateAccessContext({
    tenantId: env.ENGRAM_TENANT_ID ?? '',
    principalId: env.ENGRAM_PRINCIPAL_ID ?? '',
  });
}

function validateIdentifier(field: string, value: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`${field} must be a non-empty opaque identifier using only letters, numbers, dot, colon, underscore, or hyphen`);
  }
  return value;
}
