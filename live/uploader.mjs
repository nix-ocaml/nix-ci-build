import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { grpc, ReportingClient, ReportingService } from './protocol.mjs';
import { safeDiagnostic } from './github.mjs';

const publishDescriptor = ReportingService.Publish || ReportingService.publish;
const serialize = publishDescriptor.requestSerialize;
const deserialize = publishDescriptor.requestDeserialize;

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(join(path, '..'));
}

// The durable queue contains binary protobuf, not raw builder output. Persist
// each event before attempting delivery, and persist ACKs before removing it.
// Crashes can cause an exact replay but cannot turn a pending event into loss.
export class DurableSpool {
  static async open(directory, registration, { streamId = randomUUID(), maxBytes = 256 * 1024 * 1024, maxEvents = 100_000 } = {}) {
    await mkdir(join(directory, 'pending'), { recursive: true, mode: 0o700 });
    const statePath = join(directory, 'state.json');
    let state;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'));
      if (registration && state.registration.invocationId !== registration.invocationId) {
        throw new Error('Spool belongs to another invocation');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!registration?.invocationId) throw new Error('A new spool needs an invocation identity');
      state = { version: 1, registration, streamId, acknowledged: 0, nextSequence: 1 };
      await atomicWrite(statePath, JSON.stringify(state));
    }
    if (state.version !== 1 || !state.streamId || !state.registration?.invocationId
      || !Number.isSafeInteger(state.acknowledged) || !Number.isSafeInteger(state.nextSequence)) {
      throw new Error('Invalid telemetry spool state');
    }
    const spool = new DurableSpool(directory, state);
    spool.maxBytes = maxBytes;
    spool.maxEvents = maxEvents;
    const sequences = await spool.sequences();
    // An event may have reached disk immediately before a state checkpoint.
    spool.state.nextSequence = sequences.reduce((next, n) => Math.max(next, n + 1), Math.max(state.nextSequence, state.acknowledged + 1));
    for (const sequence of sequences) {
      if (sequence <= state.acknowledged) await rm(spool.eventPath(sequence), { force: true });
      else {
        const size = (await stat(spool.eventPath(sequence))).size;
        spool.sizes.set(sequence, size);
        spool.pendingBytes += size;
      }
    }
    await spool.saveState();
    return spool;
  }

  constructor(directory, state) {
    this.directory = directory;
    this.state = state;
    this.serial = Promise.resolve();
    this.sizes = new Map();
    this.pendingBytes = 0;
  }

  get registration() { return this.state.registration; }
  get streamId() { return this.state.streamId; }
  get lastSequence() { return this.state.nextSequence - 1; }
  get pendingCount() { return this.lastSequence - this.state.acknowledged; }
  eventPath(sequence) { return join(this.directory, 'pending', `${String(sequence).padStart(16, '0')}.pb`); }
  saveState() { return atomicWrite(join(this.directory, 'state.json'), JSON.stringify(this.state)); }

  async sequences() {
    return (await readdir(join(this.directory, 'pending')))
      .filter(name => /^\d{16}\.pb$/.test(name)).map(name => Number(name.slice(0, 16))).sort((a, b) => a - b);
  }

  exclusive(operation) {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => {});
    return result;
  }

  updateRegistration(registration) {
    return this.exclusive(async () => {
      if (registration.invocationId !== this.registration.invocationId) throw new Error('Cannot change spool invocation identity');
      this.state.registration = registration;
      await this.saveState();
    });
  }

  append(event) {
    return this.exclusive(async () => {
      const sequence = this.state.nextSequence;
      const typed = { ...event, sequence };
      const bytes = serialize({ invocationId: this.registration.invocationId, streamId: this.streamId, events: [typed] });
      if (bytes.length > 512 * 1024) throw new Error('Telemetry event exceeds the protobuf size limit');
      // Reserve space for the authoritative terminal record even if a long
      // collector outage fills the queue. The caller marks reporting incomplete
      // and preserves source reports rather than blocking the package build.
      const terminal = event.kind === 'invocation_finish' && event.terminal === true;
      if (this.pendingBytes + bytes.length > this.maxBytes + (terminal ? 1024 * 1024 : 0)
        || this.pendingCount >= this.maxEvents + (terminal ? 1 : 0)) {
        throw new Error('Telemetry spool limit reached');
      }
      await atomicWrite(this.eventPath(sequence), bytes);
      this.sizes.set(sequence, bytes.length);
      this.pendingBytes += bytes.length;
      this.state.nextSequence = sequence + 1;
      await this.saveState();
      return sequence;
    });
  }

  readBatch({ maxEvents = 128, maxBytes = 512 * 1024 } = {}) {
    return this.exclusive(async () => {
      const events = [];
      let bytes = 0;
      for (let sequence = this.state.acknowledged + 1; sequence < this.state.nextSequence; sequence++) {
        const buffer = await readFile(this.eventPath(sequence));
        if (events.length && (events.length >= maxEvents || bytes + buffer.length > maxBytes)) break;
        const decoded = deserialize(buffer);
        if (decoded.invocationId !== this.registration.invocationId || decoded.streamId !== this.streamId
          || decoded.events?.length !== 1 || decoded.events[0].sequence !== sequence) {
          throw new Error('Telemetry spool event identity is corrupt');
        }
        events.push(decoded.events[0]);
        bytes += buffer.length;
      }
      return { invocationId: this.registration.invocationId, streamId: this.streamId, events };
    });
  }

  acknowledge(sequence) {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(sequence) || sequence < this.state.acknowledged || sequence > this.lastSequence) {
        throw new Error('Collector returned an invalid acknowledgement');
      }
      const previous = this.state.acknowledged;
      const checkpoint = { ...this.state, acknowledged: sequence };
      await atomicWrite(join(this.directory, 'state.json'), JSON.stringify(checkpoint));
      this.state.acknowledged = sequence;
      for (let n = previous + 1; n <= sequence; n++) {
        await rm(this.eventPath(n), { force: true });
        this.pendingBytes -= this.sizes.get(n) || 0;
        this.sizes.delete(n);
      }
    });
  }
}

