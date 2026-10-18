import { writeFileSync } from 'fs';
import { resolveConfig } from '../src/lib/config.js';
import { Store } from '../src/lib/store.js';
import { accessContextFromEnv } from '../src/lib/access-context.js';
import { renderEngramAgentProfile } from '../src/lib/engram/profile-document.js';

const config = resolveConfig({});
const store = new Store(config.dbPath, accessContextFromEnv());
const content = renderEngramAgentProfile(store.db);
store.close();

const outputPath = process.argv[2] || '/dev/stdout';
writeFileSync(outputPath, content, 'utf-8');
console.log(`engram-profile: ${content.split('\n').length} lines -> ${outputPath}`);
