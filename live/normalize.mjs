import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { canonical } from './github.mjs';

const text = (value, limit = 1024) => typeof value === 'string' ? value.slice(0, limit) : '';
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => text(item)) : [];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
const chunks = (values, size = 128) => {
  const result = [];
  let current = [], bytes = 0;
  for (const value of values) {
    const length = Buffer.byteLength(JSON.stringify(value));
    if (current.length && (current.length >= size || bytes + length > 256 * 1024)) {
      result.push(current); current = []; bytes = 0;
    }
    current.push(value); bytes += length;
  }
  if (current.length) result.push(current);
  return result;
};

export function sharedPlanId(manifest) {
  return `plan-${createHash('md5').update(JSON.stringify(canonical(manifest))).digest('hex')}`;
}

export function sourceLabels(raw, source, sequence) {
  return compact({
    sourceStream: text(source), sourceSequence: String(raw.sequence ?? sequence),
    sourceType: text(raw.type), groupId: text(raw.groupId), attemptId: text(raw.attemptId), planId: text(raw.planId),
  });
}

function derivation(node, drvPath = node.drvPath, attributes = node.attrs) {
  return compact({
    drvPath: text(drvPath), name: text(node.name), system: text(node.system),
    outputs: Array.isArray(node.outputs) ? strings(node.outputs) : strings(Object.values(node.outputs || {})),
    dependencies: Array.isArray(node.inputs) ? node.inputs.map(input => text(input.drvPath)).filter(Boolean) : Object.keys(node.inputDrvs || {}),
    attributes: strings(attributes),
  });
}

export function normalizeManifest(manifest, { source = 'execution-plan.json', now = Date.now() } = {}) {
  if (!manifest?.plan?.groups || !manifest.graph) return [];
  const planId = sharedPlanId(manifest);
  const groups = new Map(manifest.plan.groups.map(group => [group.id, group]));
  const stages = new Map();
  const stage = (id, seen = new Set()) => {
    if (stages.has(id)) return stages.get(id);
    if (seen.has(id)) throw new Error('Cyclic execution plan');
    const dependencies = groups.get(id)?.needs || [];
    const result = dependencies.length ? 1 + Math.max(...dependencies.map(dependency => stage(dependency, new Set([...seen, id])))) : 0;
    stages.set(id, result);
    return result;
  };
  const attributes = new Map();
  for (const item of manifest.attributes || []) {
    if (item.drvPath && item.attr) attributes.set(item.drvPath, [...(attributes.get(item.drvPath) || []), item.attr]);
  }
  const matrixJobs = manifest.plan.groups.map(group => ({
    id: text(group.id), name: strings(group.consumers).join(' / ') || text(group.id),
    kind: text(group.kind), system: text(group.system), dependencies: strings(group.needs),
    consumers: strings(group.consumers), stage: stage(group.id),
    runner: typeof group.runner === 'string' ? group.runner : typeof manifest.runners?.[group.system] === 'string' ? manifest.runners[group.system] : '',
    roots: (group.roots || []).map(root => text(root.drvPath)).filter(Boolean), planId,
    matrix: { group: text(group.id), system: text(group.system) },
  }));
  const definitions = Object.entries(manifest.graph).map(([path, node]) => derivation(node, path, attributes.get(path)));
  const base = { occurredAtMs: now, entityId: planId, labels: { sourceStream: source, planId } };
  return [
    ...chunks(matrixJobs).map(matrixJobs => ({ ...base, kind: 'matrix_plan', matrixJobs })),
    ...chunks(definitions).map(derivations => ({ ...base, kind: 'plan', derivations })),
  ];
}

