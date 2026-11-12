#!/usr/bin/env python3
"""Opt-in shared-plan integration against real Nix, with isolated stores.

Run from a nix-ci-build development shell after building the executable:
  python3 test/shared_plan_real.py _build/default/bin/main.exe

Use --directory to retain artifacts at a chosen NEW directory. The test always
retains logs, reports, the cache, and each worker's independent store database.
It never deletes or builds paths in the user's /nix/store.

Nix's chroot stores cannot build on macOS. Instead, workers run sequentially at
one temporary logical store path, with their independent physical directories
renamed into that location while active. This preserves portable derivation
identities while giving every worker an empty store and independent metadata.
Fixture builders explicitly use the host /bin/sh with sandboxing disabled.
"""

import argparse
import collections
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


class RealFixture:
    def __init__(self, executable, directory):
        self.executable = str(executable.resolve())
        self.directory = directory.resolve()
        self.logical_store = self.directory / "store"
        self.cache = self.directory / "cache"
        self.cache.mkdir()
        (self.cache / "nix-cache-info").write_text(
            "StoreDir: %s\nWantMassQuery: 1\nPriority: 40\n" % self.logical_store
        )
        self.cache_url = self.cache.as_uri()
        self.logs = self.directory / "commands"
        self.logs.mkdir()
        self.ledger = self.directory / "builders.log"
        self.evaluator_invocations = self.directory / "unexpected-worker-evaluations.log"
        self.plan = self.directory / "plan"
        self.counter = 0
        self.commands = []
        self.environment = dict(os.environ)
        # Remove caller settings capable of redirecting stores or reports.
        for key in list(self.environment):
            if key.startswith("NIX_") or key.startswith("GITHUB_"):
                self.environment.pop(key)
        self.environment.update(
            NIX_STORE_DIR=str(self.logical_store),
            NIX_CONFIG="\n".join(
                [
                    "experimental-features = nix-command flakes",
                    "sandbox = false",
                    "build-users-group =",
                    "substituters =",
                    "require-sigs = false",
                    "narinfo-cache-negative-ttl = 0",
                    "max-jobs = 1",
                    "cores = 1",
                    "",
                ]
            ),
            NO_COLOR="1",
            NIX_CI_FIXTURE_EVALUATOR_LOG=str(self.evaluator_invocations),
        )
        guard = self.directory / "worker-bin"
        guard.mkdir()
        evaluator = guard / "nix-eval-jobs"
        evaluator.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$NIX_CI_FIXTURE_EVALUATOR_LOG\"\n"
            "printf '%s\\n' 'worker unexpectedly invoked nix-eval-jobs' >&2\n"
            "exit 91\n"
        )
        evaluator.chmod(0o755)
        self.worker_path = str(guard) + os.pathsep + self.environment["PATH"]

    @contextlib.contextmanager
    def store(self, name, worker=False):
        directory = self.directory / "workers" / name
        check(not directory.exists(), "each invocation must receive a new store")
        directory.mkdir(parents=True)
        check(not self.logical_store.exists(), "previous worker store still active")
        environment = dict(self.environment)
        environment["NIX_REMOTE"] = (
            "local?store=" + str(self.logical_store)
            + "&state=" + str(directory / "state")
            + "&log=" + str(directory / "log")
        )
        if worker:
            environment["PATH"] = self.worker_path
        try:
            yield environment
        finally:
            if self.logical_store.exists():
                self.logical_store.rename(directory / "store")

    def run(self, label, command, environment, expect_success=True):
        self.counter += 1
        prefix = self.logs / ("%02d-%s" % (self.counter, label))
        started = time.monotonic()
        result = subprocess.run(
            command,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
        prefix.with_suffix(".stdout").write_text(result.stdout)
        prefix.with_suffix(".stderr").write_text(result.stderr)
        self.commands.append(
            {
                "label": label,
                "command": command,
                "status": result.returncode,
                "seconds": time.monotonic() - started,
                "stdout": prefix.with_suffix(".stdout").name,
                "stderr": prefix.with_suffix(".stderr").name,
            }
        )
        write_json(self.logs / "index.json", self.commands)
        check(
            (result.returncode == 0) == expect_success,
            "%s exited %d; see %s\n%s\n%s"
            % (label, result.returncode, prefix, result.stdout, result.stderr),
        )
        return result

    def builds(self):
        return collections.Counter(
            self.ledger.read_text().splitlines() if self.ledger.exists() else []
        )

    def execute(self, name, group, plan=None, expect_success=True, cache=None, environment=None):
        report = self.directory / "reports" / name
        store = (
            self.store(name, worker=True)
            if environment is None else contextlib.nullcontext(environment)
        )
        with store as environment:
            result = self.run(
                name,
                [
                    self.executable,
                    "--execute-plan", str(plan or self.plan),
                    "--group", group["id"],
                    "--copy-from", cache or self.cache_url,
                    "--copy-to", self.cache_url,
                    "--report-dir", str(report),
                    "--jobs", "1",
                    "--cache-refresh", "0",
                    "--heartbeat", "0.1",
                    "--retries", "0",
                ],
                environment,
                expect_success=expect_success,
            )
        check(
            not self.evaluator_invocations.exists(),
            "prepared worker must not invoke the evaluator, including --version",
        )
        if expect_success:
            execution = read_json(report / "execution.json")
            check(execution["status"] == "success", name + " must publish successfully")
            results = read_json(report / "results.json")
            check(results["status"] == "success", name + " build results must succeed")
            return execution, results
        error = read_json(report / "execution-error.json")
        return error, result

    def no_substitute_scenario(self, fixture, system):
        baseline = self.builds()
        name = "non-substitutable-consumer"
        sets = self.directory / "no-substitute-sets.json"
        write_json(
            sets,
            {
                "sets": [
                    {"id": "no-substitute", "flake": "path:" + str(fixture) + "#noSubstitute"},
                ],
                "runners": {system: "local-real-nix-fixture"},
            },
        )

        def make_plan(label):
            plan = self.directory / label
            with self.store(label) as environment:
                self.run(
                    label,
                    [
                        self.executable,
                        "--plan-sets", str(sets),
                        "--copy-from", self.cache_url,
                        "--report-dir", str(plan),
                        "--jobs", "1",
                    ],
                    environment,
                )
            manifest = read_json(plan / "execution-plan.json")
            groups = manifest["plan"]["groups"]
            check(
                len(groups) == 1 and groups[0]["kind"] == "package",
                "non-substitutable root must retain its owned execution group",
            )
            return plan, groups[0], manifest

        plan, group, _ = make_plan("no-substitute-plan")
        check(self.builds() == baseline, "policy planning must not execute builders")
        execution, results = self.execute("no-substitute-cold", group, plan=plan)
        check(
            self.builds() == baseline + collections.Counter({name: 1}),
            "cold non-substitutable root must build once",
        )
        check(
            len(results["jobs"]) == 1 and results["jobs"][0]["state"] == "built",
            "cold policy root must be reported as built",
        )
        check(len(execution["published"]) == 1, "policy root must be published for the remote-hit test")

        with self.store("no-substitute-remote-hit", worker=True) as environment:
            _, results = self.execute(
                "no-substitute-remote-hit", group, plan=plan, environment=environment,
            )
            expected = baseline + collections.Counter({name: 2})
            check(
                self.builds() == expected,
                "allowSubstitutes=false must rebuild in a fresh worker despite a remote hit",
            )
            check(
                len(results["jobs"]) == 1 and results["jobs"][0]["state"] == "built",
                "remote-cached non-substitutable root must be reported as built",
            )
            _, results = self.execute(
                "no-substitute-local-hit", group, plan=plan, environment=environment,
            )
            check(self.builds() == expected, "an existing local policy output must not rebuild")
            check(
                len(results["jobs"]) == 1 and results["jobs"][0]["state"] == "cached",
                "an existing local policy output must be reported as reused",
            )

        _, cached_group, cached_manifest = make_plan("no-substitute-cached-plan")
        check(
            cached_group == group,
            "remote availability must not remove or change a non-substitutable execution group",
        )
        check(
            execution["published"][0] in cached_manifest["cachedPaths"],
            "policy replan must actually observe the published remote hit",
        )
        check(self.builds() == expected, "policy replan must not execute builders")

    def scenario(self):
        fixture = self.directory / "fixture"
        fixture.mkdir()
        shutil.copyfile(
            Path(__file__).with_name("shared-plan-fixture") / "flake.nix",
            fixture / "flake.nix",
        )
        with self.store("planner") as environment:
            system = self.run(
                "system",
                ["nix", "eval", "--raw", "--impure", "--expr", "builtins.currentSystem"],
                environment,
            ).stdout.strip()
            # JSON strings have the same escaping required for these generated
            # Nix string values; paths are controlled temporary-directory names.
            (fixture / "settings.nix").write_text(
                "{ system = %s; ledger = %s; }\n"
                % (json.dumps(system), json.dumps(str(self.ledger)))
            )
            sets = self.directory / "sets.json"
            write_json(
                sets,
                {
                    "sets": [
                        {"id": "native", "flake": "path:" + str(fixture) + "#native"},
                        {"id": "cross", "flake": "path:" + str(fixture) + "#cross"},
                    ],
                    "runners": {system: "local-real-nix-fixture"},
                },
            )
            github_output = self.directory / "github-output"
            self.run(
                "plan",
                [
                    self.executable,
                    "--plan-sets", str(sets),
                    "--copy-from", self.cache_url,
                    "--report-dir", str(self.plan),
                    "--github-output", str(github_output),
                    "--jobs", "1",
                ],
                environment,
            )
        check(not self.builds(), "planning must not execute any builder")
        manifest = read_json(self.plan / "execution-plan.json")
        groups = manifest["plan"]["groups"]
        shared = [group for group in groups if group["kind"] == "shared"]
        packages = [group for group in groups if group["kind"] == "package"]
        check(len(shared) == 1, "diamond must produce one shared compiler group")
        check(len(packages) == 2, "two requests must retain independent package groups")
        shared = shared[0]
        check(len(shared["members"]) == 1, "shared group must own only the compiler")
        check(
            sorted(shared["roots"][0]["outputs"]) == ["dev", "out"],
            "the shared compiler must retain both consumers' selected outputs",
        )
        check(
            all(group["needs"] == [shared["id"]] for group in packages),
            "each package worker must depend on its shared owner",
        )
        for filename, expected in [
            ("matrix-shared.json", [shared]),
            ("matrix-packages.json", packages),
        ]:
            entries = read_json(self.plan / filename)["include"]
            check(
                sorted(entry["group"] for entry in entries)
                == sorted(group["id"] for group in expected),
                filename + " must identify exactly the saved execution groups",
            )
        check("has-shared=true" in github_output.read_text(), "missing Actions matrix flag")
        check((self.plan / "store" / "nix-cache-info").exists(), "missing derivation bundle")

        error, _ = self.execute("premature-package", packages[0], expect_success=False)
        check("Prerequisites" in error["error"], "early package must explain unpublished prerequisites")
        check(not self.builds(), "early package must not build another job's compiler")

        tampered = self.directory / "tampered-plan"
        shutil.copytree(self.plan, tampered)
        altered = read_json(tampered / "execution-plan.json")
        target = next(group for group in altered["plan"]["groups"] if group["id"] == packages[0]["id"])
        target["requiredPaths"] = []
        write_json(tampered / "execution-plan.json", altered)
        error, _ = self.execute("tampered-boundary", packages[0], plan=tampered, expect_success=False)
        check(
            "ownership" in error["error"] or "required" in error["error"].lower(),
            "tampered boundary must fail plan validation",
        )
        check(not self.builds(), "tampered plan must fail before any builder starts")

        execution, _ = self.execute("shared", shared)
        check(self.builds() == {"opaque-shared-tool": 1}, "shared compiler must build exactly once")
        check(len(execution["published"]) == 2, "both shared compiler outputs must be published")
        for index, package in enumerate(packages):
            execution, _ = self.execute("package-%d" % index, package)
            check(execution["imported"], "package must import its compiler output")
        expected = collections.Counter(
            {
                "opaque-shared-tool": 1,
                "native-private-branch": 1,
                "native-consumer": 1,
                "cross-private-branch": 1,
                "cross-consumer": 1,
            }
        )
        check(self.builds() == expected, "independent workers must build the compiler and each private branch once")

        for index, group in enumerate([shared] + packages):
            _, results = self.execute("cached-rerun-%d" % index, group)
            check(self.builds() == expected, "cached reruns in fresh stores must not rebuild any owned output")
            check(
                results["jobs"] and all(job["state"] == "cached" for job in results["jobs"]),
                "cached worker roots must be reported as reused",
            )

        # A separate empty cache simulates an expired/missing boundary after the
        # shared job has completed. A fresh package worker must still fail closed.
        missing_cache = self.directory / "missing-cache"
        missing_cache.mkdir()
        (missing_cache / "nix-cache-info").write_text(
            "StoreDir: %s\nWantMassQuery: 1\nPriority: 40\n" % self.logical_store
        )
        error, _ = self.execute(
            "missing-boundary", packages[1], expect_success=False,
            cache=missing_cache.as_uri(),
        )
        check("Prerequisites" in error["error"], "missing boundary must remain a prerequisite error")
        check(self.builds() == expected, "missing boundary must never cause a duplicate compiler build")

        cached_plan = self.directory / "cached-plan"
        with self.store("cached-planner") as environment:
            self.run(
                "cached-plan",
                [
                    self.executable,
                    "--plan-sets", str(sets),
                    "--copy-from", self.cache_url,
                    "--report-dir", str(cached_plan),
                    "--jobs", "1",
                ],
                environment,
            )
        check(
            read_json(cached_plan / "execution-plan.json")["plan"]["groups"] == [],
            "replanning published roots must produce no work",
        )
        for filename in ["matrix-shared.json", "matrix-packages.json"]:
            check(
                read_json(cached_plan / filename) == {"include": []},
                "fully cached plan must expose an empty " + filename,
            )
        check(self.builds() == expected, "cached planning must not invoke builders")
        self.no_substitute_scenario(fixture, system)
        write_json(
            self.directory / "verification.json",
            {
                "status": "success",
                "system": system,
                "builders": dict(self.builds()),
                "sharedGroups": 1,
                "packageGroups": 2,
                "nonSubstitutableRootBuilds": 2,
                "isolatedStores": len(list((self.directory / "workers").iterdir())),
            },
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--directory", type=Path)
    arguments = parser.parse_args()
    check(arguments.executable.is_file(), "nix-ci-build executable does not exist")
    for program in ["nix", "nix-store", "nix-eval-jobs"]:
        check(shutil.which(program), program + " is required; run inside nix develop")
    if arguments.directory:
        arguments.directory.mkdir(parents=True, exist_ok=False)
        directory = arguments.directory
    else:
        directory = Path(tempfile.mkdtemp(prefix="nix-ci-shared-plan-real-"))
    print("Real Nix integration artifacts: " + str(directory.resolve()), flush=True)
    fixture = RealFixture(arguments.executable, directory)
    fixture.scenario()
    print("Shared plan real-Nix integration passed", flush=True)


if __name__ == "__main__":
    main()
