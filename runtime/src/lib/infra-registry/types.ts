import { isIP } from 'node:net';
import { z } from 'zod';

const Id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9._:-]+$/);
const StringList = z.array(z.string().min(1)).default([]);

export const HostSchema = z.object({
  id: Id,
  name: z.string().min(1),
  platform: z.enum(['macos', 'linux', 'windows', 'appliance', 'unknown']),
  role: z.string().min(1),
  address: z.string().min(1).optional(),
  ssh_alias: z.string().min(1).optional(),
  aliases: StringList,
  desired_state: z.enum(['reachable', 'offline', 'unknown']).default('reachable'),
  required_facets: z.array(z.enum(['reachability', 'inventory'])).min(1).default(['reachability']),
  notes: z.string().optional(),
});

export const ProjectSchema = z.object({
  id: Id,
  name: z.string().min(1),
  host_id: Id,
  path: z.string().min(1),
  repository: z.string().optional(),
  desired_tech: StringList,
  notes: z.string().optional(),
});

export const ServiceSchema = z.object({
  id: Id,
  name: z.string().min(1),
  host_id: Id,
  runtime: z.enum(['docker', 'launchd', 'native', 'appliance']),
  runtime_name: z.string().min(1),
  desired_state: z.enum(['running', 'loaded', 'available', 'stopped']),
  required_facets: z.array(z.enum(['runtime', 'inventory'])).min(1).default(['runtime']),
  project_id: Id.optional(),
  tech_stack: StringList,
  ttl_seconds: z.number().int().positive().default(1800),
  notes: z.string().optional(),
});

export const EndpointSchema = z.object({
  id: Id,
  name: z.string().min(1),
  service_id: Id.optional(),
  host_id: Id.optional(),
  url: z.string().url().optional(),
  domain: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(['http', 'https', 'tcp', 'dns', 'mcp']),
  required_facets: z.array(z.enum(['probe', 'route', 'listener'])).min(1).default(['probe']),
  expected_status: z.array(z.number().int().min(100).max(599)).optional(),
  expected_contains: z.string().optional(),
  forbidden_contains: z.string().optional(),
  ttl_seconds: z.number().int().positive().default(1800),
  notes: z.string().optional(),
}).refine(value => value.url || value.domain || value.port, {
  message: 'endpoint requires url, domain, or port',
});

const CollectorBase = z.object({
  id: Id,
  enabled: z.boolean().default(true),
  timeout_seconds: z.number().int().min(1).max(120).default(10),
});

export const CollectorSchema = z.discriminatedUnion('type', [
  CollectorBase.extend({
    type: z.literal('docker'),
    host_id: Id,
  }),
  CollectorBase.extend({
    type: z.literal('launchd'),
    host_id: Id,
    include_label_pattern: z.string().default('^(com\\.jeremyshank|com\\.rehoboam|com\\.hermes|com\\.openclaw|com\\.alfred|com\\.knowledge-graph)'),
  }),
  CollectorBase.extend({
    type: z.literal('npm_routes'),
    host_id: Id,
    database_path: z.string().min(1),
  }),
  CollectorBase.extend({
    type: z.literal('projects'),
    host_id: Id,
  }),
  CollectorBase.extend({
    type: z.literal('endpoints'),
    concurrency: z.number().int().min(1).max(32).default(8),
  }),
  CollectorBase.extend({
    type: z.literal('unifi'),
    host_id: Id,
    base_url: z.string().url(),
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('UNIFI_API_KEY'),
    site_id: Id.optional(),
    site_name: z.string().min(1).optional(),
    page_limit: z.number().int().min(1).max(200).default(100),
    tls_ca_path: z.string().min(1).optional(),
    tls_servername: z.string().min(1).refine(value => isIP(value) === 0, 'TLS server name must be a DNS hostname').optional(),
  }),
  CollectorBase.extend({
    type: z.literal('tailscale'),
  }),
]);

export const DesiredRegistrySchema = z.object({
  schema_version: z.literal(1),
  name: z.string().min(1),
  hosts: z.array(HostSchema),
  projects: z.array(ProjectSchema).default([]),
  services: z.array(ServiceSchema).default([]),
  endpoints: z.array(EndpointSchema).default([]),
  collectors: z.array(CollectorSchema).default([]),
});

export type HostDefinition = z.infer<typeof HostSchema>;
export type ProjectDefinition = z.infer<typeof ProjectSchema>;
export type ServiceDefinition = z.infer<typeof ServiceSchema>;
export type EndpointDefinition = z.infer<typeof EndpointSchema>;
export type CollectorDefinition = z.infer<typeof CollectorSchema>;
export type DesiredRegistry = z.infer<typeof DesiredRegistrySchema>;

export type EntityType = 'host' | 'project' | 'service' | 'endpoint';
export type ObservationFacet = 'reachability' | 'inventory' | 'runtime' | 'route' | 'probe' | 'listener';
export type ObservationState = 'healthy' | 'running' | 'loaded' | 'stopped' | 'failed' | 'missing' | 'unknown';

export interface ObservationInput {
  entityType: EntityType;
  entityId: string;
  facet: ObservationFacet;
  state: ObservationState;
  hostId?: string;
  observedAt?: string;
  ttlSeconds?: number;
  data?: Record<string, unknown>;
  error?: string;
}

export interface StoredObservation {
  id: number;
  run_id: string;
  collector_id: string;
  entity_type: EntityType;
  entity_id: string;
  facet: ObservationFacet;
  state: ObservationState;
  host_id: string | null;
  observed_at: string;
  expires_at: string;
  data: Record<string, unknown>;
  evidence_sha256: string;
  error: string | null;
}

export type ReconciliationState = 'healthy' | 'degraded' | 'missing' | 'unexpected' | 'unmanaged' | 'stale' | 'unknown';

export interface ReconciliationItem {
  entity_type: EntityType;
  entity_id: string;
  name: string;
  state: ReconciliationState;
  desired: Record<string, unknown> | null;
  observations: StoredObservation[];
  reasons: string[];
  verification_commands: string[];
}

export interface RegistryStatus {
  generated_at: string;
  config_revision: string | null;
  summary: Record<ReconciliationState, number>;
  items: ReconciliationItem[];
}