export function normalizeEvent(raw, { source = 'events.jsonl', sequence = 1, now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return [];
  let kind = raw.type.replaceAll('-', '_');
  if (kind === 'root_failure' || kind === 'evaluation_error') kind = 'failure';
  if (kind === 'upload_finished') kind = 'upload_finish';
  if (kind === 'upload') kind = 'upload_finish';
  if (kind === 'cache_import_start' || kind === 'cache_import_finished') kind = 'cache_reuse';
  const failure = raw.failure || {};
  const drvPath = text(raw.drvPath || failure.drvPath);
  const path = text(raw.path);
  const status = text(raw.status || raw.state);
  const event = compact({
    occurredAtMs: number(raw.time) === undefined ? now : Math.round(raw.time * 1000),
    kind, entityId: drvPath || path || text(raw.groupId) || kind,
    parentId: text(raw.groupId), drvPath, name: text(raw.name || failure.name), status,
    elapsedSeconds: number(raw.elapsed), durationSeconds: number(raw.durationSeconds ?? raw.seconds),
    current: number(raw.active), total: number(raw.total), phase: text(raw.phase),
    outputPath: path, dependencies: strings(raw.needs || raw.dependencies || raw.drvs || raw.requiredPrerequisites),
    attributes: strings(raw.attrs || (raw.attr ? [raw.attr] : [])), outputs: strings(raw.paths || raw.outputs || raw.imported || raw.published),
    labels: sourceLabels(raw, source, sequence),
  });
  if (kind === 'phase_start' || kind === 'phase_finish') {
    event.entityId = [raw.groupId || source, raw.attemptId || '', raw.phase || 'phase'].join(':');
    for (const [input, label] of [['imported', 'importedCount'], ['published', 'publishedCount'], ['refreshedBuilds', 'remainingBuilds'],
      ['cachedRoots', 'cachedRoots'], ['plannedPrerequisites', 'plannedPrerequisites'], ['requiredPrerequisites', 'requiredPrerequisites']]) {
      if (Array.isArray(raw[input])) event.labels[label] = String(raw[input].length);
    }
  }
  if (kind === 'attempt_start' || kind === 'attempt_finish') {
    event.entityId = [raw.groupId || source, raw.attemptId || 'attempt'].join(':');
  }
  if (kind === 'activity_start') {
    event.activityType = status === 'building' ? 'build' : status === 'downloading' ? 'download' : 'wait';
  }
  if (kind === 'warning') event.message = 'The builder reported a warning; see the job log.';
  if (kind === 'failure') {
    event.status = 'failed';
    event.message = 'The builder reported a failure; see the job log.';
  }
  if (kind === 'cache_reuse') event.status = raw.type === 'cache-import-start' ? 'importing' : status;
  if (kind === 'upload_queued') event.status = 'queued';
  if (kind === 'retry' || kind === 'upload_retry') event.labels.retryAttempt = String(raw.attempt || 0);
  if (kind === 'request_wait' || kind === 'request_wait_ended') {
    event.kind = kind === 'request_wait' ? 'activity_start' : 'activity_stop';
    event.entityId = `request:${text(raw.requestId)}`;
    event.activityType = 'wait';
    event.status = kind === 'request_wait' ? 'waiting' : 'finished';
    event.name = 'Waiting for Nix';
  }
  // Never promote an engine/phase terminal into a successful action invocation.
  if (kind === 'finished' || kind === 'attempt_finish' || kind === 'run_finish') event.terminal = false;
  if (kind === 'plan' && raw.plan) {
    return [
      { ...event, current: raw.plan.builds?.length || 0, total: raw.plan.roots?.length || 0,
        labels: { ...event.labels, downloads: String(raw.plan.downloads?.length || 0) } },
      ...chunks((raw.plan.builds || []).map(node => derivation(node))).map(derivations => ({ ...event, derivations })),
    ];
  }
  return [event];
}

export function normalizeSnapshot(snapshot, { source = 'results.json', now = Date.now() } = {}) {
  if (!snapshot || !Array.isArray(snapshot.jobs)) return [];
  const context = snapshot.context || {};
  const labels = sourceLabels(context, source, 0);
  const base = { occurredAtMs: now, labels };
  const activities = (snapshot.derivations || []).map(item => compact({
    ...base, kind: 'activity_snapshot', entityId: text(item.drvPath || item.path), drvPath: text(item.drvPath),
    outputPath: text(item.path), name: text(item.name), status: text(item.state), phase: text(item.phase),
    durationSeconds: number(item.seconds), current: number(item.active),
    startedAtMs: number(item.startedAt) === undefined ? undefined : Math.round(item.startedAt * 1000),
    finishedAtMs: number(item.finishedAt) === undefined ? undefined : Math.round(item.finishedAt * 1000),
    outputs: strings(item.outputPaths), activityType: item.kind === 'download' || item.downloadSeconds > 0 && !(item.buildSeconds > 0) ? 'download' : item.buildSeconds > 0 || item.activeBuilds > 0 ? 'build' : 'wait',
    labels: { ...labels, buildSeconds: String(item.buildSeconds || 0), downloadSeconds: String(item.downloadSeconds || 0),
      waitSeconds: String(item.waitSeconds || 0) },
  }));
  const jobs = snapshot.jobs.map(item => compact({
    ...base, kind: 'job', entityId: text(item.drvPath), drvPath: text(item.drvPath), name: text(item.name),
    status: text(item.state), attributes: strings(item.attrs),
    startedAtMs: number(item.startedAt) === undefined ? undefined : Math.round(item.startedAt * 1000),
    finishedAtMs: number(item.finishedAt) === undefined ? undefined : Math.round(item.finishedAt * 1000),
    durationSeconds: number(item.seconds), labels: { ...labels, cacheStatus: text(item.cacheStatus) },
  }));
  const counts = {};
  for (const job of snapshot.jobs) counts[job.state] = (counts[job.state] || 0) + 1;
  const metrics = {
    built: counts.built || 0,
    actualBuilds: (snapshot.derivations || []).filter(item => item.state === 'built').length,
    cached: counts.cached || 0,
    downloads: (snapshot.derivations || []).filter(item => item.downloadSeconds > 0 && item.state === 'cached').length,
    actualDownloads: (snapshot.derivations || []).filter(item => item.downloadSeconds > 0 && item.state === 'cached').length,
    imports: (snapshot.cacheReuse || []).filter(item => item.state === 'imported').length,
    uploads: (snapshot.uploads || []).filter(item => item.state === 'uploaded').length,
    rootsBuilt: counts.built || 0, failed: counts.failed || 0, blocked: counts.blocked || 0,
  };
  return [...jobs, ...activities, {
    ...base, kind: 'snapshot', entityId: source, status: text(snapshot.status), total: snapshot.jobs.length,
    current: (counts.built || 0) + (counts.cached || 0),
    elapsedSeconds: number(context.elapsedSeconds),
    labels: { ...labels, ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, String(value)])) },
  }];
}

