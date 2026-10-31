/** Read-only identity worker. The parent enforces a 100 ms wall-clock budget. */
import fs from 'node:fs';
import { TextDecoder } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 8192) process.exit(0);
}
let fd;
try {
  const { cwd } = JSON.parse(input);
  const mod = await import(pathToFileURL(path.join(process.argv[2], 'dist/lib/project-identity.js')).href);
  let config;
  try {
    fd = fs.openSync(path.join(os.homedir(), '.config/engram/project-identity.json'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid() || (info.mode & 0o022)) process.exit(0);
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 65536) process.exit(0);
    config = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
  } catch (error) { if (error.code !== 'ENOENT') process.exit(0); }
  const identity = mod.resolveProjectIdentity(mod.observeRepository(cwd), config);
  process.stdout.write(JSON.stringify({ identity, cwd: fs.realpathSync(cwd) }));
} catch { /* An unavailable identity withholds recall. */ }
finally { if (fd !== undefined) fs.closeSync(fd); }
