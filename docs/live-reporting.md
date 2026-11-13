# Live GitHub builds

The custom action, gRPC collector, protobuf contract, and local visualizer live
in this repository. The action wraps the existing builder: it works with a
single package set, shared planning, an individual matrix worker, or the local
DAG runner. It does not replace Nix's execution or cache decisions.

## Use the action

Install Nix as usual, then replace the builder's shell step:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: cachix/install-nix-action@v31
      - uses: nix-ocaml/nix-ci-build/action@live-build-visualizer
        id: build
        with:
          flake: .#legacyPackages.x86_64-linux.ocamlPackages
          endpoint: https://your-domain.ngrok.app
          report-url: http://127.0.0.1:8799
          report-dir: report
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: build-report-${{ github.run_attempt }}
          path: report/
```

The branch reference is for this preview; use the reviewed commit SHA when
integrating it elsewhere. The action bundles its Node dependencies, so consuming
workflows need no npm install. It uses an immutable builder revision by default.
Set `executable: nix-ci-build` to reuse a builder already installed or imported
on the runner. This is useful for a large matrix: build the tool once and import
its exact closure on each worker, as in the existing demo.

`endpoint` is the TLS gRPC ingestion address. `report-url` is the browser address
on your machine; the ngrok ingestion URL does not serve the dashboard. The
action prints the run link immediately and writes it into its final summary.
An empty endpoint keeps the ordinary offline build/report behavior.

Extra command arguments are a JSON array, without shell interpolation:

```yaml
- uses: nix-ocaml/nix-ci-build/action@live-build-visualizer
  id: plan
  with:
    executable: nix-ci-build
    endpoint: ${{ vars.NIX_CI_LIVE_ENDPOINT }}
    report-dir: plan
    args: '["--plan-sets", "sets.json"]'
```

The planner's `shared`, `packages`, `has-shared`, and `has-packages` outputs
remain available as step outputs for `fromJSON(...)` dynamic matrices. On each
worker, pass `matrix: ${{ toJSON(matrix) }}` and the usual `--execute-plan` and
`--group` arguments. The planner announces the groups and dependencies before
any worker starts; the dashboard attaches incoming invocations to those groups.

The [shared dependency demo](../.github/workflows/shared-plan-demo.yml) is a
complete example, including the portable plan, exact builder closure, artifact
caches, and reports. Its manual dispatch accepts `live-endpoint` and `report-url`;
the endpoint can also be set as the `NIX_CI_LIVE_ENDPOINT` repository variable.

## Start the local collector and visualizer

Use Node 24 or newer (`nix develop` includes it):

```sh
npm --prefix live ci
npm --prefix live run build
NIX_CI_LIVE_REPOSITORIES=nix-ocaml/nix-ci-build,nix-ocaml/nix-overlays \
NIX_CI_LIVE_OIDC_AUDIENCE=nix-ci-build \
  npm --prefix live start
```

Open <http://127.0.0.1:8799>. The collector persists data in SQLite and exposes
gRPC on `127.0.0.1:50051`. Both listeners bind to loopback. Configuration:

| Variable | Purpose |
| --- | --- |
| `NIX_CI_LIVE_REPOSITORIES` | Required comma-separated repository allowlist. |
| `NIX_CI_LIVE_OIDC_AUDIENCE` | Required OIDC audience; the action defaults to `nix-ci-build`. |
| `NIX_CI_LIVE_DB` | SQLite file; defaults to `live/data/events.sqlite` in this checkout. |
| `NIX_CI_LIVE_HTTP_PORT` | Browser/read API port; default `8799`. |
| `NIX_CI_LIVE_GRPC_PORT` | Ingestion port; default `50051`. |
| `NIX_CI_LIVE_GITHUB_TOKEN` | Optional collector-side token with Actions read access for job/step reconciliation. |

The local UI extends the existing Druids preview with repository/run browsing,
PR/branch/commit metadata, workflow attempts, the evolving matrix, and per-job
build waterfalls. It uses the published Druids package as a dependency; it is
not included in the action bundle or the Nix builder. Browser updates use SSE;
runner-to-collector uploads use gRPC/protobuf.

With GitHub reconciliation enabled, the dashboard also has GitHub's runner
queues, steps, and final conclusions. The token stays on the collector. Without
it, the UI reports observed builder state and missing heartbeats; successful
builder invocations alone cannot establish the result of a whole workflow.

## Expose ingestion with ngrok

The project's Nix shell includes ngrok. Configure your account locally from
`nix develop`, then add the endpoint from
[`live/ngrok.example.yml`](../live/ngrok.example.yml) to your private ngrok v3
configuration, optionally setting your reserved domain, and start it:

```sh
nix develop -c ngrok start nix-ci-build
```

The endpoint forwards to `http://127.0.0.1:50051` with
`upstream.protocol: http2`. ngrok terminates TLS and forwards HTTP/2 cleartext
to the local gRPC server; ordinary HTTP/1.1 forwarding does not carry gRPC.
See ngrok's [HTTP/2 forwarding documentation](https://ngrok.com/docs/gateway/endpoints/http#http2-forwarding).

Use the resulting HTTPS address as the action's `endpoint`. GitHub supplies a
short-lived OIDC token with the configured audience; the collector verifies
the signature, issuer, expiry, repository, workflow attempt, and job identity.
There is no long-lived upload secret to add to repository settings. See the
[GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

## Delivery and lifecycle

The uploader writes binary protobuf batches to a local spool before sending
them. The collector acknowledges a contiguous sequence only after committing
the events to SQLite. Identical resends are safe; conflicting duplicates and
sequence gaps are rejected. Distinct invocation/stream identities prevent
parallel workers and retries from sharing a sequence space.

Metadata and plan dictionaries are sent when discovered. Progress travels as
batched deltas over a persistent gRPC connection with gzip compression. The
protocol carries normalized metadata and activity, not raw build logs or the
runner environment. Complete logs remain in the build's report artifact.

Reporting runs asynchronously and does not change the builder's exit code.
Connection failures cause retry/backoff, with a bounded final flush and pending
events retained in the report directory. A terminated runner can lose events
not yet written or uploaded; missing heartbeats remain visibly stale, rather
than being interpreted as success. GitHub reconciliation can establish the
actual cancellation or job failure separately.

The first service is a single local collector with durable storage. It does
not yet schedule remote runners, provide multi-user dashboard authorization,
or collect raw log streams. These can build on the same run/job identities and
versioned protobuf service without changing the package-set planner.

## Development

```sh
npm --prefix live test
npm --prefix live run build
npm --prefix live run build:action
```

To exercise the browser too, install Chromium with
`npm --prefix live exec -- playwright install chromium`, then run
`NIX_LIVE_BROWSER_TESTS=1 npm --prefix live test`. CI runs these checks and an
authenticated transport fixture using a real GitHub OIDC token.

For a real Nix run through the collector, use
`node live/real-smoke.mjs --builder /absolute/path/to/nix-ci-build --http-port 8799 --keep-running`
inside the development shell. It plans two fixture package sets, executes their
shared prerequisite once, and leaves the dashboard open with the collected
evidence. This uses local development credentials, separately from the OIDC test.

The checked-in action bundle is reproducible from `live/package-lock.json`.
CI rebuilds it and checks for differences. Changes to the wire format belong
in [`reporting.proto`](../proto/nix_ci_build/v1/reporting.proto); preserve field
numbers when evolving it.

Local integration tests use an explicitly enabled development authenticator
with a private token file. Production mode never falls back to development
authentication when OIDC configuration is missing.
