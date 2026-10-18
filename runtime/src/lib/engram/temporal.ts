export type TemporalClassification = 'derived' | 'ambiguous' | 'invalid' | 'unresolved';

export type TemporalReasonCode =
  | 'ASSERTION_VALID_FROM'
  | 'ASSERTION_VALID_FROM_CONFLICT'
  | 'ASSERTION_VALID_FROM_INVALID'
  | 'EPISODE_OBSERVED_AT_SOURCE_CREATED'
  | 'EPISODE_OBSERVED_AT_SOURCE_DATE'
  | 'EPISODE_OBSERVED_AT_SOURCE_STARTED_AT'
  | 'EPISODE_OBSERVED_AT_RECORDED_PROVENANCE'
  | 'EPISODE_OBSERVED_AT_INVALID'
  | 'EPISODE_SOURCE_TIMESTAMP_MISMATCH'
  | 'EPISODE_TIMESTAMP_UNVERIFIED'
  | 'SOURCE_CREATED'
  | 'SOURCE_DATE'
  | 'SOURCE_STARTED_AT'
  | 'SOURCE_TIMESTAMP_INVALID'
  | 'NO_TEMPORAL_EVIDENCE'
  | 'SOURCE_FRONTMATTER_INVALID'
  | 'EXISTING_VALID_FROM_INVALID';

export interface TemporalProvenance {
  kind: 'assertion' | 'episode' | 'source';
  field: string;
  raw: string;
  normalized: string;
}

export interface TemporalDerivation {
  classification: TemporalClassification;
  reason_code: TemporalReasonCode;
  valid_from: string | null;
  provenance: TemporalProvenance[];
  detail?: string;
}

export interface AssertionTemporalEvidence {
  explicitValidFrom?: unknown[];
  episode?: {
    observedAt: unknown;
    provenance?: unknown;
  } | null;
  sourceFrontmatter?: Record<string, unknown> | null;
}

export class InvalidTemporalValueError extends Error {
  readonly reasonCode: 'ASSERTION_VALID_FROM_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidTemporalValueError';
    this.reasonCode = 'ASSERTION_VALID_FROM_INVALID';
  }
}

export class MissingTemporalProvenanceError extends Error {
  readonly reasonCode = 'NO_TEMPORAL_EVIDENCE' as const;

  constructor() {
    super('valid_from requires explicit, episode-backed, or source-backed temporal provenance');
    this.name = 'MissingTemporalProvenanceError';
  }
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

export function normalizeTemporalInstant(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidTemporalValueError('timestamp must be a string');
  }
  const raw = value.trim();
  const match = ISO_INSTANT.exec(raw);
  if (!match) {
    throw new InvalidTemporalValueError('timestamp must be ISO 8601 with seconds and an explicit timezone');
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new InvalidTemporalValueError('timestamp contains an out-of-range date or time component');
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    throw new InvalidTemporalValueError('timestamp contains an impossible calendar date');
  }
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.includes(':') ? zone.slice(4, 6) : zone.slice(3, 5));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) {
      throw new InvalidTemporalValueError('timestamp contains an invalid timezone offset');
    }
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new InvalidTemporalValueError('timestamp is not parseable');
  }
  return new Date(parsed).toISOString();
}

