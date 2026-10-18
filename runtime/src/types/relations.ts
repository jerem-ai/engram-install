export const RELATION_TYPES = new Set([
  'authored_by',
  'works_on',
  'depends_on',
  'replaces',
  'blocks',
  'relates_to',
  'implements',
  'uses',
  'owns',
  'verified_by',
  'mentions',
  'stale_since',
]);

export const DEFAULT_RELATION = 'relates_to';

export function isKnownRelationType(value: string, extra?: ReadonlySet<string>): boolean {
  return RELATION_TYPES.has(value) || (extra?.has(value) ?? false);
}
