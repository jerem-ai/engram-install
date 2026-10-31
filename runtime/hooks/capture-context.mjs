/** Current capture eligibility for a recall turn. Failure skips recall and keeps coding usable. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readEngramEnv } from './engram-env.mjs';

const configuredPath = (conf) => process.env.ENGRAM_CAPTURE_POLICY || readEngramEnv().ENGRAM_CAPTURE_POLICY || conf.ENGRAM_CAPTURE_POLICY;
const defaultPath = () => path.join(os.homedir(), '.config/engram/capture-policy.json');
const defaultPresent = () => {
  try { fs.lstatSync(defaultPath()); return true; } catch (error) { return error.code !== 'ENOENT'; }
};
const denied = { allowedNow: () => false, filterResults: () => [] };

async function observe(runtime, cwd) {
  const controller = new AbortController();
  const { signal } = controller;
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, 100);
  });
  const request = (async () => {
    let fd;
    try {
      const mod = await import(pathToFileURL(path.join(runtime, 'dist/lib/project-identity.js')).href);
      signal.throwIfAborted();
      let config;
      try {
        fd = await fs.promises.open(path.join(os.homedir(), '.config/engram/project-identity.json'),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        signal.throwIfAborted();
        const info = await fd.stat();
        if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid() || (info.mode & 0o022)) return null;
        const bytes = Buffer.alloc(65537);
        let size = 0;
        while (size < bytes.length) {
          signal.throwIfAborted();
          const { bytesRead } = await fd.read(bytes, size, bytes.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 65536) return null;
        config = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
      } catch (error) { if (error.code !== 'ENOENT') return null; }
      signal.throwIfAborted();
      const observation = await mod.observeRepositoryAsync(cwd, undefined, signal);
      signal.throwIfAborted();
      const identity = mod.resolveProjectIdentity(observation, config);
      const canonicalCwd = await fs.promises.realpath(cwd);
      signal.throwIfAborted();
      return { identity, cwd: canonicalCwd };
    } catch { return null; }
    finally { if (fd) await fd.close(); }
  })();
  try { return await Promise.race([request, deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function recallCaptureContext(event, source, runtime, conf) {
  const configured = configuredPath(conf);
  if (!configured && !defaultPresent()) {
    // Preserve the existing no-policy path without starting Git or a worker.
    const unchanged = () => !configuredPath(conf) && !defaultPresent();
    return { allowedNow: unchanged, filterResults: results => unchanged() ? results : [] };
  }
  try {
    const mod = await import(pathToFileURL(path.join(runtime, 'dist/lib/capture-policy.js')).href);
    const read = () => mod.readCapturePolicy(configuredPath(conf));
    const initial = read();
    if (initial.state === 'invalid') return denied;
    let binding = null;
    if (!mod.captureDecision(initial, null).allowed) {
      if (typeof event?.cwd !== 'string' || !mod.validCapturePath(event.cwd)
        || typeof event?.session_id !== 'string' || !event.session_id) return denied;
      const observed = await observe(runtime, event.cwd);
      if (!observed || observed.identity?.status !== 'verified') return denied;
      const id = source === 'claude' ? 'claude-code' : source;
      const sid = event.session_id.startsWith(id + ':') ? event.session_id : id + ':' + event.session_id;
      const paths = [observed.cwd];
      if (event.transcript_path) {
        if (!mod.validCapturePath(event.transcript_path)) return denied;
        paths.push(mod.canonicalCapturePath(event.transcript_path));
      }
      binding = { source_id: sid, revision: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
        project_id: observed.identity.project_id, worktree_id: observed.identity.worktree_id,
        paths, complete: true, identity_fingerprint: observed.identity.config_fingerprint };
      if (!mod.captureSourceValid(binding)) return denied;
    }
    const bindings = binding ? [binding] : [];
    // Codex's extractor watermark uses the rollout filename; its hook names the
    // native session UUID. Preserve both existing identifiers as dependencies.
    if (binding && source === 'codex' && event.transcript_path?.endsWith('.jsonl')) {
      const alias = 'codex:' + path.basename(event.transcript_path, '.jsonl');
      if (alias !== binding.source_id) bindings.push({ ...binding, source_id: alias });
      if (!bindings.every(mod.captureSourceValid)) return denied;
    }
    const current = () => {
      const snapshot = read();
      // Hooks do not have a complete file-access trace. A nested exclusion can
      // affect an implicit query or its prior-turn context, so withhold the turn.
      const overlap = binding && snapshot.policy?.exclude_paths.some(root => binding.paths.some(p =>
        root === '/' || p === root || p.startsWith(root + '/') || root.startsWith(p + '/')));
      return { snapshot, allowed: !overlap && (bindings.length ? bindings.every(s => mod.captureDecision(snapshot, s).allowed) : mod.captureDecision(snapshot, null).allowed) };
    };
    return { allowedNow: () => current().allowed,
      filterResults: results => {
        const { snapshot, allowed } = current();
        return allowed ? results.filter(r => mod.captureArtifactAllowed(snapshot, r?.frontmatter)) : [];
      } };
  } catch { return denied; }
}