const eventNames = new Set(['events.jsonl', 'execution-events.jsonl', 'scheduler-events.jsonl']);
const snapshotNames = new Set(['results.json', 'execution-plan.json']);

// A tailer follows only structured reports. It never reads logs, arbitrary
// environment files, or symlinks, and it records existing offsets before spawn
// so a reused report directory cannot manufacture a new successful attempt.
export class ReportWatcher {
  constructor({ directories, emit, intervalMs = 150, onWarning = () => {} }) {
    this.directories = [...new Set(directories.map(directory => resolve(directory)))];
    this.emit = emit;
    this.intervalMs = intervalMs;
    this.onWarning = onWarning;
    this.files = new Map();
    this.snapshots = new Map();
    this.lastValues = new Map();
    this.serial = Promise.resolve();
    this.stopped = false;
  }

  async listFiles() {
    const result = new Map();
    const walk = async (directory, root, depth) => {
      if (depth > 6) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !['logs', 'store', 'gc-roots', '.telemetry', 'telemetry'].includes(entry.name)) {
          await walk(path, root, depth + 1);
        } else if (entry.isFile() && (eventNames.has(entry.name) || snapshotNames.has(entry.name))) {
          result.set(path, `${this.directories.indexOf(root)}:${relative(root, path)}`);
        }
      }
    };
    for (const root of this.directories) await walk(root, root, 0);
    return result;
  }

  async initialize() {
    for (const [path, source] of await this.listFiles()) {
      const metadata = await stat(path);
      if (eventNames.has(basename(path))) {
        const handle = await open(path, 'r');
        let head;
        try {
          head = Buffer.alloc(Math.min(metadata.size, 256));
          const { bytesRead } = await handle.read(head, 0, head.length, 0);
          head = head.subarray(0, bytesRead);
        } finally { await handle.close(); }
        this.files.set(path, { offset: metadata.size, inode: metadata.ino, partial: '', line: 0, generation: 0, source, head });
      } else if (basename(path) === 'results.json') {
        this.snapshots.set(path, `${metadata.mtimeMs}:${metadata.size}`);
      }
    }
  }

  start() {
    this.task = (async () => {
      while (!this.stopped) {
        await this.poll();
        if (!this.stopped) await new Promise(resolve => { this.timer = setTimeout(resolve, this.intervalMs); this.wake = resolve; });
      }
    })();
    return this;
  }

  poll() {
    const task = this.serial.then(async () => {
      for (const [path, source] of await this.listFiles()) {
        try {
          if (eventNames.has(basename(path))) await this.tail(path, source);
          else await this.snapshot(path, source);
        } catch (error) {
          if (error.code !== 'ENOENT') this.onWarning('A structured report could not be read; the local report remains available.');
        }
      }
    });
    this.serial = task.catch(() => {});
    return task;
  }

  async tail(path, source) {
    const metadata = await stat(path);
    let state = this.files.get(path);
    if (!state || state.inode !== metadata.ino || metadata.size < state.offset) {
      state = { offset: 0, inode: metadata.ino, partial: '', line: 0, generation: (state?.generation ?? -1) + 1, source };
      this.files.set(path, state);
    }
    const handle = await open(path, 'r');
    try {
      if (state.head?.length) {
        const prefix = Buffer.alloc(state.head.length);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        if (!prefix.subarray(0, bytesRead).equals(state.head)) {
          state = { offset: 0, inode: metadata.ino, partial: '', line: 0, generation: state.generation + 1, source };
          this.files.set(path, state);
        }
      }
      if (!state.head?.length && metadata.size) {
        const prefix = Buffer.alloc(Math.min(metadata.size, 256));
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        state.head = prefix.subarray(0, bytesRead);
      }
      while (state.offset < metadata.size) {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, metadata.size - state.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
        if (!bytesRead) break;
        // JSON report fields are UTF-8; retain byte fragments across reads.
        const data = Buffer.concat([Buffer.from(state.partial, 'base64'), buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          const line = data.subarray(start, end);
          state.line++;
          start = end + 1;
          if (!line.length) continue;
          let raw;
          try { raw = JSON.parse(line.toString('utf8')); }
          catch { this.onWarning('A malformed structured event was skipped.'); continue; }
          for (const event of normalizeEvent(raw, { source: `${source}:${state.generation}`, sequence: state.line })) await this.emit(event);
        }
        state.offset += bytesRead;
        if (data.length - start > 4 * 1024 * 1024) throw new Error('Structured event is too large');
        state.partial = data.subarray(start).toString('base64');
      }
    } finally { await handle.close(); }
  }

  async snapshot(path, source) {
    const metadata = await stat(path);
    const version = `${metadata.mtimeMs}:${metadata.size}`;
    if (this.snapshots.get(path) === version) return;
    if (metadata.size > 64 * 1024 * 1024) throw new Error('Structured report is too large');
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    const events = basename(path) === 'execution-plan.json'
      ? normalizeManifest(snapshot, { source }) : normalizeSnapshot(snapshot, { source });
    for (const event of events) {
      const { occurredAtMs, ...content } = event;
      const identity = `${path}:${event.kind}:${event.entityId}:${event.derivations?.[0]?.drvPath || event.matrixJobs?.[0]?.id || ''}`;
      const value = JSON.stringify(content);
      if (this.lastValues.get(identity) !== value) {
        await this.emit(event);
        this.lastValues.set(identity, value);
      }
    }
    this.snapshots.set(path, version);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wake?.();
    await this.task;
    await this.poll();
  }
}
