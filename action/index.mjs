import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { parseMatrix } from '../live/github.mjs';
import { argumentValue, runWrapped } from '../live/run.mjs';

const pinnedBuilder = 'github:nix-ocaml/nix-ci-build/639073f40b0f35d68db7d386a25f40bd06ef52b6';

function input(name) {
  return process.env[`INPUT_${name.toUpperCase().replaceAll(' ', '_')}`]?.trim() || '';
}

function installBuilder(reference) {
  return new Promise((resolveResult, reject) => {
    let output = '';
    const child = spawn('nix', ['build', '--accept-flake-config', '--no-link', '--print-out-paths', reference], { stdio: ['ignore', 'pipe', 'inherit'] });
    const forward = signal => { child.kill(signal); };
    const sigint = () => forward('SIGINT'), sigterm = () => forward('SIGTERM');
    process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
    const cleanup = () => { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); };
    child.stdout.on('data', bytes => { if (output.length < 64 * 1024) output += bytes.toString(); });
    child.once('error', () => { cleanup(); reject(new Error('Could not start Nix to obtain the pinned builder')); });
    child.once('exit', (code, signal) => {
      cleanup();
      const paths = output.trim().split('\n');
      if (code === 0 && paths.length === 1 && isAbsolute(paths[0])) resolveResult(`${paths[0]}/bin/nix-ci-build`);
      else reject(Object.assign(new Error('Could not obtain the pinned nix-ci-build executable'), { exitCode: signal ? 130 : code || 1 }));
    });
  });
}

async function main() {
  const args = JSON.parse(input('args') || '[]');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('args must be a JSON array of strings');
  if (input('flake')) args.push('--flake', input('flake'));
  if (!argumentValue(args, '--report-dir')) args.push('--report-dir', input('report-dir') || 'report');
  let command = input('executable');
  if (!command) command = await installBuilder(input('builder-flake') || pinnedBuilder);
  else if (command.includes('/') && !isAbsolute(command)) command = resolve(process.cwd(), command);
  const result = await runWrapped({
    command, args, endpoint: input('endpoint'), reportUrl: input('report-url'),
    reportDir: input('report-dir') || 'report', matrix: parseMatrix(input('matrix') || '{}'),
    name: input('name'), system: input('system'), audience: input('audience') || 'nix-ci-build',
    finalFlushMs: Number(input('final-flush-seconds') || '5') * 1000,
    warning: message => console.log(`::warning::${message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`),
  });
  process.exitCode = result.exitCode;
}

main().catch(error => {
  // These are fixed configuration diagnostics. Never print transport errors,
  // token contents, arbitrary argv, or the event payload in the action log.
  console.error(`::error::${error.message === 'args must be a JSON array of strings' ? error.message : 'The nix-ci-build action could not start; check its inputs and builder installation.'}`);
  process.exitCode = error.exitCode || 2;
});