export function deriveAssertionValidFrom(evidence: AssertionTemporalEvidence): TemporalDerivation {
  const frontmatter = evidence.sourceFrontmatter ?? {};
  const explicit = evidence.explicitValidFrom ?? [];
  if (explicit.length > 0) {
    const parsed = parseCandidates(explicit, 'assertion.valid_from', 'assertion');
    if (parsed.invalid) {
      return result('invalid', 'ASSERTION_VALID_FROM_INVALID', parsed.provenance, parsed.invalid);
    }
    const distinct = new Set(parsed.provenance.map(item => item.normalized));
    if (distinct.size !== 1) {
      return result(
        'ambiguous',
        'ASSERTION_VALID_FROM_CONFLICT',
        parsed.provenance,
        'matching assertion blocks contain different valid_from values',
      );
    }
    return result('derived', 'ASSERTION_VALID_FROM', parsed.provenance);
  }

  const source = selectSourceTimestamp(frontmatter);
  if (source.invalid) {
    return result('invalid', 'SOURCE_TIMESTAMP_INVALID', source.provenance, source.invalid);
  }

  if (evidence.episode) {
    let observedAt: string;
    try {
      observedAt = normalizeTemporalInstant(evidence.episode.observedAt);
    } catch (error) {
      return result(
        'invalid',
        'EPISODE_OBSERVED_AT_INVALID',
        [],
        error instanceof Error ? error.message : 'episode observed_at is invalid',
      );
    }

    const recorded = recordedEpisodeTimestamp(evidence.episode.provenance);
    if (recorded) {
      if (recorded.normalized !== observedAt) {
        return result(
          'ambiguous',
          'EPISODE_SOURCE_TIMESTAMP_MISMATCH',
          [recorded, provenance('episode', 'observed_at', String(evidence.episode.observedAt), observedAt)],
          'episode observed_at differs from its recorded timestamp provenance',
        );
      }
      return result('derived', 'EPISODE_OBSERVED_AT_RECORDED_PROVENANCE', [recorded]);
    }

    if (!source.value) {
      return result(
        'unresolved',
        'EPISODE_TIMESTAMP_UNVERIFIED',
        [provenance('episode', 'observed_at', String(evidence.episode.observedAt), observedAt)],
        'episode provenance does not identify a source field and the source has no timestamp',
      );
    }
    if (source.value.normalized !== observedAt) {
      return result(
        'ambiguous',
        'EPISODE_SOURCE_TIMESTAMP_MISMATCH',
        [source.value, provenance('episode', 'observed_at', String(evidence.episode.observedAt), observedAt)],
        'episode observed_at differs from the source timestamp selected by the derivation hierarchy',
      );
    }

    const reason = source.value.field === 'created'
      ? 'EPISODE_OBSERVED_AT_SOURCE_CREATED'
      : source.value.field === 'date'
        ? 'EPISODE_OBSERVED_AT_SOURCE_DATE'
        : 'EPISODE_OBSERVED_AT_SOURCE_STARTED_AT';
    return result('derived', reason, [source.value]);
  }

  if (!source.value) {
    return result('unresolved', 'NO_TEMPORAL_EVIDENCE', [], 'no assertion, episode, or source timestamp is available');
  }
  const reason = source.value.field === 'created'
    ? 'SOURCE_CREATED'
    : source.value.field === 'date'
      ? 'SOURCE_DATE'
      : 'SOURCE_STARTED_AT';
  return result('derived', reason, [source.value]);
}

function selectSourceTimestamp(frontmatter: Record<string, unknown>): {
  value?: TemporalProvenance;
  provenance: TemporalProvenance[];
  invalid?: string;
} {
  for (const field of ['created', 'date', 'started_at'] as const) {
    const raw = frontmatter[field];
    if (raw === undefined || raw === null || raw === '') continue;
    try {
      const normalized = normalizeTemporalInstant(raw);
      const item = provenance('source', field, String(raw), normalized);
      return { value: item, provenance: [item] };
    } catch (error) {
      return {
        provenance: [],
        invalid: `source ${field}: ${error instanceof Error ? error.message : 'invalid timestamp'}`,
      };
    }
  }
  return { provenance: [] };
}

function recordedEpisodeTimestamp(value: unknown): TemporalProvenance | null {
  const parsed = parseJsonObject(value);
  const temporal = parseJsonObject(parsed?.temporal);
  if (temporal?.kind !== 'source_field' || typeof temporal.field !== 'string' || typeof temporal.raw !== 'string') {
    return null;
  }
  try {
    return provenance('episode', temporal.field, temporal.raw, normalizeTemporalInstant(temporal.raw));
  } catch {
    return null;
  }
}

function parseCandidates(values: unknown[], field: string, kind: TemporalProvenance['kind']): {
  provenance: TemporalProvenance[];
  invalid?: string;
} {
  const parsed: TemporalProvenance[] = [];
  for (const value of values) {
    try {
      parsed.push(provenance(kind, field, String(value), normalizeTemporalInstant(value)));
    } catch (error) {
      return {
        provenance: parsed,
        invalid: error instanceof Error ? error.message : 'invalid timestamp',
      };
    }
  }
  return { provenance: parsed };
}

function provenance(
  kind: TemporalProvenance['kind'],
  field: string,
  raw: string,
  normalized: string,
): TemporalProvenance {
  return { kind, field, raw, normalized };
}

function result(
  classification: TemporalClassification,
  reason_code: TemporalReasonCode,
  provenanceItems: TemporalProvenance[],
  detail?: string,
): TemporalDerivation {
  return {
    classification,
    reason_code,
    valid_from: classification === 'derived' ? provenanceItems[0]?.normalized ?? null : null,
    provenance: provenanceItems,
    ...(detail ? { detail } : {}),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
