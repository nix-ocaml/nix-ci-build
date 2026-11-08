#!/usr/bin/env python3
"""Opt-in tests against real Nix and nix-eval-jobs, outside the default test suite.

Usage: python3 test/real_test.py _build/default/bin/main.exe [OUTPUT_DIRECTORY]

The fixture intentionally uses /bin/sh and only shell builtins. Its subprocesses
request sandbox=false, with no persistent Nix configuration changes. The runner
must be permitted to disable sandboxing; no external flake inputs are used.
"""

import atexit
import errno
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit(__doc__)
    binary = Path(sys.argv[1]).resolve()
    if not binary.is_file():
        raise SystemExit(f"Build the executable first: {binary}")
    for command in ("nix", "nix-eval-jobs"):
        if shutil.which(command) is None:
            raise SystemExit(f"{command} must be on PATH; run inside nix develop")

    directory = Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else Path(tempfile.mkdtemp(prefix="nix-ci-build-real-"))
    directory.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    environment["NIX_CONFIG"] = environment.get("NIX_CONFIG", "") + "\n" + "\n".join(
        ["experimental-features = nix-command flakes", "sandbox = false", "access-tokens =", "substituters =", ""]
    )
    # Keep the opt-in run from overwriting its caller's Actions step summary.
    environment.pop("GITHUB_STEP_SUMMARY", None)
    environment.pop("GITHUB_ACTIONS", None)
    command_number = 0

    def run(arguments, *, expected=0, env=None):
        nonlocal command_number
        command_number += 1
        result = subprocess.run([str(arg) for arg in arguments], env=environment if env is None else env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=300)
        (directory / f"command-{command_number:02d}.log").write_text(result.stdout)
        if expected is not None and result.returncode != expected:
            raise AssertionError(f"Command failed ({result.returncode}, expected {expected}): {arguments}\n{result.stdout[-12000:]}")
        return result

    system = run(["nix", "eval", "--impure", "--raw", "--expr", "builtins.currentSystem"]).stdout.strip()
    source = Path(__file__).parent / "real" / "flake.nix"
    fixture = directory / "fixture"
    fixture.mkdir(exist_ok=True)
    # Nix's build user must reach the FIFO even when OUTPUT_DIRECTORY or the
    # caller's normal temporary directory is private. Only these disposable
    # control files are shared; logs and reports retain their usual permissions.
    reuse_control = Path(tempfile.mkdtemp(prefix="nix-ci-build-gates-", dir="/tmp"))
    reuse_control.chmod(0o777)
    atexit.register(shutil.rmtree, reuse_control, ignore_errors=True)
    reuse_gate = reuse_control / "gate.fifo"
    reuse_started = reuse_control / "gate-started"
    reuse_built = reuse_control / "dependency-built"
    os.mkfifo(reuse_gate, 0o600)
    reuse_gate.chmod(0o666)
    for marker in (reuse_started, reuse_built):
        marker.unlink(missing_ok=True)
    fixture_source = source.read_text().replace("FIXTURE_RUN_ID", uuid.uuid4().hex)
    for placeholder, value in (
        ("FIXTURE_REUSE_GATE", reuse_gate),
        ("FIXTURE_REUSE_STARTED", reuse_started),
        ("FIXTURE_REUSE_BUILT", reuse_built),
    ):
        # Both JSON and Nix quoted strings accept these escapes; Nix also
        # requires protecting interpolation syntax in an unusual parent path.
        quoted = json.dumps(str(value)).replace("${", r"\${")
        fixture_source = fixture_source.replace(f'"{placeholder}"', quoted)
    (fixture / "flake.nix").write_text(fixture_source)

    def flake(group):
        # Force a path flake even when OUTPUT_DIRECTORY is inside a checkout;
        # otherwise Nix would require the generated fixture to be Git-tracked.
        return f"path:{fixture}#legacyPackages.{system}.{group}"

    def build(name, group, *arguments, expected=0):
        report = directory / name
        result = run([binary, "--flake", flake(group), "--report-dir", report, "--output", report / "summary.md", "--jobs", "1", "--heartbeat", "0.2", *arguments], expected=expected)
        snapshot = json.loads((report / "results.json").read_text())
        for event in (report / "events.jsonl").read_text().splitlines():
            json.loads(event)
        assert snapshot["schemaVersion"] == 1
        return snapshot, result

    def valid(path):
        return run(["nix", "path-info", path], expected=None).returncode == 0

    def package_outputs(group):
        data = run(["nix", "eval", "--json", flake(group), "--apply", "packages: builtins.mapAttrs (_: p: builtins.listToAttrs (map (name: { inherit name; value = p.${name}.outPath; }) p.outputs)) packages"])
        return json.loads(data.stdout)

    def wait_for(predicate, process, description, timeout=60):
        deadline = time.monotonic() + timeout
        while not predicate():
            if process.poll() is not None:
                raise AssertionError(f"Process exited before {description}: {process.returncode}")
            if time.monotonic() >= deadline:
                raise AssertionError(f"Timed out waiting for {description}")
            time.sleep(0.05)

    def release_gate():
        try:
            fd = os.open(reuse_gate, os.O_WRONLY | os.O_NONBLOCK)
        except OSError as error:
            if error.errno == errno.ENXIO:
                return False
            raise
        try:
            with os.fdopen(fd, "w") as pipe:
                pipe.write("continue\n")
        except BrokenPipeError:
            return False
        return True

    def stop_gated_process(process):
        # Release any live fixture reader even if a failed assertion interrupts
        # the test, then disconnect Nix so its daemon can cancel remaining work.
        release_gate()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    def opportunistic_reuse():
        outputs = package_outputs("reusePreparation")
        dependency = outputs["reuseMulti"]
        dependency_paths = list(dependency.values())
        assert set(dependency) == {"out", "dev"}, dependency
        staging = directory / "reuse-staging-cache"
        public = directory / "reuse-published-cache"
        staging.mkdir(exist_ok=True)
        public.mkdir(exist_ok=True)
        # A daemon-side lookup may initialize this directory as root. Create it
        # as the test user first so the later publication can write its NARs.
        (public / "nar").mkdir(exist_ok=True)
        # An empty but valid cache ensures the first substitution attempt is a
        # real miss, rather than failure to open the cache itself.
        (public / "nix-cache-info").write_text("StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n")
        secret_key = directory / "reuse-cache-secret-key"
        public_key = directory / "reuse-cache-public-key"
        run(["nix-store", "--generate-binary-cache-key", f"nix-ci-real-{uuid.uuid4().hex}",
             secret_key, public_key])

        producer_log = directory / "reuse-producer.log"
        with producer_log.open("w") as log:
            producer = subprocess.Popen(
                ["nix", "build", "--no-link", f"{flake('reusePreparation')}.reuseMulti^*"],
                env=environment, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                wait_for(reuse_started.exists, producer, "producer prerequisite to start")
                wait_for(release_gate, producer, "producer FIFO reader")
                assert producer.wait(timeout=60) == 0, producer_log.read_text()
            finally:
                stop_gated_process(producer)
        assert reuse_built.read_text() == "built\n"
        run(["nix", "store", "sign", "--key-file", secret_key, *dependency_paths])
        run(["nix", "copy", "--to", staging.as_uri(), *dependency_paths])
        secret_key.unlink()
        # These paths belong only to this unique fixture. Clear the producer's
        # local results so the consumer must miss substitution and await inputs.
        run(["nix-store", "--delete", *dependency_paths, outputs["reuseGate"]["out"]])
        assert all(not Path(path).exists() for path in dependency_paths)
        reuse_started.unlink()
        reuse_built.unlink()

        reuse_environment = dict(environment)
        reuse_environment["NIX_CONFIG"] += "\n" + "\n".join([
            f"substituters = {public.as_uri()}",
            # Trust only this fixture's temporary signing key, without changing
            # the user's or daemon's persistent Nix configuration.
            f"extra-trusted-public-keys = {public_key.read_text().strip()}", "",
        ])
        report = directory / "opportunistic-reuse"
        consumer_log = directory / "reuse-consumer.log"
        with consumer_log.open("w") as log:
            consumer = subprocess.Popen(
                [str(binary), "--flake", flake("reuse"), "--report-dir", str(report),
                 "--output", str(report / "summary.md"), "--jobs", "1",
                 "--heartbeat", "0.1", "--cache-refresh", "0.05"],
                env=reuse_environment, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                wait_for(reuse_started.exists, consumer, "consumer prerequisite to start")
                assert not reuse_built.exists(), "dependency started before its gated input completed"
                # Publish only now: the root's Nix request is already running
                # and reuseMulti has passed its unsuccessful substitute lookup.
                run(["nix", "copy", "--from", staging.as_uri(), "--to", public.as_uri(),
                     *dependency_paths])
                wait_for(lambda: all(Path(path).exists() for path in dependency_paths),
                         consumer, "all dependency outputs to be imported")
                # checkPathValidity after the input finishes must see *every*
                # output, including dev which the consumer did not request.
                for path in dependency_paths:
                    assert valid(path), path
                wait_for(release_gate, consumer, "consumer FIFO reader")
                assert consumer.wait(timeout=60) == 0, consumer_log.read_text()
            finally:
                stop_gated_process(consumer)
        snapshot = json.loads((report / "results.json").read_text())
        assert snapshot["status"] == "success", snapshot
        assert not reuse_built.exists(), "Nix rebuilt a dependency imported while awaiting its input"
        events = [json.loads(line) for line in (report / "events.jsonl").read_text().splitlines()]
        imports = [event for event in events if event["type"] == "cache-import-start"
                   and "-reuse-multi-" in event.get("drvPath", "")]
        assert len(imports) == 1 and set(imports[0]["paths"]) == set(dependency_paths), imports
        completed = [event for event in events if event["type"] == "cache-import-finished"
                     and event.get("drvPath") == imports[0]["drvPath"]]
        assert len(completed) == 1 and completed[0]["state"] == "imported", completed
        dependency_activities = [drv for drv in snapshot["derivations"] if "-reuse-multi-" in drv["name"]]
        assert all(drv.get("buildSeconds", 0) == 0 for drv in dependency_activities), dependency_activities
        reuse_gate.unlink()

    cache = directory / "cache"
    cache.mkdir(exist_ok=True)
    success, _ = build("success", "success", "--copy-to", cache.as_uri())
    assert success["status"] == "success", success
    assert len(success["jobs"]) == 3
    assert all(job["state"] == "built" for job in success["jobs"])
    shared = [drv for drv in success["derivations"] if "-shared-" in drv["name"]]
    assert len(shared) == 1, shared
    assert shared[0]["state"] == "built", shared
    assert len(shared[0]["neededBy"]) == 2, shared
    outputs = package_outputs("success")
    for package in outputs.values():
        for path in package.values():
            assert valid(path), path
            run(["nix", "path-info", "--store", cache.as_uri(), path])
    assert len(outputs["multi"]) == 2
    assert all(upload["state"] == "uploaded" for upload in success["uploads"])

    cached, _ = build("cached", "success")
    assert all(job["state"] == "cached" for job in cached["jobs"]), cached
    assert not cached["derivations"], cached["derivations"]

    failure, _ = build("failure", "failure", expected=1)
    assert failure["status"] == "failed", failure
    assert len(failure["rootFailures"]) == 1, failure["rootFailures"]
    assert len(failure["rootFailures"][0]["affected"]) == 2
    states = {attr: job["state"] for job in failure["jobs"] for attr in job["attrs"]}
    assert states["broken"] == "failed", states
    assert states["blocked"] == "blocked", states
    assert states["independent"] == "built", states

    preparation = package_outputs("preparation")["dependencyMulti"]
    run(["nix", "build", "--no-link", f"{flake('preparation')}.dependencyMulti^*"])
    assert valid(preparation["out"]) and valid(preparation["dev"])
    # This output belongs exclusively to the unique temporary fixture. The
    # consumer needs only `out`; uploading dependencies must not rebuild `dev`.
    run(["nix-store", "--delete", preparation["dev"]])
    assert not valid(preparation["dev"])
    dependency, _ = build("dependency-cache", "cache", "--copy-to", cache.as_uri())
    assert dependency["status"] == "success", dependency
    assert not valid(preparation["dev"]), "cache upload unexpectedly rebuilt an unused dependency output"
    run(["nix", "path-info", "--store", cache.as_uri(), preparation["out"]])

    opportunistic_reuse()

    invalid_cache = directory / "not-a-directory"
    invalid_cache.write_text("cache uploads must fail here\n")
    uploads, _ = build("upload-failure", "uploadFailure", "--copy-to", (invalid_cache / "cache").as_uri(), "--retries", "0", expected=1)
    assert uploads["status"] == "failed", uploads
    assert uploads["rootFailures"] == [], uploads["rootFailures"]
    assert any(upload["state"] == "failed" for upload in uploads["uploads"])
    assert all(job["state"] in ("cached", "built") for job in uploads["jobs"])

    planned, _ = build("plan", "success", "--dry-run", "--compare", directory / "success" / "results.json")
    assert planned["status"] == "planned", planned
    assert not planned["uploads"] and not planned["derivations"]
    assert planned["planDiff"] is not None
    explained, _ = build("explain", "success", "--explain", "left")
    assert explained["status"] == "planned"
    assert (directory / "explain" / "explanation.json").is_file()

    print(f"Real Nix integration tests passed: {directory}")


if __name__ == "__main__":
    main()
