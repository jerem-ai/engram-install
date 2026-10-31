export interface StatementContext {
  kind: string;
  scope: string;
  review: 'unreviewed';
}
export function statementContext(frontmatter: unknown): StatementContext;
export function statementContextLabel(frontmatter: unknown): string;