export function collectorAddress(endpoint, { allowInsecure = false } = {}) {
  const url = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Collector endpoint must be an origin without credentials or a path');
  }
  if (!['http:', 'https:', 'grpc:', 'grpcs:'].includes(url.protocol)) throw new Error('Unsupported collector protocol');
  const secure = ['https:', 'grpcs:'].includes(url.protocol);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!secure && !local && !allowInsecure) throw new Error('Remote collectors require TLS');
  return { address: `${url.hostname}:${url.port || (secure ? '443' : '80')}`, secure, local };
}

export class GrpcTransport {
  constructor({ endpoint, token, allowInsecure = false, timeoutMs = 4000, protocol } = {}) {
    const { address, secure, local } = collectorAddress(endpoint, { allowInsecure });
    if (!token && !local) throw new Error('Remote collectors require authenticated telemetry');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.closed = false;
    this.abort = new AbortController();
    const Client = protocol?.ReportingClient || ReportingClient;
    this.client = new Client(address, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
      'grpc.default_compression_algorithm': 2, // gzip, applied by grpc-js to binary protobuf frames.
      'grpc.enable_retries': 0,
      'grpc.max_send_message_length': 1024 * 1024,
      'grpc.max_receive_message_length': 1024 * 1024,
    });
  }

  async call(method, request) {
    const metadata = new grpc.Metadata();
    if (this.token) {
      const token = await this.token({ refresh: this.refreshToken, signal: this.abort.signal });
      this.refreshToken = false;
      metadata.set('authorization', `Bearer ${token}`);
    }
    if (this.closed) throw Object.assign(new Error('Transport closed'), { code: grpc.status.CANCELLED });
    return new Promise((resolve, reject) => {
      this.client[method](request, metadata, { deadline: Date.now() + this.timeoutMs }, (error, response) => {
        if (error) {
          if (error.code === grpc.status.UNAUTHENTICATED) this.refreshToken = true;
          reject(error);
        } else resolve(response);
      });
    });
  }

  register(request) { return this.call('registerInvocation', request); }
  publish(request) { return this.call('publish', request); }
  close() { this.closed = true; this.abort.abort(); this.client.close(); }
}

export class ReliableUploader {
  constructor({ spool, transport, retryMs = 250, maxRetryMs = 5000, batchWindowMs = 100, prepareRegistration = async value => value, onRegistered = () => {}, onWarning = () => {} }) {
    this.spool = spool;
    this.transport = transport;
    this.retryMs = retryMs;
    this.maxRetryMs = maxRetryMs;
    this.batchWindowMs = batchWindowMs;
    this.onRegistered = onRegistered;
    this.prepareRegistration = prepareRegistration;
    this.onWarning = onWarning;
    this.stopped = false;
    this.registered = false;
    this.lastWarning = 0;
    this.wake = undefined;
  }

  start() {
    if (!this.task) this.task = this.loop();
    return this;
  }

  notify() { this.wake?.(); }

  async pause(milliseconds) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); if (this.wake === done) this.wake = undefined; resolve(); };
      const timer = setTimeout(done, milliseconds);
      timer.unref();
      this.wake = done;
    });
  }

  async loop() {
    let retries = 0;
    while (!this.stopped) {
      try {
        if (!this.registered) {
          const registration = await this.prepareRegistration(this.spool.registration);
          if (JSON.stringify(registration) !== JSON.stringify(this.spool.registration)) await this.spool.updateRegistration(registration);
          const response = await this.transport.register(registration);
          this.registered = true;
          this.onRegistered(response);
        }
        if (this.spool.pendingCount === 0) {
          retries = 0;
          await this.pause(250);
          continue;
        }
        if (this.spool.pendingCount > 0 && !this.flushing && this.batchWindowMs > 0) {
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.flushWake = undefined; resolve(); };
            const timer = setTimeout(done, this.batchWindowMs);
            timer.unref();
            this.flushWake = done;
          });
        }
        const batch = await this.spool.readBatch();
        if (!batch.events.length) {
          retries = 0;
          await this.pause(250);
          continue;
        }
        const response = await this.transport.publish(batch);
        const acknowledged = Number(response.lastSequence);
        if (acknowledged < batch.events.at(-1).sequence) throw new Error('Collector did not commit the complete batch');
        await this.spool.acknowledge(acknowledged);
        retries = 0;
      } catch (error) {
        if (this.stopped) break;
        // A restarted collector must be able to re-create the invocation before
        // pending events replay. Every registration is immutable and idempotent.
        this.registered = false;
        if (Date.now() - this.lastWarning > 30_000) {
          this.lastWarning = Date.now();
          this.onWarning(`Live reporting is reconnecting (${safeDiagnostic(error)}); events remain in the local spool.`);
        }
        await this.pause(Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(retries++, 8)));
      }
    }
  }

  async stop({ timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    this.flushing = true;
    this.flushWake?.();
    this.notify();
    while (this.spool.pendingCount > 0 && Date.now() < deadline && !this.stopped) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    this.stopped = true;
    this.notify();
    this.transport.close();
    // The transport has its own request deadline. Do not let authentication or
    // a failed collector delay a build after its bounded final flush.
    await Promise.race([this.task, delay(50)]);
    return { pending: this.spool.pendingCount, acknowledged: this.spool.state.acknowledged };
  }
}
