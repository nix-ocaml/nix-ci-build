# nix-ci-build

`nix-ci-build` builds Nix package sets and reports their progress in GitHub
Actions. It uses `nix-eval-jobs` for evaluation and Nix for builds, substitutions,
and binary-cache uploads. It is designed for
[nix-ocaml/nix-overlays](https://github.com/nix-ocaml/nix-overlays).

It is currently unreleased and does not manage remote builders.

## Running a build

```sh
nix-ci-build \
  --flake '.#legacyPackages.x86_64-linux.ocamlPackages' \
  --report-dir report
```

Add `--copy-to URL` to upload successful outputs to a binary cache. All outputs
of a requested derivation are realized before copying. Upload failures are
reported separately from failed builds and make the command fail.

Evaluation completes before building begins. This lets the scheduler inspect the
whole dependency graph, combine attribute aliases, and rank the work globally.
Older versions began builds while evaluation was still running.

Requests whose outputs are already local or cached are skipped during
evaluation. Only requests that still need work expand their dependency graphs;
the plan counts downloads needed for those builds, excluding skipped requests.

Ready requests are prioritized using shared missing dependencies, estimated
critical-path duration, and time spent waiting. Nix still owns realization of
each derivation and shares dependency work between requests.

## Reusing newly cached dependencies

During a build, `--cache-refresh SECONDS` periodically checks whether missing
dependencies have appeared in the configured Nix substituters. It defaults to
30 seconds; use `--cache-refresh 0` to disable these checks. This can pick up
outputs published by another runner after the initial plan was created,
without coordinating the runners or adding flake dependencies.

Lookups refresh negative cache results so an earlier miss does not hide a
newly published output. An import starts only when every declared output is
already local or available from the selected cache. Two background workers
import eligible dependencies; polling and retry backoff are bounded to limit
cache traffic. Derivations that disable substitution or have unknown output
paths are skipped.

An import failure is a warning and normal builds continue. A background import
is cancelled when Nix starts building or downloading that dependency, when it
is no longer needed by queued or running requests, or when the main builds
finish. New cache hits can prune imports for queued requests; imports needed
by running requests continue because Nix may already be waiting on those inputs.
Running builds are never cancelled to pursue a cache import.
`--dry-run` does not import outputs.

## Understanding progress

A compact plan summarizes the work, followed by new requests, actual builds,
completed packages, and failures. Cached packages and routine downloads are
summarized in totals so a large package set does not bury useful progress in
thousands of messages. For example:

```text
PLAN    425 attributes evaluated · 420 unique root derivations (5 aliases) · 398 cached · 22 queued · 31 builds · 14 downloads
REQUEST piaf
BUILD   libpq-17.6 → caqti, piaf
STATUS  407/420 root derivations complete · cached 398 · built 9 · requests 4 · queued 9 · 12m30s elapsed
BUILD   libpq-17.6 (4m10s total activity) / phase buildPhase → caqti, piaf
FETCH   git-2.51.0 (18.2s total activity) → piaf
CACHE   cache sync 12/15 (2 active, 0 failed)
```

Heartbeats put active builds first, followed by downloads and waits, with the
longest-running activity first within each category. They name the packages
that need each dependency and include current Nix phases when available.
The duration is total observed activity, not time spent in the displayed phase.
Completion counts use unique root derivations; multiple attribute aliases can
refer to the same root, and evaluation errors are counted separately.
`--verbose` adds every lifecycle event to the console; the complete event
stream and logs are saved regardless of verbosity.

Progress distinguishes the package requests submitted to Nix from the
derivations Nix is actually building or downloading. A submitted package can be
waiting on a shared dependency or on Nix's own build slots. Its request time
includes those waits; its time in the tool's queue is recorded separately.

For example, Piaf can be submitted while the active derivation is a source
fetcher or Git. Dependency activity is associated with the packages that need
it, so a long request does not imply that Piaf itself has been compiling for
hours.

Failures are grouped by root derivation, with the affected attributes and
dependency paths. A failed dependency blocks its dependents; independent work
continues. Evaluation errors, download failures, build failures, upload
failures, and unfinished or cancelled requests remain distinguishable in the
report.

The heartbeat also reports completed and active dependency cache imports and
import warnings. Import details identify the dependency, its consumers, cache
source, output paths, and transfer time. Counts reflect the latest import state
for each dependency; events retain earlier attempts. These describe observed
imports and do not measure avoided builds or time saved.

## Reports

The report directory contains:

| File | Contents |
| --- | --- |
| `events.jsonl` | Chronological JSON events, flushed as work happens, including `cache-refresh`, `cache-import-start`, and `cache-import-finished`. |
| `results.json` | Current snapshot: context, package states, dependency activity, timings, uploads, root failures, and dependency imports in `cacheReuse`. |
| `plan.json` | The evaluated build plan, including dependency and cache information. |
| `explanation.json` | Dependency paths and missing work for `--explain ATTRIBUTE`. |
| `summary.md` | A bounded Markdown report for GitHub's job summary. |
| `logs/` | Complete captured build and transfer logs, plus diagnostic JSON for unexpected cache-query failures. |

Snapshots and summaries are replaced atomically. Partial results remain useful
after an interrupted run. The summary includes cache counts, root failures and
affected packages, reproduction commands, slow requests and queue waits, and
the platform and tool versions. Full details stay in JSON and log files when
the summary would become too large.

Ordinary cache misses do not produce warnings. Unexpected query failures name
the store and retain their command, response, and diagnostics under `logs/`.
Local checks use direct store validity queries. An incomplete remote metadata
response is recovered with a batched validity check and one metadata retry,
so a missing path does not hide cached hits in the same batch.

If `nix-eval-jobs` does not support `--version`, the Nix package wrapper supplies
its package version. The report labels this fallback as `Nix package`.

Use `--output FILE` to choose the summary destination explicitly. In GitHub
Actions, the default destination is `GITHUB_STEP_SUMMARY`. Outside Actions the
console prints the summary's location instead of the full Markdown. The
report directory always keeps its own `summary.md`.

## GitHub Actions

Actions logs use colored status labels, short expandable plan and failure
groups, and error annotations that point to the cause of a failure. Set
`NO_COLOR` to disable colors. Groups are emitted as complete blocks so output
from concurrent builds does not get folded into another package's group.

The job summary leads with the outcome and totals, followed by root failures,
affected packages, reproduction commands, and the slowest observed work.
Detailed timing, cache activity, and environment information are expandable.
Evaluation errors remain visible even when no package can be planned.

```yaml
- name: Build package set
  run: |
    nix-ci-build \
      --flake '.#legacyPackages.x86_64-linux.ocamlPackages' \
      --report-dir report
- name: Upload build report
  id: reports
  if: always()
  timeout-minutes: 3
  uses: actions/upload-artifact@v7
  with:
    name: package-report-${{ runner.os }}-${{ github.run_attempt }}
    path: report/
    if-no-files-found: ignore
    retention-days: 14
- name: Link build report
  if: ${{ always() && steps.reports.outputs.artifact-url != '' }}
  env:
    REPORT_URL: ${{ steps.reports.outputs.artifact-url }}
  run: printf '\n[Full logs and results](%s)\n' "$REPORT_URL" >> "$GITHUB_STEP_SUMMARY"
```

Include any additional matrix dimensions in the artifact name. This uploads
one artifact containing the whole report, rather than one artifact per
package. Logs, annotations, summaries, and this upload do not require an
additional GitHub API token or `checks: write` permission.

The final step links to the artifact URL returned by the upload action. The
builder records log paths inside the report; the artifact link becomes
available after the upload completes.

Live progress appears in the step's log. GitHub uploads `GITHUB_STEP_SUMMARY`
after the step completes and displays the combined summary when the job
finishes; repeatedly writing the file does not create a live dashboard. See
[GitHub's job-summary documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary).

## Planning and previous runs

`--dry-run` evaluates and writes the plan without building, uploading, or
importing newly cached dependencies.
`--explain ATTRIBUTE` explains the selected attribute's dependencies and cache
requirements. `--compare FILE` compares the current plan with a previous
`plan.json` or `results.json`, including derivations whose paths changed and
newly uncached work.

```sh
nix-ci-build --flake '.#legacyPackages.x86_64-linux.ocamlPackages' \
  --dry-run --compare previous/plan.json --report-dir report

nix-ci-build --flake '.#legacyPackages.x86_64-linux.ocamlPackages' \
  --dry-run --explain piaf --report-dir report
```

Reports are ordinary files, so a later run can download an earlier artifact
and use its results as scheduling history or its plan as a comparison:

```sh
gh run download RUN_ID --name ARTIFACT_NAME --dir previous

nix-ci-build --flake '.#legacyPackages.x86_64-linux.ocamlPackages' \
  --history previous/results.json --report-dir report
```

Use reports from a comparable platform and package configuration. Artifact
retention limits how long this history remains available. History estimates
are scheduling hints; current Nix cache information decides what still needs
to be built.

## Concurrency and retries

`--jobs N` retains the legacy default of N evaluation workers and up to 2N
concurrent Nix requests. Those requests can share dependencies, so this is not
a count of active compiler processes. Nix's build and core limits also affect
actual resource use.

Uploads use a separate pool of two workers. `--heartbeat SECONDS` controls the
progress interval; it defaults to 30 seconds.

`--batch-size N` optionally submits multiple ready package requests together;
the default is one. `--retries N` defaults to two retries for recognized
transient infrastructure failures. Deterministic build failures are not
retried. Build failures and dependency failures still appear in the final
report even while independent packages continue.

With `--copy-to`, successful dependencies built during the run are uploaded
alongside the requested outputs. This preserves reusable tools and source fetchers on
fresh runners. The cache step does not build otherwise unnecessary outputs
merely to upload them.

## Development

```sh
nix develop -c dune runtest
nix build -L
```

The integration tests use fake Nix commands and do not require network access
or a Nix daemon. To preserve their reports and traces, set
`NIX_CI_TEST_REPORTS` to an absolute directory before running the tests. CI
uploads these fixtures as one artifact, including reports from failing tests.

```sh
NIX_CI_TEST_REPORTS="$PWD/test-reports" nix develop -c dune runtest --force
```

The opt-in smoke tests also exercise real Nix builds and a local `file://`
binary cache:

```sh
nix develop -c dune build bin/main.exe
nix develop -c python3 -B test/real_test.py \
  _build/default/bin/main.exe "$PWD/real-test-reports"
```

These fixtures have no flake inputs and use the host's `/bin/sh`, so the test
subprocesses request `sandbox = false`. The runner must permit that option.
Each run creates unique fixture derivations. One test deletes the unused
output of its own fixture dependency and verifies that caching does not build
it again. These tests are separate from the default sandboxed test suite.

## License & Copyright

Copyright (c) 2024 António Nuno Monteiro

nix-ci-build is distributed under the 3-Clause BSD License, see [LICENSE](./LICENSE).
