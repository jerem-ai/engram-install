import type {
  EndpointDefinition,
  EntityType,
  ReconciliationItem,
  RegistryStatus,
  ReconciliationState,
  ServiceDefinition,
  StoredObservation,
} from './types.js';
import type { InfraRegistryStore } from './store.js';

export function reconcileRegistry(store: InfraRegistryStore, now = new Date()): RegistryStatus {
  const observations = store.latestObservations();
  const byEntity = new Map<string, StoredObservation[]>();
  for (const observation of observations) {
    const key = entityKey(observation.entity_type, observation.entity_id);
    const list = byEntity.get(key) ?? [];
    list.push(observation);
    byEntity.set(key, list);
  }

  const items: ReconciliationItem[] = [];
  const desiredKeys = new Set<string>();
  for (const service of store.getServices()) {
    desiredKeys.add(entityKey('service', service.id));
    items.push(reconcileService(service, byEntity.get(entityKey('service', service.id)) ?? [], now));
  }
  for (const endpoint of store.getEndpoints()) {
    desiredKeys.add(entityKey('endpoint', endpoint.id));
    items.push(reconcileEndpoint(endpoint, byEntity.get(entityKey('endpoint', endpoint.id)) ?? [], now));
  }
  for (const project of store.getProjects()) {
    desiredKeys.add(entityKey('project', project.id));
    const entityObservations = byEntity.get(entityKey('project', project.id)) ?? [];
    items.push(reconcileGeneric('project', project.id, project.name, project, ['inventory'], entityObservations, now));
  }
  for (const host of store.getHosts()) {
    const key = entityKey('host', host.id);
    desiredKeys.add(key);
    const entityObservations = byEntity.get(key) ?? [];
    if (entityObservations.length > 0) {
      items.push(reconcileGeneric('host', host.id, host.name, host, host.required_facets ?? ['reachability'], entityObservations, now));
    }
  }

  for (const [key, entityObservations] of byEntity) {
    if (desiredKeys.has(key)) continue;
    const [entityType, ...idParts] = key.split('\0');
    const entityId = idParts.join('\0');
    items.push({
      entity_type: entityType as EntityType,
      entity_id: entityId,
      name: String(entityObservations[0]?.data.name ?? entityId),
      state: 'unmanaged',
      desired: null,
      observations: entityObservations,
      reasons: ['Observed but not declared in desired state'],
      verification_commands: verificationCommands(entityObservations),
    });
  }

  items.sort((a, b) => severity(a.state) - severity(b.state) || a.entity_id.localeCompare(b.entity_id));
  const summary: Record<ReconciliationState, number> = {
    healthy: 0,
    degraded: 0,
    missing: 0,
    unexpected: 0,
    unmanaged: 0,
    stale: 0,
    unknown: 0,
  };
  for (const item of items) summary[item.state] += 1;
  return {
    generated_at: now.toISOString(),
    config_revision: store.getMetadata('config_revision'),
    summary,
    items,
  };
}

function reconcileService(service: ServiceDefinition, observations: StoredObservation[], now: Date): ReconciliationItem {
  const requiredFacets = service.required_facets ?? ['runtime'];
  const runtime = observations.filter(item => requiredFacets.includes(item.facet as 'runtime' | 'inventory'));
  const fresh = runtime.filter(item => !isStale(item, now));
  const states = new Set(fresh.map(item => item.state));
  let state: ReconciliationState = 'unknown';
  const reasons: string[] = [];
  if (runtime.length === 0) reasons.push('No runtime observation has been recorded');
  else if (fresh.length === 0) {
    state = 'stale';
    reasons.push('Latest runtime observation is stale');
  } else if (service.desired_state === 'stopped') {
    state = states.has('stopped') ? 'healthy' : 'degraded';
    reasons.push(state === 'healthy' ? 'Service is stopped as declared' : 'Service is running but desired state is stopped');
  } else if (service.desired_state === 'loaded') {
    if (states.has('running') || states.has('loaded')) {
      state = 'healthy';
      reasons.push('Scheduled service is loaded');
    } else if (states.has('failed')) {
      state = 'degraded';
      reasons.push('Scheduled service is loaded but its last run failed');
    } else {
      state = 'missing';
      reasons.push('Scheduled service is not loaded');
    }
  } else {
    state = states.has('running') || states.has('healthy') ? 'healthy' : states.has('failed') ? 'degraded' : 'missing';
    reasons.push(state === 'healthy' ? 'Runtime state matches desired state' : `Desired ${service.desired_state}; observed ${[...states].join(', ') || 'none'}`);
  }
  return item('service', service.id, service.name, service, state, observations, reasons);
}

