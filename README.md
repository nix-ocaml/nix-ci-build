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

## Understanding progress

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

## Reports

The report directory contains:

| File | Contents |
| --- | --- |
| `events.jsonl` | Chronological JSON events, flushed as work happens. |
| `results.json` | Current snapshot: context, package states, dependency activity, timings, uploads, and root failures. |
| `plan.json` | The evaluated build plan, including dependency and cache information. |
| `explanation.json` | Dependency paths and missing work for `--explain ATTRIBUTE`. |
| `summary.md` | A bounded Markdown report for GitHub's job summary. |
| `logs/` | Complete captured logs, including successful requests and failed dependencies. |

Snapshots and summaries are replaced atomically. Partial results remain useful
after an interrupted run. The summary includes cache counts, root failures and
affected packages, reproduction commands, slow requests and queue waits, and
the platform and tool versions. Full details stay in JSON and log files when
the summary would become too large.

Use `--output FILE` to choose the summary destination explicitly. In GitHub
Actions, the default destination is `GITHUB_STEP_SUMMARY`; outside Actions it
is stdout. The report directory always keeps its own `summary.md`.

## GitHub Actions

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

`--dry-run` evaluates and writes the plan without building or uploading.
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
