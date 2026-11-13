import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubIdentity, oidcTokenSource, parseMatrix, readGitHubEvent, tokenClaims } from './github.mjs';
import { ReportWatcher, sharedPlanId } from './normalize.mjs';
import { DurableSpool, GrpcTransport, ReliableUploader } from './uploader.mjs';

export function argumentValue(args, name) {
  const position = args.indexOf(name);
  if (position !== -1) return args[position + 1];
  return args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function commandReportDirectory(args, fallback = 'report', cwd = process.cwd()) {
  return resolve(cwd, argumentValue(args, '--report-dir') || fallback);
}

export function predictedReportUrl(reportBase, registration) {
  if (!reportBase) return '';
  const base = new URL(reportBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Report URL must be an HTTP origin without credentials');
  }
  const run = registration.run;
  const key = `github:${run.repository.toLowerCase()}:${run.runId}:${run.runAttempt}`;
  return `${base.href.replace(/\/$/, '')}/runs/${encodeURIComponent(key)}`;
}

function matrixStrings(matrix) {
  return Object.fromEntries(Object.entries(matrix).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
}

export async function makeRegistration({ env = process.env, event = {}, matrix = {}, args = [], cwd = process.cwd(), invocationId = randomUUID(), name, system, runId, jobId, repository, now = Date.now() } = {}) {
  const identity = githubIdentity({ env, event, matrix, invocationId });
  const groupId = argumentValue(args, '--group') || '';
  const planDirectory = argumentValue(args, '--execute-plan') || argumentValue(args, '--run-plan');
  let planId = '', group;
  if (planDirectory) {
    try {
      const manifest = JSON.parse(await readFile(resolve(cwd, planDirectory, 'execution-plan.json'), 'utf8'));
      planId = sharedPlanId(manifest);
      group = manifest.plan?.groups?.find(item => item.id === groupId);
    } catch { /* The builder diagnoses invalid plans; telemetry is optional. */ }
  }
  return {
    invocationId,
    run: {
      repository: repository || identity.repository || 'local/build',
      repositoryId: identity.repositoryId,
      runId: runId || identity.workflowRunId || invocationId,
      runAttempt: identity.runAttempt,
      workflow: identity.workflow || 'Local build', branch: identity.headRef || identity.ref,
      headSha: identity.headSha, sha: identity.checkoutSha, pullRequestNumber: identity.pullRequestNumber,
      title: event.pull_request?.title || event.head_commit?.message?.split('\n')[0] || env.GITHUB_WORKFLOW || 'Package build',
      actor: env.GITHUB_ACTOR || '', runUrl: identity.runUrl,
      commitMessage: event.head_commit?.message?.split('\n')[0] || '',
      eventName: env.GITHUB_EVENT_NAME || 'local', startedAtMs: now,
    },
    job: {
      jobId: jobId || groupId || identity.jobKey,
      name: name || (group?.consumers?.join(' / ')) || env.GITHUB_JOB || 'Package build',
      logicalJob: env.GITHUB_JOB || 'build', matrix: matrixStrings(parseMatrix(matrix)),
      system: system || group?.system || '', groupId, planId, dependencies: group?.needs || [],
      kind: group?.kind || (argumentValue(args, '--plan-sets') ? 'planner' : 'package'),
      githubJobUrl: identity.jobUrl, jobAttempt: identity.runAttempt,
      startedAtMs: now, checkRunId: identity.checkRunId,
    },
  };
}

export async function actionOutput(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  const delimiter = `nix-ci-${randomUUID()}`;
  await appendFile(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function signalExitCode(signal) {
  return 128 + (constants.signals[signal] || 1);
}

// Network work runs concurrently in a separate promise, with a disk queue
// between it and the builder. A collector outage never owns the child process.
export async function runWrapped({ command, args = [], cwd = process.cwd(), env = process.env, endpoint = '', reportUrl = '',
  reportDir = 'report', spoolDir, matrix = {}, name, system, token, audience = 'nix-ci-build',
  runId, jobId, repository, invocationId = randomUUID(), finalFlushMs = 5000, heartbeatMs = 5000,
  cancelGraceMs = 6000, logger = console.log, warning = console.warn, stdio = 'inherit',
  transportFactory = options => new GrpcTransport(options), onSpawn = () => {} } = {}) {
  if (!command) throw new Error('A builder executable is required');
  if (!Number.isFinite(finalFlushMs) || finalFlushMs < 0 || finalFlushMs > 60_000) throw new Error('Invalid final flush timeout');
  const startedAtMs = Date.now();
  const started = performance.now();
  const directory = commandReportDirectory(args, reportDir, cwd);
  const spoolDirectory = resolve(cwd, spoolDir || join(directory, 'telemetry', invocationId));
  const builderEnv = { ...env, NIX_CI_BUILD_ATTEMPT_ID: invocationId };
  let event = {};
  try { event = await readGitHubEvent(env); }
  catch { warning('GitHub event metadata is unavailable; the builder will continue.'); }
  const registration = await makeRegistration({ env, event, matrix, args, cwd, invocationId, name, system, runId, jobId, repository, now: startedAtMs });
  builderEnv.NIX_CI_BUILD_RUN_ID = `github:${registration.run.repository}:${registration.run.runId}:${registration.run.runAttempt}`;
  builderEnv.NIX_CI_BUILD_WORKER_ID = env.RUNNER_NAME || `worker-${process.pid}`;
  await mkdir(directory, { recursive: true });
  let spool, uploader, watcher, heartbeat;
  let telemetryError = false;
  let liveUrl = '';
  let lastWarning = 0;
  const warn = message => {
    if (Date.now() - lastWarning > 5000) { lastWarning = Date.now(); warning(message); }
  };
  const output = async (name, value) => {
    try { await actionOutput(name, value, env); }
    catch { telemetryError = true; warn('Could not write a GitHub action output; inspect the local report.'); }
  };
  await output('report-directory', directory);
  const emit = async event => {
    if (!spool) return;
    try { await spool.append(event); uploader?.notify(); }
    catch { telemetryError = true; warn('Live reporting could not persist an event; inspect the retained local report.'); }
  };
  if (endpoint) {
    try {
      spool = await DurableSpool.open(spoolDirectory, registration);
      await output('telemetry-spool', spoolDirectory);
      const displayedUrl = predictedReportUrl(reportUrl, registration);
      liveUrl = displayedUrl;
      if (displayedUrl) {
        logger(`Live build report: ${displayedUrl}`);
        await output('report-url', displayedUrl);
        if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `\n[Open the live build report](${displayedUrl})\n`);
      }
      const getToken = token || (env.GITHUB_ACTIONS ? oidcTokenSource({ audience, env }) : undefined);
      const transport = transportFactory({ endpoint, token: getToken });
      uploader = new ReliableUploader({
        spool, transport, onWarning: warn,
        prepareRegistration: async value => {
          if (!env.GITHUB_ACTIONS || token) return value;
          const claims = tokenClaims(await getToken({ signal: transport.abort?.signal }));
          if (!claims.check_run_id) throw new Error('GitHub OIDC token has no check-run identity');
          const checkRunId = String(claims.check_run_id);
          if (value.job.checkRunId && value.job.checkRunId !== checkRunId) throw new Error('Spool belongs to a different GitHub job');
          return { ...value, job: { ...value.job, checkRunId,
            jobId: value.job.groupId || jobId || `github:${checkRunId}`,
            githubJobUrl: `${env.GITHUB_SERVER_URL || 'https://github.com'}/${value.run.repository}/runs/${checkRunId}`,
          } };
        },
        onRegistered: response => {
          if (!displayedUrl && response.reportUrl) {
            const url = new URL(response.reportUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
            liveUrl = url.href;
            logger(`Live build report: ${liveUrl}`);
            void output('report-url', liveUrl);
          }
        },
      }).start();
      const extraDirectory = argumentValue(args, '--execute-plan') || argumentValue(args, '--run-plan') || argumentValue(args, '--aggregate-plan');
      watcher = new ReportWatcher({ directories: [directory, ...(extraDirectory ? [resolve(cwd, extraDirectory)] : [])], emit,
        onWarning: message => { telemetryError = true; warn(message); } });
      await watcher.initialize();
      await emit({ kind: 'invocation_start', entityId: invocationId, occurredAtMs: startedAtMs, status: 'running', startedAtMs });
      watcher.start();
      heartbeat = setInterval(() => {
        void emit({ kind: 'heartbeat', entityId: invocationId, occurredAtMs: Date.now(), elapsedSeconds: (performance.now() - started) / 1000 });
      }, heartbeatMs);
      heartbeat.unref();
    } catch {
      telemetryError = true;
      warn('Live reporting could not start; the build will continue with its local report.');
    }
  }

  let child, requestedSignal, escalation, childExited = false;
  const forward = signal => {
    if (!requestedSignal) requestedSignal = signal;
    if (!child || childExited) return;
    try { child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') warn('Could not signal the builder; process cleanup will be retried.'); }
    if (!escalation) {
      escalation = setTimeout(() => {
        // The builder normally stops Nix itself. Escalate the isolated process
        // group if that graceful cleanup does not finish within its deadline.
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') warn('Builder process group cleanup failed.'); }
      }, cancelGraceMs);
    }
  };
  const sigint = () => forward('SIGINT');
  const sigterm = () => forward('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  let outcome;
  try {
    outcome = await new Promise(resolveExit => {
      child = spawn(command, args, { cwd, env: builderEnv, stdio, detached: process.platform !== 'win32' });
      child.once('error', () => resolveExit({ code: 127, signal: null }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
      onSpawn(child);
      if (requestedSignal) forward(requestedSignal);
    });
    childExited = true;
    clearTimeout(escalation);
    if ((requestedSignal || outcome.signal) && process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') warn('Could not finish builder process group cleanup.'); }
    }
    clearInterval(heartbeat);
    if (watcher) {
      try { await watcher.stop(); }
      catch { telemetryError = true; warn('The last report snapshot could not be read.'); }
    }
    const exitCode = outcome.code ?? signalExitCode(outcome.signal);
    const cancelled = Boolean(requestedSignal || ['SIGINT', 'SIGTERM'].includes(outcome.signal));
    const status = cancelled ? 'cancelled' : outcome.signal ? 'interrupted' : exitCode === 0 ? 'success' : 'failed';
    const finishedAtMs = Date.now();
    await emit({ kind: 'invocation_finish', entityId: invocationId, occurredAtMs: finishedAtMs, status, terminal: true,
      startedAtMs, finishedAtMs, durationSeconds: (performance.now() - started) / 1000,
      result: String(exitCode), labels: { signal: outcome.signal || requestedSignal || '', telemetry: telemetryError ? 'incomplete' : 'complete' },
    });
    const final = uploader ? await uploader.stop({ timeoutMs: requestedSignal ? Math.min(1000, finalFlushMs) : finalFlushMs }) : { pending: spool?.pendingCount || 0 };
    if (final.pending) warn(`Live reporting has ${final.pending} unacknowledged events; retain the telemetry spool with this job's artifacts.`);
    const telemetryStatus = !endpoint ? 'disabled' : telemetryError || final.pending ? 'incomplete' : 'complete';
    await output('telemetry-status', telemetryStatus);
    if (endpoint && env.GITHUB_STEP_SUMMARY) {
      try {
        await appendFile(env.GITHUB_STEP_SUMMARY, `\n${liveUrl ? `[Open the live build report](${liveUrl}) · ` : ''}Live reporting: ${telemetryStatus}.${final.pending ? ' Pending events remain in the telemetry artifact.' : ''}\n`);
      } catch { warn('Could not append the live report link to the GitHub summary.'); }
    }
    await output('exit-code', String(cancelled && exitCode === 0 ? signalExitCode(requestedSignal || 'SIGTERM') : exitCode));
    return { exitCode: cancelled && exitCode === 0 ? signalExitCode(requestedSignal || 'SIGTERM') : exitCode,
      status, invocationId, reportDirectory: directory, spoolDirectory: endpoint ? spoolDirectory : undefined,
      pending: final.pending, telemetryError };
  } finally {
    clearInterval(heartbeat);
    clearTimeout(escalation);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    if (!childExited && child?.pid) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
    }
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const split = argv.indexOf('--');
  if (split === -1 || !argv[split + 1]) throw new Error('Usage: node live/run.mjs [options] -- EXECUTABLE [ARGS...]');
  const options = argv.slice(0, split);
  const supported = new Set(['--endpoint', '--report-url', '--report-dir', '--spool-dir', '--matrix', '--name', '--system', '--token-file', '--audience', '--run-id', '--job-id', '--repository', '--final-flush-ms', '--heartbeat-ms', '--cancel-grace-ms']);
  for (let index = 0; index < options.length; index += 2) {
    if (!supported.has(options[index]) || options[index + 1] === undefined) throw new Error('Invalid live wrapper option');
  }
  const get = name => argumentValue(options, name);
  let token;
  if (get('--token-file')) {
    const value = (await readFile(get('--token-file'), 'utf8')).trim();
    if (!value) throw new Error('The development token file is empty');
    token = async () => value;
  }
  const result = await runWrapped({
    command: argv[split + 1], args: argv.slice(split + 2), endpoint: get('--endpoint'), reportUrl: get('--report-url'),
    reportDir: get('--report-dir'), spoolDir: get('--spool-dir'), matrix: parseMatrix(get('--matrix') || '{}'),
    name: get('--name'), system: get('--system'), token, audience: get('--audience'), runId: get('--run-id'),
    jobId: get('--job-id'), repository: get('--repository'),
    ...(get('--final-flush-ms') ? { finalFlushMs: Number(get('--final-flush-ms')) } : {}),
    ...(get('--heartbeat-ms') ? { heartbeatMs: Number(get('--heartbeat-ms')) } : {}),
    ...(get('--cancel-grace-ms') ? { cancelGraceMs: Number(get('--cancel-grace-ms')) } : {}),
  });
  process.exitCode = result.exitCode;
}

if (basename(new URL(import.meta.url).pathname) === 'run.mjs' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch(() => { console.error('The live build wrapper could not start. Check its options and executable.'); process.exitCode = 2; });
}
