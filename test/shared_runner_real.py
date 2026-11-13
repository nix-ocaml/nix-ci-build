#!/usr/bin/env python3
"""Run the provider-independent adapter against real Nix in disposable stores.

This uses the same guarded fixture as shared_plan_real.py; the user's store is
never modified. Pass a NEW --directory to retain reports at a chosen location.
"""

import argparse
import collections
import json
from pathlib import Path
import shutil
import tempfile

from shared_plan_real import RealFixture, check, read_json, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    if args.directory:
        args.directory.mkdir(parents=True, exist_ok=False)
        directory = args.directory
    else:
        directory = Path(tempfile.mkdtemp(prefix="nix-ci-local-runner-"))
    fixture = RealFixture(args.executable, directory)
    source = fixture.directory / "fixture"
    source.mkdir()
    shutil.copyfile(Path(__file__).with_name("shared-plan-fixture") / "flake.nix", source / "flake.nix")
    sets = fixture.directory / "sets.json"
    with fixture.store("planner") as environment:
        system = fixture.run(
            "system", ["nix", "eval", "--raw", "--impure", "--expr", "builtins.currentSystem"], environment,
        ).stdout.strip()
        (source / "settings.nix").write_text(
            "{ system = %s; ledger = %s; }\n" % (json.dumps(system), json.dumps(str(fixture.ledger)))
        )
        # No GitHub runner labels or outputs are needed by this adapter.
        write_json(sets, {"sets": [
            {"id": name, "flake": "path:" + str(source) + "#" + name}
            for name in ["native", "cross"]
        ]})
        environment["GITHUB_OUTPUT"] = str(fixture.directory / "github-output")
        fixture.run("plan", [fixture.executable, "--plan-sets", str(sets),
            "--copy-from", fixture.cache_url, "--report-dir", str(fixture.plan), "--jobs", "1"], environment)
    check(not (fixture.plan / "matrix-shared.json").exists(), "generic plan unexpectedly requires a GitHub matrix")
    check(not (fixture.directory / "github-output").exists(), "generic plan unexpectedly wrote GitHub outputs")
    check(not fixture.builds(), "planning started a builder")

    expected = collections.Counter({
        "opaque-shared-tool": 1, "native-private-branch": 1, "native-consumer": 1,
        "cross-private-branch": 1, "cross-consumer": 1,
    })
    reports = fixture.directory / "local-reports"
    for name in ["cold", "cached"]:
        with fixture.store(name, worker=True) as environment:
            fixture.run(name, [fixture.executable, "--run-plan", str(fixture.plan),
                "--workers", "2", "--jobs", "1", "--copy-from", fixture.cache_url,
                "--copy-to", fixture.cache_url, "--report-dir", str(reports),
                "--cache-refresh", "0", "--heartbeat", "0.1", "--retries", "0"], environment)
        check(fixture.builds() == expected, name + " run built unexpected derivations")
        check(not fixture.evaluator_invocations.exists(), "worker invoked the evaluator")
        check((reports / "aggregate" / "index.html").exists(), "missing aggregate HTML")
        check((reports / "aggregate" / "aggregate.json").exists(), "missing aggregate data")

    events = [json.loads(line) for line in (reports / "scheduler-events.jsonl").read_text().splitlines()]
    starts = [event for event in events if event["type"] == "run_start"]
    check(len(starts) == 2 and starts[0]["runId"] != starts[1]["runId"], "rerun identity was reused")
    groups = read_json(fixture.plan / "execution-plan.json")["plan"]["groups"]
    needs = {group["id"]: group["needs"] for group in groups}
    attempts = set()
    for start in starts:
        completed = set()
        for event in events:
            if event["runId"] != start["runId"]:
                continue
            if event["type"] == "dispatched":
                check(set(needs[event["groupId"]]) <= completed, "group dispatched before prerequisites published")
                check(event["attemptId"] not in attempts, "attempt identity reused")
                attempts.add(event["attemptId"])
            elif event["type"] == "completed":
                check(event["status"] == "success", "worker failed")
                completed.add(event["groupId"])
            elif event["type"] == "run_finish":
                check(event["status"] == "success", "local run failed")
        check(len(completed) == len(groups), "some groups never completed")
    write_json(fixture.directory / "verification.json", {
        "status": "success", "builders": dict(fixture.builds()),
        "runs": len(starts), "attempts": len(attempts), "provider": "local",
    })
    print("Local execution and aggregate report passed: " + str(fixture.directory))


if __name__ == "__main__":
    main()
