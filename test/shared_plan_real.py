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
import shlex
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
                    "narinfo-cache-positive-ttl = 0",
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

    def run(self, label, command, environment, expect_success=True, interrupt_when=None):
        self.counter += 1
        prefix = self.logs / ("%02d-%s" % (self.counter, label))
        started = time.monotonic()
        if interrupt_when is None:
            result = subprocess.run(
                command,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=120,
            )
        else:
            process = subprocess.Popen(
                command, env=environment, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True,
            )
            try:
                deadline = time.monotonic() + 20
                while not interrupt_when.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                check(interrupt_when.exists(), "worker must reach the cancellation checkpoint")
                process.terminate()
                stdout, stderr = process.communicate(timeout=15)
                result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
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

    def execute(self, name, group, plan=None, expect_success=True, cache=None, environment=None, interrupt_when=None, expected_status=None):
        report = self.directory / "reports" / name
        store = (
            self.store(name, worker=True)
            if environment is None else contextlib.nullcontext(environment)
        )
        with store as environment:
            environment = dict(environment)
            environment["NIX_CI_BUILD_RUN_ID"] = "real-integration"
            environment["NIX_CI_BUILD_ATTEMPT_ID"] = name
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
                interrupt_when=interrupt_when,
            )
        check(
            not self.evaluator_invocations.exists(),
            "prepared worker must not invoke the evaluator, including --version",
        )
        execution = read_json(report / "execution.json")
        self.check_execution_events(report, execution, name, expect_success, expected_status)
        if expect_success:
            check(execution["status"] == "success", name + " must publish successfully")
            results = read_json(report / "results.json")
            check(results["status"] == "success", name + " build results must succeed")
            return execution, results
        error_path = report / "execution-error.json"
        error = read_json(error_path) if error_path.exists() else execution
        return error, result

    def check_execution_events(self, report, execution, name, expect_success, expected_status=None):
        events = [json.loads(line) for line in (report / "execution-events.jsonl").read_text().splitlines()]
        check(events and events[0]["type"] == "attempt_start", name + " must start an attempt")
        check(events[-1]["type"] == "attempt_finish", name + " must finish its attempt")
        check(events[-1]["status"] == (expected_status or ("success" if expect_success else "failed")), name + " terminal status must match")
        check([event["sequence"] for event in events] == list(range(1, len(events) + 1)), "attempt event sequence must increase")
        check([event["elapsed"] for event in events] == sorted(event["elapsed"] for event in events), "attempt timing must be monotonic")
        check(execution["runId"] == "real-integration" and execution["attemptId"] == name, "worker must honor explicit execution identity")
        check(execution["finishedAt"] >= execution["startedAt"], "execution must retain complete timing context")
        for event in events:
            check(event["version"] == 1, "execution events need a schema version")
            for key in ["planId", "runId", "groupId", "attemptId"]:
                check(event[key] == execution[key], "event identity must match execution: " + key)
        started = [event["phase"] for event in events if event["type"] == "phase_start"]
        finished = [event["phase"] for event in events if event["type"] == "phase_finish"]
        check(started == finished, name + " must close every started phase")
        if expect_success:
            check(started == ["import_plan", "refresh_cache", "import_prerequisites", "build", "publish"], "worker must trace all orchestration phases")
        for event in events:
            if event["type"] in ["phase_finish", "attempt_finish"]:
                check(event["durationSeconds"] >= 0, "phase durations must be nonnegative")
        engine_events = report / "events.jsonl"
        if engine_events.exists():
            for line in engine_events.read_text().splitlines():
                event = json.loads(line)
                for key in ["planId", "runId", "groupId", "attemptId"]:
                    check(event[key] == execution[key], "engine event identity must match execution: " + key)

    def narinfo(self, path):
        return self.cache / (Path(path).name.split("-", 1)[0] + ".narinfo")

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
            execution, results = self.execute("cached-rerun-%d" % index, group)
            check(self.builds() == expected, "cached reruns in fresh stores must not rebuild any owned output")
            check(not execution["imported"], "cached roots must skip prerequisite and runtime-closure downloads")
            check(
                results["jobs"] and all(job["state"] == "cached" for job in results["jobs"]),
                "cached worker roots must be reported as reused",
            )

        # The immutable plan still lists compiler outputs, but a newly cached
        # root needs neither its compiler nor its build-only dependency chain.
        # Remove those outputs completely from the cache before retrying.
        compiler_paths = list(manifest["graph"][shared["members"][0]]["outputs"].values())
        hidden_compiler = {}
        for path in compiler_paths:
            metadata = self.narinfo(path)
            hidden_compiler[metadata] = metadata.read_bytes()
            metadata.unlink()
        native = next(group for group in packages if group["consumers"] == ["native"])
        execution, results = self.execute("cached-root-obsolete-boundary", native)
        check(self.builds() == expected, "a cached package must not rebuild its vanished prerequisite")
        check(execution["plannedPrerequisites"] and not execution["requiredPrerequisites"], "refresh must prune the original prerequisite list")
        check(not execution["imported"], "obsolete compiler paths must never be imported")
        check(all(job["state"] == "cached" for job in results["jobs"]), "cached root should remain reported as reused")
        for path in compiler_paths:
            check(not (self.directory / "workers" / "cached-root-obsolete-boundary" / "store" / Path(path).name).exists(), "cached-root worker must not materialize its compiler")

        # A cached private intermediate cuts the same build-only dependency
        # chain even when the requested package itself still needs building.
        native_root = manifest["graph"][native["roots"][0]["drvPath"]]
        native_output = native_root["outputs"]["out"]
        self.narinfo(native_output).unlink()
        execution, results = self.execute("cached-intermediate-obsolete-boundary", native)
        expected["native-consumer"] += 1
        check(self.builds() == expected, "only the root above a cached private branch should build")
        check(not execution["requiredPrerequisites"], "a cached private branch must prune external prerequisites")
        check(execution["imported"] and not set(execution["imported"]) & set(compiler_paths), "worker must import the private cache cut without the compiler")
        check(execution["refreshedBuilds"] == [native["roots"][0]["drvPath"]], "refresh must identify only the live owned root")
        for metadata, content in hidden_compiler.items():
            metadata.write_bytes(content)

        # Selected outputs are separate obligations. A cached `out` must not
        # erase the missing `dev` required by the cross consumer.
        compiler = manifest["graph"][shared["members"][0]]
        self.narinfo(compiler["outputs"]["dev"]).unlink()
        execution, _ = self.execute("shared-missing-selected-output", shared)
        expected["opaque-shared-tool"] += 1
        check(self.builds() == expected, "a missing selected boundary output must still build")
        check(set(execution["published"]) == set(compiler_paths), "both selected outputs must remain publication obligations")
        check(execution["refreshedBuilds"] == shared["members"], "cached sibling output must not prune its producer")

        # Lose the remote root after orchestration has refreshed its cache cut,
        # immediately before the engine starts. Dispatch must refuse an unowned
        # fallback build; this is a deliberate race, not an ordinary cache miss.
        race_bin = self.directory / "race-bin"
        race_bin.mkdir()
        wrapper = race_bin / "nix"
        wrapper.write_text(
            "#!/bin/sh\n"
            'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then\n'
            "  /bin/rm -f " + shlex.quote(str(self.narinfo(native_output))) + "\n"
            "fi\n"
            "exec " + shlex.quote(shutil.which("nix")) + ' "$@"\n'
        )
        wrapper.chmod(0o755)
        native_metadata = self.narinfo(native_output).read_bytes()
        with self.store("root-cache-dispatch-race", worker=True) as environment:
            environment["PATH"] = str(race_bin) + os.pathsep + environment["PATH"]
            execution, _ = self.execute(
                "root-cache-dispatch-race", native, environment=environment,
                expect_success=False,
            )
        self.narinfo(native_output).write_bytes(native_metadata)
        check(self.builds() == expected, "cache disappearance must not dispatch an unowned fallback build")
        check(not execution["requiredPrerequisites"], "race must happen after a cached-root refresh pruned prerequisites")
        race_results = read_json(self.directory / "reports" / "root-cache-dispatch-race" / "results.json")
        check("Refusing to build another group's dependencies" in json.dumps(race_results), "dispatch guard must explain the ownership failure")

        cancel_bin = self.directory / "cancel-bin"
        cancel_bin.mkdir()
        checkpoint = self.directory / "cancellation-checkpoint"
        wrapper = cancel_bin / "nix"
        wrapper.write_text(
            "#!/bin/sh\n"
            'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then\n'
            "  : > " + shlex.quote(str(checkpoint)) + "\n"
            "  exec /bin/sleep 30\n"
            "fi\n"
            "exec " + shlex.quote(shutil.which("nix")) + ' "$@"\n'
        )
        wrapper.chmod(0o755)
        with self.store("cancelled-worker", worker=True) as environment:
            environment["PATH"] = str(cancel_bin) + os.pathsep + environment["PATH"]
            execution, result = self.execute(
                "cancelled-worker", native, environment=environment,
                expect_success=False, interrupt_when=checkpoint,
                expected_status="cancelled",
            )
        check(result.returncode == 130 and execution["status"] == "cancelled", "worker cancellation must retain its distinct terminal status")
        check(self.builds() == expected, "cancelled worker must start no fixture builders")

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
                "obsoletePrerequisiteChecks": 2,
                "selectedOutputChecks": 1,
                "dispatchRaceChecks": 1,
                "cancellationChecks": 1,
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
