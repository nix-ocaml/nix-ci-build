The action runs the existing builder and sends structured progress to a live collector. Install Nix first. Give the job `id-token: write`; the collector authenticates the job through GitHub OIDC, so no repository secret is needed.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  # Install Nix and check out the package-set repository first.
  - uses: nix-ocaml/nix-ci-build/action@<pinned-commit>
    id: build
    with:
      endpoint: https://collector.example.com
      report-url: http://127.0.0.1:8799
      flake: .#packages.x86_64-linux
      matrix: ${{ toJSON(matrix) }}
      args: '["--jobs", "4"]'
  - uses: actions/upload-artifact@v7
    if: always()
    with:
      name: build-report
      path: ${{ steps.build.outputs.report-directory }}
```

`endpoint` is the TLS gRPC origin; `report-url` is the local visualizer's browser address. Leave `endpoint` empty to use the same action without live reporting. `matrix` is optional: GitHub's verified check-run ID distinguishes parallel jobs automatically, while matrix coordinates make them easier to understand. Do not put secrets in metadata inputs.

Set `executable` to a builder already available in the job, such as an imported Nix store path. Otherwise the action obtains the immutable revision in `builder-flake` through Nix. The action bundles its Node dependencies and protobuf schema; it does not install JavaScript dependencies or rely on files in the package-set checkout.

All existing modes work through the `args` JSON array. For example:

```yaml
- uses: nix-ocaml/nix-ci-build/action@<pinned-commit>
  id: plan
  with:
    executable: ./result/bin/nix-ci-build
    args: '["--plan-sets", "sets.json"]'
    report-dir: plan
    endpoint: ${{ vars.NIX_CI_LIVE_ENDPOINT }}
    report-url: ${{ vars.NIX_CI_LIVE_REPORT_URL }}
```

The planner's `shared`, `packages`, `has-shared`, and `has-packages` outputs pass through unchanged. A worker uses `args: '["--execute-plan", "plan", "--group", "GROUP_ID"]'`. The plan and worker report files remain compatible with artifact-based reports.

The action prints a live URL immediately when `report-url` is supplied and adds it to the final job summary. Its `telemetry-status` output is `complete`, `incomplete`, or `disabled`. Delivery failures preserve the builder's exit code. Unacknowledged protobuf events remain under `report/telemetry/`; keep the report artifact when reporting is incomplete. The queue is bounded to 256 MiB or 100,000 pending events, with space reserved for the final invocation state. Source reports remain available if that bound is reached.

The wrapper forwards cancellation to the builder and enforces a cleanup deadline. A forcibly killed runner cannot emit a final event: the collector must show its heartbeat as stale until GitHub reconciliation establishes the outcome.

For a local collector with explicit development authentication:

```sh
node live/run.mjs --endpoint http://127.0.0.1:50051 \
  --report-url http://127.0.0.1:8799 \
  --repository local/nix-ci-build --run-id example --job-id native \
  --token-file /path/to/local-token --report-dir report -- \
  /path/to/nix-ci-build --flake .#packages.x86_64-linux --report-dir report
```

Build the checked-in action bundle with `npm run build:action` from `live/`.
