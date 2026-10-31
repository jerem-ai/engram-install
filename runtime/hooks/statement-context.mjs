// Descriptive model annotations only. Never infer an instruction from prose.
const kinds = new Set(['fact', 'preference', 'standing_instruction', 'advice', 'task_request', 'unknown']);
const scopes = new Set(['task', 'project', 'portable', 'unknown']);

export function statementContext(frontmatter) {
  const value = frontmatter?.metadata?.statement_context;
  if (!value || !kinds.has(value.kind) || !scopes.has(value.scope)
      || value.review !== 'unreviewed') {
    return { kind: 'unknown', scope: 'unknown', review: 'unreviewed' };
  }
  return { kind: value.kind, scope: value.scope, review: 'unreviewed' };
}

export function statementContextLabel(frontmatter) {
  const value = statementContext(frontmatter);
  if (value.kind === 'unknown') return 'statement kind and scope unknown';
  return `${value.kind.replaceAll('_', ' ')}; scope ${value.scope}; unreviewed`;
}
