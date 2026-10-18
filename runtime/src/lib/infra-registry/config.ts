import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesiredRegistrySchema, type DesiredRegistry } from './types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(MODULE_DIR, '../../..');

export interface RegistryPaths {
  desiredPath: string;
  dbPath: string;
  snapshotDir: string;
  bootstrapSnapshotPath: string;
}

export function resolveRegistryPaths(overrides: Partial<RegistryPaths> = {}): RegistryPaths {
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dataDir = process.env.INFRA_REGISTRY_DATA_DIR ?? join(xdgData, 'engram');
  const snapshotDir = overrides.snapshotDir
    ?? process.env.INFRA_REGISTRY_SNAPSHOT_DIR
    ?? join(dataDir, 'bootstrap');
  return {
    desiredPath: overrides.desiredPath
      ?? process.env.INFRA_REGISTRY_DESIRED
      ?? join(REPO_ROOT, 'registry', 'desired.json'),
    dbPath: overrides.dbPath
      ?? process.env.INFRA_REGISTRY_DB
      ?? join(dataDir, 'infra-registry.db'),
    snapshotDir,
    bootstrapSnapshotPath: overrides.bootstrapSnapshotPath
      ?? process.env.ENGRAM_BOOTSTRAP_SNAPSHOT
      ?? join(snapshotDir, 'global.json'),
  };
}

export function loadDesiredRegistry(path: string): { registry: DesiredRegistry; revision: string; path: string } {
  const raw = readFileSync(path, 'utf-8');
  const registry = DesiredRegistrySchema.parse(JSON.parse(raw));
  validateReferences(registry);
  return {
    registry,
    revision: createHash('sha256').update(raw).digest('hex'),
    path,
  };
}

function validateReferences(registry: DesiredRegistry): void {
  assertUnique('host', registry.hosts.map(item => item.id));
  assertUnique('project', registry.projects.map(item => item.id));
  assertUnique('service', registry.services.map(item => item.id));
  assertUnique('endpoint', registry.endpoints.map(item => item.id));
  assertUnique('collector', registry.collectors.map(item => item.id));

  const hosts = new Set(registry.hosts.map(item => item.id));
  const projects = new Set(registry.projects.map(item => item.id));
  const services = new Set(registry.services.map(item => item.id));
  for (const project of registry.projects) {
    if (!hosts.has(project.host_id)) throw new Error(`Project ${project.id} references unknown host ${project.host_id}`);
  }
  for (const service of registry.services) {
    if (!hosts.has(service.host_id)) throw new Error(`Service ${service.id} references unknown host ${service.host_id}`);
    if (service.project_id && !projects.has(service.project_id)) {
      throw new Error(`Service ${service.id} references unknown project ${service.project_id}`);
    }
  }
  for (const endpoint of registry.endpoints) {
    if (endpoint.host_id && !hosts.has(endpoint.host_id)) {
      throw new Error(`Endpoint ${endpoint.id} references unknown host ${endpoint.host_id}`);
    }
    if (endpoint.service_id && !services.has(endpoint.service_id)) {
      throw new Error(`Endpoint ${endpoint.id} references unknown service ${endpoint.service_id}`);
    }
  }
  for (const collector of registry.collectors) {
    if ('host_id' in collector && !hosts.has(collector.host_id)) {
      throw new Error(`Collector ${collector.id} references unknown host ${collector.host_id}`);
    }
  }
}

function assertUnique(kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${kind} id: ${id}`);
    seen.add(id);
  }
}
