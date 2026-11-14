import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http2 from 'node:http2';
import { gunzipSync } from 'node:zlib';
import { grpc, ReportingService } from './protocol.mjs';
import { DurableSpool, GrpcTransport, ReliableUploader, collectorAddress } from './uploader.mjs';

const registration = { invocationId: 'test-invocation', run: { repository: 'example/packages', runId: '123', runAttempt: 1 }, job: { jobId: 'native', jobAttempt: 1 } };
const event = (name = 'one') => ({ occurredAtMs: 1700000000000, kind: 'job', entityId: name, name, status: 'built' });

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nix-ci-uploader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function until(predicate, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for telemetry');
    await delay(10);
  }
}

async function grpcServer(t, implementation) {
  const server = new grpc.Server();
  server.addService(ReportingService, implementation);
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  t.after(() => server.forceShutdown());
  return { endpoint: `http://127.0.0.1:${port}`, server };
}

test('durable protobuf spool reopens with the original identity and sequence after interruption', async t => {
  const directory = await temporary(t);
  const original = await DurableSpool.open(directory, registration, { streamId: 'stream-one' });
  await original.append(event('first'));
  await original.append(event('second'));
  const raw = await readFile(original.eventPath(1));
  assert.notEqual(raw[0], '{'.charCodeAt(0));
  const reopened = await DurableSpool.open(directory);
  assert.equal(reopened.streamId, 'stream-one');
  assert.equal(reopened.lastSequence, 2);
  assert.deepEqual((await reopened.readBatch()).events.map(event => event.sequence), [1, 2]);
  await reopened.acknowledge(1);
  const replay = await DurableSpool.open(directory);
  assert.deepEqual((await replay.readBatch()).events.map(event => event.sequence), [2]);
  assert.equal(await replay.append(event('third')), 3);
  await assert.rejects(DurableSpool.open(directory, { ...registration, invocationId: 'different' }), /another invocation/);
});

test('binary gRPC publishes are genuinely gzip compressed on the wire', async t => {
  const server = http2.createServer();
  let seen;
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      try {
        const frame = Buffer.concat(chunks);
        assert.equal(headers['grpc-encoding'], 'gzip');
        assert.equal(frame[0], 1);
        const body = gunzipSync(frame.subarray(5));
        seen = ReportingService.Publish.requestDeserialize(body);
        assert.equal(seen.events.length, 20);
        assert.ok(frame.length < body.length / 2);
        const result = ReportingService.Publish.responseSerialize({ lastSequence: 20 });
        const prefix = Buffer.alloc(5); prefix.writeUInt32BE(result.length, 1);
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end(Buffer.concat([prefix, result]));
      } catch (error) { stream.destroy(error); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = new GrpcTransport({ endpoint: `http://127.0.0.1:${server.address().port}` });
  t.after(() => { transport.close(); server.close(); });
  const result = await transport.publish({ invocationId: registration.invocationId, streamId: 'wire', events: Array.from({ length: 20 }, (_, index) => ({ ...event('long-identical-package-name-'.repeat(8)), sequence: index + 1 })) });
  assert.equal(result.lastSequence, 20);
  assert.equal(seen.invocationId, registration.invocationId);
});

test('a burst is batched, and a committed batch with a lost acknowledgement replays exactly', async t => {
  const directory = await temporary(t);
  const spool = await DurableSpool.open(directory, registration);
  const received = new Map();
  const batches = [];
  let loseAck = true;
  const { endpoint } = await grpcServer(t, {
    registerInvocation: (_call, done) => done(null, { invocationId: registration.invocationId }),
    publish: (call, done) => {
      const events = call.request.events;
      batches.push(events);
      for (const item of events) {
        if (received.has(item.sequence)) assert.deepEqual(received.get(item.sequence), item);
        received.set(item.sequence, item);
      }
      if (loseAck) { loseAck = false; done({ code: grpc.status.UNAVAILABLE, message: 'lost acknowledgement' }); }
      else done(null, { lastSequence: Math.max(...received.keys()) });
    },
  });
  const uploader = new ReliableUploader({ spool, transport: new GrpcTransport({ endpoint }), retryMs: 10, batchWindowMs: 100 }).start();
  t.after(() => uploader.stop({ timeoutMs: 0 }));
  for (let n = 0; n < 12; n++) { await spool.append(event(`package-${n}`)); uploader.notify(); }
  await until(() => spool.pendingCount === 0);
  assert.equal(received.size, 12);
  assert.ok(batches[0].length > 1, `First RPC held only ${batches[0].length} event`);
  assert.deepEqual(batches[0], batches[1].slice(0, batches[0].length));
  await spool.serial;
  assert.equal((await readdir(join(directory, 'pending'))).length, 0);
});

test('collector outage preserves pending records and a new uploader recovers from disk', async t => {
  const directory = await temporary(t);
  const spool = await DurableSpool.open(directory, registration);
  await spool.append(event());
  const warnings = [];
  const unavailable = new ReliableUploader({ spool,
    transport: { register: async () => { throw Object.assign(new Error('Bearer private-token'), { code: 14 }); }, close() {} },
    retryMs: 10, maxRetryMs: 20, onWarning: warning => warnings.push(warning),
  }).start();
  const result = await unavailable.stop({ timeoutMs: 50 });
  assert.equal(result.pending, 1);
  assert.ok(warnings.length);
  assert.ok(warnings.every(message => !message.includes('private-token')));
  const reopened = await DurableSpool.open(directory);
  const { endpoint } = await grpcServer(t, {
    registerInvocation: (_call, done) => done(null, { invocationId: registration.invocationId }),
    publish: (call, done) => done(null, { lastSequence: call.request.events.at(-1).sequence }),
  });
  const recovered = new ReliableUploader({ spool: reopened, transport: new GrpcTransport({ endpoint }) }).start();
  t.after(() => recovered.stop({ timeoutMs: 0 }));
  assert.equal((await recovered.stop({ timeoutMs: 1500 })).pending, 0);
});

test('spool bounds reserve room for truthful terminal state without sequence gaps', async t => {
  const directory = await temporary(t);
  const spool = await DurableSpool.open(directory, registration, { maxEvents: 2 });
  await spool.append(event('one'));
  await spool.append(event('two'));
  await assert.rejects(spool.append(event('three')), /limit/);
  await spool.append({ ...event('end'), kind: 'invocation_finish', terminal: true, status: 'failed' });
  assert.deepEqual((await spool.readBatch()).events.map(event => event.sequence), [1, 2, 3]);
});

test('remote plaintext telemetry and credential-bearing endpoints are rejected', () => {
  assert.throws(() => collectorAddress('http://remote.example:4000'), /TLS/);
  assert.throws(() => collectorAddress('https://token:secret@remote.example'), /credentials/);
  assert.equal(collectorAddress('127.0.0.1:4000').secure, false);
});
