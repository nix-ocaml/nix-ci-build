# Shared dependency builds

Several package sets can need the same compiler, source fetcher, or native
library. Starting each set on an independent runner can build that derivation
several times before any runner publishes it. A shared plan assigns each
missing derivation to one execution group before the runners start.

The planner evaluates the sets once, checks the read caches, and emits two
matrices: shared prerequisites and package work. Workers import the saved
derivations, fetch their required outputs, and run the existing scheduler,
uploader, and reports. They do not evaluate the original flakes again.

## Configure the sets and runners

Create a JSON file such as `ci-sets.json`:

```json
{
  "sets": [
    {
      "id": "native-5.4",
      "flake": ".#hydraJobs.x86_64-linux.build_5_4"
    },
    {
      "id": "musl-5.4",
      "flake": ".#hydraJobs.x86_64-linux.musl_5_4"
    },
    {
      "id": "musl-5.6",
      "flake": ".#hydraJobs.x86_64-linux.musl_5_6"
    }
  ],
  "runners": {
    "x86_64-linux": "ubuntu-latest",
    "aarch64-linux": ["self-hosted", "linux", "arm64"]
  }
}
```

Use the actual attribute paths exposed by your flake. Set IDs must be unique.
Runner entries can be a GitHub runner label or an array of labels. The map is
keyed by the derivation's **build system**, so a cross compilation job normally
runs on the machine that executes its compiler, not on its output target.
Configure runner capacity, Nix system features, sandbox policy, and any remote
builders separately. The planner does not discover those capabilities.

Plan the work:

```sh
nix-ci-build \
  --plan-sets ci-sets.json \
  --copy-from https://cache.example.org \
  --copy-from https://cache.nixos.org \
  --report-dir shared-plan
```

`--copy-from` is repeatable. When provided, the list replaces the configured
read caches for planning and execution. With no explicit list, the configured
Nix substituters are used. The planner counts remote availability; an output
present only on the planning machine still needs an owner or a shared cache.

The directory contains:

| Path | Purpose |
| --- | --- |
| `execution-plan.json` | Versioned graph, exact output selections, group ownership, prerequisites, and evaluated attributes. |
| `matrix-shared.json` | GitHub matrix with one entry per shared prerequisite group. |
| `matrix-packages.json` | GitHub matrix with one entry per package execution group. |
| `evaluation.json` | Evaluated attributes and evaluation errors. |
| `store/` | A portable file binary cache containing the derivation and source closure. |
| `summary.md`, `logs/` | The human-readable plan and planning diagnostics. |

Transfer the **whole directory**, including `store/`, to every worker. A JSON
plan alone does not contain the recipes or source paths that Nix needs.
Evaluation errors stop planning and remain in `evaluation.json`.

## Execute a group

Use a group ID from either matrix:

```sh
nix-ci-build \
  --execute-plan shared-plan \
  --group GROUP_ID \
  --copy-from https://cache.example.org \
  --copy-from https://cache.nixos.org \
  --copy-to 's3://example-nix-cache' \
  --report-dir report
```

`--copy-to` is required for workers. The destination must be readable by later
workers through their read caches. Configure the usual Nix cache credentials,
trusted public keys, and signing settings on the runners; the tool does not
provision them. Production builds retain Nix's normal signature verification.

Before building, a worker imports the saved recipes and required prerequisite
outputs, then checks the current missing work against its assigned ownership.
An unavailable prerequisite fails the group before it can be rebuilt there.
Cache availability is refreshed on the worker; the planner's cache results do
not authorize skipping work. Build requests name the selected outputs rather
than requesting every output of each derivation.

A producer succeeds only after the required published outputs are visible in
its destination cache. A successful local build with an unsuccessful upload
does not release its consumers. Completed outputs and normal build reports are
retained even when another build or upload fails.

## GitHub Actions

The planner appends `shared`, `packages`, `has-shared`, and `has-packages` to
`GITHUB_OUTPUT`. Outside Actions, use `--github-output FILE` to write the same
values. Both matrix values are compact JSON objects with an `include` array;
entries contain `group`, `system`, `runner`, and `consumers`.

The [runnable demo](../.github/workflows/shared-plan-demo.yml) uses three jobs:
one planner, a shared-prerequisite matrix, and a package matrix. Its fixture has
two named sets that share different outputs of one tool, two private branches,
and an attribute alias. The fixture uses shell builtins rather than a real
compiler. Builder ledgers verify that the shared tool runs once and that each
package runner builds only its owned derivations.

The demo passes tiny `file://` output caches through artifacts from the same
workflow run. It needs no external cache credentials. It disables sandboxing
for its host-shell fixture and signatures for those temporary caches only;
those settings are not a production cache configuration. The ordinary
derivation bundle is separate from the built-output cache artifacts.

For a package-set workflow, keep the job and matrix structure, replace the
fixture setup with your sets JSON, and pass your durable cache URLs to both
stages. The cache upload/download artifact steps are then unnecessary; retain
the execution-plan artifact and the per-group reports. No additional flake
input or coordination service is required.

Keep these workflow rules when adapting it:

- Guard each matrix with its `has-*` output. GitHub evaluates the job condition
  before expanding its matrix, so an empty prerequisite stage can be skipped.
- Set `fail-fast: false` on both matrices. Keep build failures as failures;
  do not use `continue-on-error` on the build jobs.
- Let packages run after a failed or skipped prerequisite stage with
  `!cancelled() && needs.plan.result == 'success'` and the package guard.
  Each worker checks its own required outputs, so unaffected groups can finish.
- Upload reports with `if: always()` and unique group names, including reports
  from failed groups. A failed producer remains visible as a failed job.

These conditions follow GitHub's [job dependency and matrix rules](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif)
and [status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions).
GitHub's [dynamic matrix example](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations#using-an-output-to-define-two-matrices)
shows the same pattern of publishing JSON from a preceding job.

## Current boundaries

The first version groups connected missing shared dependencies into one
prerequisite job. It uses weakly connected components: dependencies connected
through their shared work stay together, even if a particular downstream
package needs only part of that component. This guarantees one owner without
introducing dependencies between prerequisite jobs, but a large shared
toolchain can become one large job.

Package jobs wait for the entire shared matrix to finish. GitHub's static job
graph does not give individual dynamic matrix entries arbitrary `needs`
relationships. The plan records each group's real prerequisites, and workers
enforce those boundaries, but this initial workflow uses a stage barrier.

Shared components spanning incompatible build systems fail planning. Unknown
required output paths and missing graph nodes also fail rather than producing
a plan that another runner cannot execute. Cached work is pruned before shared
ownership is assigned. Sharing uses derivation identity, not package names or
similar source code; distinct compiler options or dependency paths remain
distinct builds.

GitHub limits a matrix to 256 jobs and limits the size of job outputs. Keep
large plan graphs in the artifact, with only the compact matrices in job
outputs. Split oversized sets into separate workflow runs if necessary. See
[GitHub's matrix limits](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymatrix).

Run the local smoke test with real Nix and isolated stores:

```sh
nix develop -c dune build bin/main.exe
nix develop -c python3 -B test/shared_plan_real.py \
  _build/default/bin/main.exe --directory "$PWD/shared-plan-test-reports"
```
