import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqlite from 'node:sqlite';

const Database = sqlite.Database || sqlite.DatabaseSync;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;

export class StoreError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT', details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const encode = value => JSON.stringify(canonical(value));

function text(value, name, max = 1024, required = false) {
  if (value === undefined || value === '') {
    if (required) throw new StoreError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new StoreError(`Invalid ${name}`);
  }
  return value;
}

function number(value, name, { required = false, integer = false, min = 0 } = {}) {
  if (value === undefined) {
    if (required) throw new StoreError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) {
    throw new StoreError(`Invalid ${name}`);
  }
  return value;
}

function strings(value, name, max = 4096) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max) throw new StoreError(`Invalid ${name}`);
  return value.map(item => text(item, name, 2048, true));
}

function dictionary(value, name) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw new StoreError(`Invalid ${name}`);
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [text(key, name, 128, true), text(value, name, 2048) || '']));
}

const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

export function normalizeRun(run) {
  if (!run) throw new StoreError('run metadata is required');
  const repository = text(run.repository, 'repository', 256, true).toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new StoreError('Invalid repository');
  return compact({
    repository,
    repositoryId: text(run.repositoryId, 'repositoryId', 128),
    runId: text(run.runId, 'runId', 128, true),
    runAttempt: number(run.runAttempt, 'runAttempt', { required: true, integer: true, min: 1 }),
    workflow: text(run.workflow, 'workflow', 512),
    branch: text(run.branch, 'branch', 1024),
    headSha: text(run.headSha, 'headSha', 128),
    sha: text(run.sha, 'sha', 128),
    pullRequestNumber: number(run.pullRequestNumber, 'pullRequestNumber', { integer: true }),
    title: text(run.title, 'title', 2048),
    actor: text(run.actor, 'actor', 256),
    runUrl: text(run.runUrl, 'runUrl', 2048),
    commitMessage: text(run.commitMessage, 'commitMessage', 4096),
    eventName: text(run.eventName, 'eventName', 128),
    startedAtMs: number(run.startedAtMs, 'run.startedAtMs', { integer: true }),
  });
}

export function normalizeRegistration(request) {
  const job = request?.job;
  if (!job) throw new StoreError('run and job metadata are required');
  const normalized = {
    invocationId: text(request.invocationId, 'invocationId', 256, true),
    run: normalizeRun(request.run),
    job: compact({
      jobId: text(job.jobId, 'jobId', 256, true),
      name: text(job.name, 'job.name', 1024),
      logicalJob: text(job.logicalJob, 'logicalJob', 256),
      matrix: dictionary(job.matrix, 'matrix'),
      system: text(job.system, 'system', 128),
      groupId: text(job.groupId, 'groupId', 256),
      planId: text(job.planId, 'planId', 256),
      dependencies: strings(job.dependencies, 'dependencies'),
      kind: text(job.kind, 'job.kind', 128),
      githubJobUrl: text(job.githubJobUrl, 'githubJobUrl', 2048),
      jobAttempt: number(job.jobAttempt, 'jobAttempt', { integer: true, min: 1 }) ?? 1,
      startedAtMs: number(job.startedAtMs, 'job.startedAtMs', { integer: true }),
      checkRunId: text(job.checkRunId, 'checkRunId', 128),
    }),
  };
  return normalized;
}

function matrixJob(value) {
  if (!value || typeof value !== 'object') throw new StoreError('Invalid matrix job');
  return compact({
    id: text(value.id, 'matrix job id', 256, true),
    name: text(value.name, 'matrix job name', 1024),
    kind: text(value.kind, 'matrix job kind', 128),
    system: text(value.system, 'matrix job system', 128),
    runner: text(value.runner, 'matrix job runner', 512),
    dependencies: strings(value.dependencies, 'matrix job dependencies'),
    consumers: strings(value.consumers, 'matrix job consumers'),
    stage: number(value.stage, 'matrix job stage', { integer: true }),
    matrix: dictionary(value.matrix, 'matrix job matrix'),
    roots: strings(value.roots, 'matrix job roots'),
    planId: text(value.planId, 'matrix job planId', 256),
  });
}

