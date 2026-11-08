#!/usr/bin/env python3
"""Opt-in tests against real Nix and nix-eval-jobs, outside the default test suite.

Usage: python3 test/real_test.py _build/default/bin/main.exe [OUTPUT_DIRECTORY]

The fixture intentionally uses /bin/sh and only shell builtins. Its subprocesses
request sandbox=false, with no persistent Nix configuration changes. The runner
must be permitted to disable sandboxing; no external flake inputs are used.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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

    def run(arguments, *, expected=0):
        nonlocal command_number
        command_number += 1
        result = subprocess.run([str(arg) for arg in arguments], env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=300)
        (directory / f"command-{command_number:02d}.log").write_text(result.stdout)
        if expected is not None and result.returncode != expected:
            raise AssertionError(f"Command failed ({result.returncode}, expected {expected}): {arguments}\n{result.stdout[-12000:]}")
        return result

    system = run(["nix", "eval", "--impure", "--raw", "--expr", "builtins.currentSystem"]).stdout.strip()
    source = Path(__file__).parent / "real" / "flake.nix"
    fixture = directory / "fixture"
    fixture.mkdir(exist_ok=True)
    (fixture / "flake.nix").write_text(source.read_text().replace("FIXTURE_RUN_ID", uuid.uuid4().hex))

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
