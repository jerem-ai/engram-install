import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from '../lib/config.js';
import { readEngramEnv } from '../lib/install-config.js';
import { accessContextFromEnv } from '../lib/access-context.js';
import { createMemoryAdmissionService } from '../lib/engram/admission-key.js';
import {
  createLocalOperatorIdentity,
  createReviewAuthorizer,
} from '../lib/engram/local-identity.js';
import { createCodexEngramServer } from './codex-engram-server.js';

async function main(): Promise<void> {
  const config = resolveConfig({});
  const accessContext = accessContextFromEnv();
  const authorizer = createReviewAuthorizer(config.dataDir);
  const server = createCodexEngramServer({
    submitter: 'claude-code',
    accessContext,
    dbPath: config.dbPath,
    vaultPath: config.vaultPath,
    memoryAdmission: createMemoryAdmissionService(config.dataDir, { authorizer }),
    authorizer,
    identityFactory: () => createLocalOperatorIdentity(accessContext),
    // Per-install setting only; with no engram.env the reads cite admitted sources.
    readAdmission: readEngramEnv().ENGRAM_MCP_ADMISSION === 'legacy' ? 'legacy' : 'admitted',
  });
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