function derivation(value) {
  if (!value || typeof value !== 'object') throw new StoreError('Invalid derivation');
  return compact({
    drvPath: text(value.drvPath, 'derivation path', 2048, true),
    name: text(value.name, 'derivation name', 1024),
    outputs: strings(value.outputs, 'derivation outputs'),
    dependencies: strings(value.dependencies, 'derivation dependencies'),
    attributes: strings(value.attributes, 'derivation attributes'),
    system: text(value.system, 'derivation system', 128),
  });
}

export function normalizeEvent(value) {
  if (!value || typeof value !== 'object') throw new StoreError('Invalid event');
  const event = {
    sequence: number(value.sequence, 'sequence', { required: true, integer: true, min: 1 }),
    occurredAtMs: number(value.occurredAtMs, 'occurredAtMs', { required: true, integer: true }),
    kind: text(value.kind, 'event.kind', 128, true),
  };
  for (const field of ['entityId', 'parentId', 'name', 'status', 'drvPath', 'phase', 'message', 'outputPath', 'activityType', 'result']) {
    const result = text(value[field], field, field === 'message' ? 2048 : 1024);
    if (result !== undefined) event[field] = result;
  }
  for (const field of ['elapsedSeconds', 'durationSeconds', 'current', 'total', 'startedAtMs', 'finishedAtMs']) {
    const result = number(value[field], field, { integer: !['elapsedSeconds', 'durationSeconds'].includes(field) });
    if (result !== undefined) event[field] = result;
  }
  for (const field of ['dependencies', 'attributes', 'outputs']) {
    const result = strings(value[field], field);
    if (result !== undefined) event[field] = result;
  }
  for (const [field, normalize] of [['matrixJobs', matrixJob], ['derivations', derivation]]) {
    if (value[field] !== undefined) {
      if (!Array.isArray(value[field]) || value[field].length > 4096) throw new StoreError(`Invalid ${field}`);
      event[field] = value[field].map(normalize);
    }
  }
  if (value.labels !== undefined) event.labels = dictionary(value.labels, 'labels');
  if (value.terminal !== undefined) {
    if (typeof value.terminal !== 'boolean') throw new StoreError('Invalid terminal flag');
    event.terminal = value.terminal;
  }
  if (Buffer.byteLength(encode(event)) > 1024 * 1024) throw new StoreError('Event exceeds 1 MiB');
  return event;
}

export const runKey = run => `github:${run.repository.toLowerCase()}:${run.runId}:${run.runAttempt}`;

const stateRank = value => value === 'completed' ? 3 : ['in_progress', 'running'].includes(value) ? 2 : value ? 1 : 0;
const observedTime = value => value.updatedAt ?? value.completedAt ?? value.startedAt ?? 0;
const meaningful = value => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));

// Webhooks and REST reads can arrive in either order. A later arrival does not
// mean a later state, and a sparse job webhook must not erase fetched steps.
function mergeGithubRecord(previous, incoming) {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const regresses = stateRank(incoming.status) < stateRank(previous.status)
    || (stateRank(incoming.status) === stateRank(previous.status) && observedTime(incoming) && observedTime(previous) > observedTime(incoming));
  const merged = regresses ? { ...incoming, ...meaningful(previous) } : { ...previous, ...meaningful(incoming) };
  if (previous.steps || incoming.steps) {
    const steps = new Map((previous.steps || []).map(step => [step.number, step]));
    for (const step of incoming.steps || []) steps.set(step.number, mergeGithubRecord(steps.get(step.number), step));
    merged.steps = [...steps.values()].sort((a, b) => a.number - b.number);
  }
  return merged;
}

function mergeGithub(previous, incoming) {
  const jobs = new Map((previous?.jobs || []).map(job => [String(job.id), job]));
  for (const job of incoming.jobs || []) jobs.set(String(job.id), mergeGithubRecord(jobs.get(String(job.id)), job));
  const merged = { ...previous, ...incoming, run: mergeGithubRecord(previous?.run, incoming.run), jobs: [...jobs.values()] };
  // Only a REST response for the completed attempt establishes that we fetched
  // the complete job list. A completed workflow webhook alone does not.
  merged.needsReconcile = incoming.source === 'webhook' || incoming.run?.status !== 'completed'
    || Boolean(incoming.jobsTruncated) || (incoming.jobs || []).some(job => job.status !== 'completed');
  return merged;
}