function reconcileEndpoint(endpoint: EndpointDefinition, observations: StoredObservation[], now: Date): ReconciliationItem {
  const reasons: string[] = [];
  let state: ReconciliationState = 'healthy';
  for (const facet of endpoint.required_facets) {
    const facetObservations = observations.filter(item => item.facet === facet);
    const fresh = facetObservations.filter(item => !isStale(item, now));
    if (facetObservations.length === 0) {
      state = state === 'healthy' ? 'unknown' : state;
      reasons.push(`No ${facet} observation has been recorded`);
      continue;
    }
    if (fresh.length === 0) {
      state = 'stale';
      reasons.push(`${facet} observation is stale`);
      continue;
    }
    if (!fresh.some(item => item.state === 'healthy' || item.state === 'running' || item.state === 'loaded')) {
      state = 'degraded';
      reasons.push(`${facet} check is not healthy`);
    }
  }
  if (reasons.length === 0) reasons.push('All required endpoint facets are healthy and fresh');
  return item('endpoint', endpoint.id, endpoint.name, endpoint, state, observations, reasons);
}

function reconcileGeneric(
  entityType: EntityType,
  id: string,
  name: string,
  desired: Record<string, unknown>,
  facets: string[],
  observations: StoredObservation[],
  now: Date,
): ReconciliationItem {
  const relevant = observations.filter(item => facets.includes(item.facet));
  let state: ReconciliationState;
  const reasons: string[] = [];
  if (relevant.length === 0) {
    state = 'unknown';
    reasons.push(`No ${facets.join('/')} observation has been recorded`);
  } else if (relevant.every(item => isStale(item, now))) {
    state = 'stale';
    reasons.push('Latest observation is stale');
  } else if (relevant.some(item => item.state === 'failed' || item.state === 'missing')) {
    state = 'degraded';
    reasons.push('A required observation failed');
  } else {
    state = 'healthy';
    reasons.push('Required observation is healthy and fresh');
  }
  return item(entityType, id, name, desired, state, observations, reasons);
}

function item(
  entityType: EntityType,
  id: string,
  name: string,
  desired: object,
  state: ReconciliationState,
  observations: StoredObservation[],
  reasons: string[],
): ReconciliationItem {
  return {
    entity_type: entityType,
    entity_id: id,
    name,
    state,
    desired: desired as Record<string, unknown>,
    observations,
    reasons,
    verification_commands: verificationCommands(observations),
  };
}

function verificationCommands(observations: StoredObservation[]): string[] {
  const commands = new Set<string>();
  for (const observation of observations) {
    const command = observation.data.verification_command;
    if (typeof command === 'string' && command.length > 0) commands.add(command);
  }
  return [...commands];
}

function isStale(observation: StoredObservation, now: Date): boolean {
  return Date.parse(observation.expires_at) < now.getTime();
}

function entityKey(type: EntityType, id: string): string {
  return `${type}\0${id}`;
}

function severity(state: ReconciliationState): number {
  return ({ degraded: 0, missing: 1, stale: 2, unknown: 3, unexpected: 4, unmanaged: 5, healthy: 6 })[state];
}
