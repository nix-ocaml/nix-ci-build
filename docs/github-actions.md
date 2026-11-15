# Build package sets with one workflow call

Keep the package selection and cache settings in your repository. The reusable
workflow handles planning, shared prerequisites, package workers, and the
combined report:

```yaml
name: Packages
on:
  pull_request:
  push:
    branches: [master]

permissions:
  contents: read

jobs:
  build:
    uses: nix-ocaml/nix-ci-build/.github/workflows/build.yml@<commit>
    with:
      config: ci/build.json
    secrets:
      NIX_CACHE_SIGNING_KEY: ${{ secrets.NIX_CACHE_SIGNING_KEY }}
      AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

Replace `<commit>` with the reviewed nix-ci-build revision. This single pin
selects the workflow, its helper, and the builder source. The workflow checks
out its own `job.workflow_repository` at `job.workflow_sha`; it does not use the
calling repository's SHA to locate nix-ci-build. These context properties
require GitHub.com and are not available on GitHub Enterprise Server. See
[GitHub's workflow identity documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#example-usage-of-job-context-workflow-identity).

Within the same organization, `secrets: inherit` can replace the explicit
mapping when the secrets already use these names. AWS credentials, including
the optional `AWS_SESSION_TOKEN`, are only needed for caches that use them.
The signing key is required for the builder artifacts and published outputs.
Its public key must appear in the configuration. Never put private keys or
credentials in the JSON file. Fork PRs do not receive repository secrets;
call this publishing workflow only for events with the required credentials.

For example, `ci/build.json` selects three entire package sets:

```json
{
  "sets": [
    {"id": "native-5.5", "flake": ".#hydraJobs.x86_64-linux.build_5_5"},
    {"id": "musl-5.5", "flake": ".#hydraJobs.x86_64-linux.musl_5_5"},
    {"id": "musl-5.6", "flake": ".#hydraJobs.x86_64-linux.musl_5_6"}
  ],
  "cache": {
    "read": ["https://cache.example.org", "https://cache.nixos.org"],
    "write": "s3://builds?region=us-east-1&compression=zstd",
    "publicKeys": ["cache.example.org-1:YOUR_PUBLIC_KEY"]
  }
}
```

Use actual flake attributes from your repository. Each selection may refer to
an attribute set or a single derivation. Adding selections changes this list;
the workflow automatically generates the required matrix jobs. The file can be
generated from your existing package-set definitions and checked in, avoiding
a second hand-maintained CI matrix.

The read caches must expose outputs written to the publishing destination.
For R2, for example, `write` can use the S3 endpoint while `read` uses your
public cache URL. The helper supplies the signing-key file when publishing;
do not include a `secret-key` query parameter yourself. Existing Nix signature
verification remains enabled for builder imports and package work.

The workflow adds the evaluator's upstream binary cache when bootstrapping
nix-ci-build. Package planning and execution use your explicitly configured
read caches. It builds one binary per required build system, exports signed
closures through Actions artifacts, and reuses them in workers. A fully cached
plan skips the worker matrices and still produces a successful report.

## Optional settings

`runners` overrides the default build-system mapping:

```json
{
  "x86_64-linux": "ubuntu-latest",
  "aarch64-linux": "ubuntu-24.04-arm",
  "aarch64-darwin": "macos-latest"
}
```

Values may also be arrays of self-hosted runner labels. These describe the
machine executing a derivation, including its cross compiler. They are not
the target platform of the generated binaries. The planner runs on x86_64
Linux; additional builder jobs are emitted only for other systems with missing
work. Unknown build systems require an explicit runner mapping.

`timeoutMinutes` sets the shared and package worker timeout (1–360; default
360). Planning and additional builder bootstraps have a 30-minute timeout;
reporting has a 10-minute timeout. `nixConfig` accepts additional public Nix
configuration, such as required system features. It is applied consistently
on the planner and workers.

For a bounded rollout, optional `limits` can restrict planned work:

```json
{
  "maxBuilds": 6,
  "maxBoundaryNarBytes": 2147483648,
  "allowedDerivations": [
    ".#packages.x86_64-linux.example",
    "/nix/store/REVIEWED_HASH-library.drv"
  ]
}
```

`allowedDerivations` accepts flake references resolving to individual
derivations or exact reviewed derivation paths. Every missing derivation must
be in that set. `maxBuilds` caps unique missing derivations; the boundary limit
caps distinct uncompressed NAR content of their cached prerequisites. It does
not measure network traffic. Bounds fail before matrix outputs are published,
and workers check the saved ownership guard before starting work. Ordinary
package-set builds can omit `limits`.

An optional workflow input `name` changes the artifact namespace (default
`build`). Use different names if you call the reusable workflow multiple times
in one Actions run. This is not necessary when supplying all sets to one call.

## Results and failures

The reusable workflow returns a `report-url` output and links the combined
report from its job summary. The artifact includes the HTML report, original
worker attempts, configuration, guard results, and planning evidence. Builder
bootstrap and import timings are retained separately from package builds.

Independent work continues after a prerequisite failure, but each worker must
import its own required published outputs before building. Failed publication
remains a build failure. Missing or failed worker reports make the combined
report job fail; rendering a report does not convert a failed build into a
successful workflow. Empty plans are successful. Retrying failed workers keeps
their previous attempts in the same report. Re-running planning starts a new
report generation, so old worker reports do not make a newly cached plan appear
incomplete; the old artifacts remain available in Actions.

This workflow uses the same
[shared-plan execution model and current boundaries](shared-dependencies.md#current-boundaries)
as the CLI. In particular, GitHub package jobs wait for the whole prerequisite
matrix. It does not require the live dashboard or a GitHub App.