export class EventStore {
  constructor(path, { now = () => Date.now() } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { timeout: 5000 });
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('revision', 0);
      CREATE TABLE IF NOT EXISTS invocations (
        id TEXT PRIMARY KEY, run_key TEXT NOT NULL, registration TEXT NOT NULL,
        registered_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS invocations_run ON invocations(run_key);
      CREATE TABLE IF NOT EXISTS streams (
        invocation_id TEXT NOT NULL REFERENCES invocations(id), id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(invocation_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_id TEXT NOT NULL REFERENCES invocations(id), stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, received_at INTEGER NOT NULL, event TEXT NOT NULL,
        UNIQUE(invocation_id, stream_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_invocation ON events(invocation_id, id);
      CREATE TABLE IF NOT EXISTS github (
        run_key TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runs (
        run_key TEXT PRIMARY KEY, repository_id TEXT, run_id TEXT NOT NULL,
        run_attempt INTEGER NOT NULL, metadata TEXT NOT NULL,
        registered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS runs_identity ON runs(repository_id, run_id, run_attempt) WHERE repository_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS run_aliases (
        alias TEXT PRIMARY KEY, run_key TEXT NOT NULL REFERENCES runs(run_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS github_deliveries (
        id TEXT PRIMARY KEY, event TEXT NOT NULL, digest TEXT NOT NULL,
        run_key TEXT REFERENCES runs(run_key), received_at INTEGER NOT NULL
      ) STRICT;
    `);
    // Existing collectors only had invocations. Backfill without changing
    // immutable registrations or event sequence numbers.
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT id, run_key, registration, registered_at FROM invocations ORDER BY registered_at, id').all()) {
        const result = this._upsertRun(JSON.parse(row.registration).run, { overwrite: false, registeredAtMs: row.registered_at });
        if (row.run_key !== result.runId) {
          const oldGithub = this.db.prepare('SELECT snapshot FROM github WHERE run_key = ?').get(row.run_key);
          if (oldGithub) this._updateGithub(result.runId, JSON.parse(oldGithub.snapshot));
          this.db.prepare('UPDATE invocations SET run_key = ? WHERE id = ?').run(result.runId, row.id);
        }
      }
    });
  }

  get revision() { return this.db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value; }
  bumpRevision() {
    this.db.prepare("UPDATE metadata SET value = value + 1 WHERE key = 'revision'").run();
    return this.revision;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  register(input) {
    const registration = normalizeRegistration(input);
    const json = encode(registration);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT registration, run_key FROM invocations WHERE id = ?').get(registration.invocationId);
      if (existing && existing.registration !== json) throw new StoreError('Invocation ID already belongs to different metadata', 'ALREADY_EXISTS');
      if (existing) return { invocationId: registration.invocationId, runKey: existing.run_key, revision: this.revision, changed: false };
      const { runId: key } = this._upsertRun(registration.run, { overwrite: false });
      this.db.prepare('INSERT INTO invocations (id, run_key, registration, registered_at) VALUES (?, ?, ?, ?)').run(registration.invocationId, key, json, this.now());
      return { invocationId: registration.invocationId, runKey: key, revision: this.bumpRevision(), changed: true };
    });
  }

  invocation(id) {
    const row = this.db.prepare('SELECT registration, registered_at, run_key FROM invocations WHERE id = ?').get(id);
    return row ? { ...JSON.parse(row.registration), registeredAtMs: row.registered_at, runKey: row.run_key } : null;
  }

  append(input) {
    const invocationId = text(input?.invocationId, 'invocationId', 256, true);
    const streamId = text(input?.streamId, 'streamId', 256, true);
    if (!Array.isArray(input.events) || input.events.length > 512) throw new StoreError('Batch must contain at most 512 events');
    const events = input.events.map(normalizeEvent);
    if (Buffer.byteLength(encode(events)) > MAX_BATCH_BYTES) throw new StoreError('Batch exceeds 4 MiB');
    return this.transaction(() => {
      const invocation = this.invocation(invocationId);
      if (!invocation) throw new StoreError('Register invocation before publishing', 'NOT_FOUND');
      this.db.prepare('INSERT OR IGNORE INTO streams (invocation_id, id) VALUES (?, ?)').run(invocationId, streamId);
      let lastSequence = this.db.prepare('SELECT last_sequence FROM streams WHERE invocation_id = ? AND id = ?').get(invocationId, streamId).last_sequence;
      const committedThrough = lastSequence;
      let inserted = 0;
      const receivedAt = this.now();
      for (const event of events) {
        const json = encode(event);
        if (event.sequence <= lastSequence) {
          const previous = this.db.prepare('SELECT event FROM events WHERE invocation_id = ? AND stream_id = ? AND sequence = ?').get(invocationId, streamId, event.sequence);
          if (!previous || previous.event !== json) throw new StoreError('Conflicting duplicate event', 'ALREADY_EXISTS', { lastSequence: committedThrough });
          continue;
        }
        if (event.sequence !== lastSequence + 1) throw new StoreError(`Event sequence gap: expected ${lastSequence + 1}`, 'FAILED_PRECONDITION', { lastSequence: committedThrough, expectedSequence: lastSequence + 1 });
        this.db.prepare('INSERT INTO events (invocation_id, stream_id, sequence, received_at, event) VALUES (?, ?, ?, ?, ?)').run(invocationId, streamId, event.sequence, receivedAt, json);
        lastSequence = event.sequence;
        inserted += 1;
      }
      if (inserted) this.db.prepare('UPDATE streams SET last_sequence = ? WHERE invocation_id = ? AND id = ?').run(lastSequence, invocationId, streamId);
      return { lastSequence, runKey: invocation.runKey, revision: inserted ? this.bumpRevision() : this.revision, changed: inserted > 0 };
    });
  }

  invocations(runId) {
    return this.db.prepare('SELECT registration, registered_at FROM invocations WHERE run_key = ? ORDER BY registered_at, id').all(this.resolveRunId(runId) || runId)
      .map(row => ({ ...JSON.parse(row.registration), registeredAtMs: row.registered_at }));
  }

  events(runId) {
    return this.db.prepare('SELECT events.* FROM events JOIN invocations ON invocations.id = events.invocation_id WHERE invocations.run_key = ? ORDER BY events.id').all(this.resolveRunId(runId) || runId)
      .map(row => ({ invocationId: row.invocation_id, streamId: row.stream_id, receivedAtMs: row.received_at, ...JSON.parse(row.event) }));
  }

  listRuns() {
    return this.db.prepare('SELECT * FROM runs ORDER BY registered_at DESC, run_key').all()
      .map(row => ({ ...JSON.parse(row.metadata), id: row.run_key, registeredAtMs: row.registered_at, updatedAtMs: row.updated_at }));
  }

  runIds() { return this.listRuns().map(run => run.id); }

  resolveRunId(id) {
    return this.db.prepare('SELECT run_key FROM run_aliases WHERE alias = ?').get(id)?.run_key
      || this.db.prepare('SELECT run_key FROM runs WHERE run_key = ?').get(id)?.run_key || null;
  }

  run(id) {
    const key = this.resolveRunId(id);
    if (!key) return null;
    const row = this.db.prepare('SELECT * FROM runs WHERE run_key = ?').get(key);
    return { ...JSON.parse(row.metadata), id: key, registeredAtMs: row.registered_at, updatedAtMs: row.updated_at };
  }

  _upsertRun(input, { overwrite = true, registeredAtMs = this.now() } = {}) {
    const metadata = normalizeRun(input);
    const alias = runKey(metadata);
    const namedKey = this.resolveRunId(alias);
    const stable = metadata.repositoryId && this.db.prepare('SELECT run_key FROM runs WHERE repository_id = ? AND run_id = ? AND run_attempt = ?')
      .get(metadata.repositoryId, metadata.runId, metadata.runAttempt);
    if (stable && namedKey && namedKey !== stable.run_key) throw new StoreError('Run name belongs to another repository identity', 'ALREADY_EXISTS');
    const key = stable?.run_key || namedKey || alias;
    const previous = this.db.prepare('SELECT * FROM runs WHERE run_key = ?').get(key);
    if (previous?.repository_id && metadata.repositoryId && previous.repository_id !== metadata.repositoryId) {
      throw new StoreError('Run name belongs to another repository identity', 'ALREADY_EXISTS');
    }
    const old = previous ? JSON.parse(previous.metadata) : {};
    const merged = overwrite ? { ...old, ...metadata } : { ...metadata, ...old };
    const json = encode(merged);
    const changed = !previous || previous.metadata !== json;
    if (changed) {
      this.db.prepare(`INSERT INTO runs (run_key, repository_id, run_id, run_attempt, metadata, registered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_key) DO UPDATE SET
        repository_id = excluded.repository_id, metadata = excluded.metadata, updated_at = excluded.updated_at`)
        .run(key, merged.repositoryId || null, merged.runId, merged.runAttempt, json, registeredAtMs, this.now());
    }
    this.db.prepare('INSERT OR IGNORE INTO run_aliases (alias, run_key) VALUES (?, ?)').run(alias, key);
    return { runId: key, runKey: key, changed };
  }

  upsertRun(metadata) {
    return this.transaction(() => {
      const result = this._upsertRun(metadata);
      return { ...result, revision: result.changed ? this.bumpRevision() : this.revision };
    });
  }

  _updateGithub(runId, snapshot) {
    const previous = this.db.prepare('SELECT snapshot FROM github WHERE run_key = ?').get(runId);
    const json = encode(mergeGithub(previous ? JSON.parse(previous.snapshot) : null, snapshot));
    if (Buffer.byteLength(json) > MAX_BATCH_BYTES) throw new StoreError('GitHub snapshot exceeds 4 MiB');
    if (previous?.snapshot === json) return false;
    this.db.prepare('INSERT INTO github (run_key, snapshot, updated_at) VALUES (?, ?, ?) ON CONFLICT(run_key) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at').run(runId, json, this.now());
    this.db.prepare('UPDATE runs SET updated_at = ? WHERE run_key = ?').run(this.now(), runId);
    return true;
  }

  updateGithub(runId, snapshot) {
    return this.transaction(() => {
      const existing = this.run(runId);
      const parsed = /^github:([^:]+):([^:]+):(\d+)$/.exec(runId);
      const identity = existing || (parsed && { repository: parsed[1], runId: parsed[2], runAttempt: Number(parsed[3]) });
      if (!identity) throw new StoreError('Invalid run identity');
      if (identity.repositoryId && snapshot.metadata?.repositoryId && identity.repositoryId !== snapshot.metadata.repositoryId) {
        throw new StoreError('GitHub snapshot belongs to a different repository');
      }
      if ((snapshot.run?.id != null && String(snapshot.run.id) !== identity.runId)
        || (snapshot.run?.attempt != null && Number(snapshot.run.attempt) !== identity.runAttempt)) throw new StoreError('GitHub snapshot belongs to a different workflow attempt');
      const result = this._upsertRun({ ...identity, ...snapshot.metadata, runId: identity.runId, runAttempt: identity.runAttempt });
      const changed = this._updateGithub(result.runId, snapshot) || result.changed;
      return { ...result, changed, revision: changed ? this.bumpRevision() : this.revision };
    });
  }

  // The caller validates the signature and repository connection first. Persist
  // the delivery and projection in one commit so a retry after a crash is safe.
  ingestGithub({ event, deliveryId, payload }, metadata, snapshot) {
    text(deliveryId, 'deliveryId', 256, true);
    text(event, 'webhook event', 128, true);
    const digest = createHash('sha256').update(encode(payload)).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM github_deliveries WHERE id = ?').get(deliveryId);
      if (previous) {
        if (previous.digest !== digest || previous.event !== event) throw new StoreError('Conflicting webhook delivery', 'ALREADY_EXISTS');
        return { runId: previous.run_key, runKey: previous.run_key, duplicate: true, changed: false, revision: this.revision };
      }
      const result = metadata ? this._upsertRun(metadata) : { runId: null, runKey: null, changed: false };
      const changed = snapshot ? this._updateGithub(result.runId, snapshot) || result.changed : result.changed;
      this.db.prepare('INSERT INTO github_deliveries (id, event, digest, run_key, received_at) VALUES (?, ?, ?, ?, ?)')
        .run(deliveryId, event, digest, result.runId, this.now());
      return { ...result, duplicate: false, changed, revision: changed ? this.bumpRevision() : this.revision };
    });
  }

  github(runId) {
    const row = this.db.prepare('SELECT snapshot, updated_at FROM github WHERE run_key = ?').get(this.resolveRunId(runId) || runId);
    return row ? { ...JSON.parse(row.snapshot), observedAtMs: row.updated_at } : null;
  }

  close() { this.db.close(); }
}
