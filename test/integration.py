#!/usr/bin/env python3
"""End-to-end tests for nix-ci-build using deterministic, concurrent fake stores.

Usage: python3 test/integration.py PATH_TO_NIX_CI_BUILD [unittest arguments]
No real Nix store, credentials, network or GitHub environment is needed.
"""

import hashlib
import contextlib
import fcntl
import html
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


EXECUTABLE = None
FAKE_TOOLS = Path(__file__).with_name("fake_tools.py").resolve()
REMOTE = "https://cache.fixture.invalid"
DESTINATION = "https://uploads.fixture.invalid"


def store_path(name, kind="out"):
    digest = hashlib.sha256((kind + ":" + name).encode()).hexdigest()[:32]
    return "/nix/store/" + digest + "-" + name + (".drv" if kind == "drv" else "")


class Fixture:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.config = {"jobs": [], "derivations": {}}
        self.local = []
        self.cached = []
        self.report = self.directory / "report"
        self.summary = self.directory / "summary.md"
        self.bin = self.directory / "bin"
        self.invocation = 0
        self.bin.mkdir()
        # An explicit interpreter also works in a Nix sandbox without /usr/bin/env.
        for name in ("nix", "nix-eval-jobs", "nix-store"):
            wrapper = self.bin / name
            wrapper.write_text(
                "#!" + sys.executable + "\n"
                "import runpy, sys\n"
                "sys.argv[0] = " + repr(name) + "\n"
                "runpy.run_path(" + repr(str(FAKE_TOOLS)) + ", run_name='__main__', init_globals={'TOOL_NAME': " + repr(name) + "})\n"
            )
            wrapper.chmod(0o755)

    def node(self, name, dependencies=(), **kwargs):
        drv = store_path(name, "drv")
        outputs = kwargs.pop("outputs", {"out": store_path(name)})
        self.config["derivations"][drv] = {
            "name": name,
            "system": "x86_64-linux",
            "outputs": outputs,
            "inputDrvs": {dependency: ["out"] for dependency in dependencies},
            **kwargs,
        }
        return drv

    def job(self, attr, drv, cache="notBuilt"):
        node = self.config["derivations"][drv]
        self.config["jobs"].append({
            "attr": attr,
            "attrPath": attr.split("."),
            "drvPath": drv,
            "name": node["name"],
            "system": node["system"],
            "inputDrvs": node["inputDrvs"],
            "outputs": node["outputs"],
            "cacheStatus": cache,
        })
        return drv

    def output(self, drv, name="out"):
        return self.config["derivations"][drv]["outputs"][name]

    def prepare(self):
        (self.directory / "fixture.json").write_text(json.dumps(self.config))
        (self.directory / "state.json").write_text(json.dumps({
            "local": self.local,
            "remote": {**{source: [] for source in self.config.get("substituters", [])}, REMOTE: self.cached},
            "attempts": {},
            "activity": 0,
            "built": [],
            "copied": [],
            "imported": [],
            "import_attempts": 0,
        }))

    def change_state(self, update):
        with (self.directory / "state.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            value = self.state()
            update(value)
            path = self.directory / "state-test.tmp"
            path.write_text(json.dumps(value))
            path.replace(self.directory / "state.json")

    def publish(self, paths, store=REMOTE):
        def update(current):
            current["remote"][store] = sorted(set(current["remote"].get(store, []) + list(paths)))
        self.change_state(update)

    def make_local(self, paths):
        self.change_state(lambda current: current.update(local=sorted(set(current["local"] + list(paths)))))

    def release(self, name):
        (self.directory / ("release-" + name)).touch()

    def env(self):
        env = os.environ.copy()
        for key in list(env):
            if key.startswith("GITHUB_") or key in ("NIX_CONFIG", "NIX_REMOTE", "NIX_CI_BUILD_NIX_EVAL_JOBS_VERSION"):
                del env[key]
        env["NIX_CI_FIXTURE"] = str(self.directory)
        env["PATH"] = str(self.bin) + os.pathsep + env.get("PATH", "")
        env["NO_COLOR"] = "1"
        env["TERM"] = "dumb"
        return env

    def command(self, *args):
        defaults = []
        if "--jobs" not in args:
            defaults.extend(["--jobs", "1"])
        if "--heartbeat" not in args:
            defaults.extend(["--heartbeat", "0.05"])
        return [
            EXECUTABLE, "--flake", "fixture", "--report-dir", str(self.report),
            "--output", str(self.summary), *defaults, *args,
        ]

    def run(self, *args, timeout=60, env=None):
        self.prepare()
        self.invocation += 1
        log = self.directory / ("invocation-%d.log" % self.invocation)
        try:
            result = subprocess.run(
                self.command(*args), env=env or self.env(), text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            output = error.output or ""
            log.write_text(output.decode(errors="replace") if isinstance(output, bytes) else output)
            raise
        log.write_text(result.stdout)
        return result

    def snapshot(self):
        return json.loads((self.report / "results.json").read_text())

    def state(self):
        return json.loads((self.directory / "state.json").read_text())

    def trace(self):
        path = self.directory / "trace.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def commands(self, command):
        return [
            event for event in self.trace()
            if event["kind"] == "command" and event["tool"] == "nix"
            and event["args"] and event["args"][0] == command
        ]

    def all_logs(self):
        return "\n".join(
            path.read_text(errors="replace")
            for path in self.report.rglob("*") if path.is_file() and path.suffix == ".log"
        )

    def events(self):
        path = self.report / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class Integration(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="nix-ci-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Fixture(self.temporary.name)
        reports = os.environ.get("NIX_CI_TEST_REPORTS")
        if reports:
            # addCleanup executes in reverse order: retain evidence before deleting
            # temporary paths, including when assertions or subprocesses fail.
            self.addCleanup(
                shutil.copytree, self.temporary.name,
                Path(reports) / self._testMethodName,
                ignore=shutil.ignore_patterns("bin", "*.lock", "*.tmp"),
                dirs_exist_ok=True,
            )

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout)
        return self.fixture.snapshot()

    def failure(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        snapshot = self.fixture.snapshot()
        self.assertNotEqual(snapshot["status"], "success", snapshot)
        return snapshot

    def jobs_by_attr(self, snapshot):
        return {attr: job for job in snapshot["jobs"] for attr in job["attrs"]}

    def assert_built(self, job):
        self.assertIn(job["state"], ("built", "success", "succeeded"), job)

    def assert_cached(self, job):
        self.assertIn(job["state"], ("cached", "local", "substituted"), job)

    def assert_artifact_safe_logs(self, snapshot):
        for path in self.fixture.report.rglob("*"):
            self.assertFalse(set(path.name) & set('\"<>:|*?\\\r\n'), path)
            self.assertLessEqual(len(path.name.encode()), 255, path)
        for section in ("jobs", "derivations", "uploads", "cacheReuse", "rootFailures"):
            for entry in snapshot[section]:
                if entry.get("logPath"):
                    self.assertTrue((self.fixture.report / entry["logPath"]).is_file(), entry)

    def test_report_log_filenames_are_safe_for_artifacts(self):
        f = self.fixture
        names = [
            "cf50e29c358ece3a417cb47bf7d17b06b6219d65.patch?full_index=1",
            "cf50e29c358ece3a417cb47bf7d17b06b6219d65.patch~3Ffull_index=1",
            "source-" + "?" * 100,
            "plain-package",
        ]
        drvs = [f.job("packages.item%d" % i, f.node(name, log=["log-%d" % i]))
                for i, name in enumerate(names)]
        runtime = store_path("runtime?full_index=1")
        f.config["runtime_downloads"] = [{"path": runtime, "seconds": 0}]
        snapshot = self.success(f.run("--copy-to", DESTINATION))
        self.assert_artifact_safe_logs(snapshot)
        self.assertEqual({job["drvPath"] for job in snapshot["jobs"]}, set(drvs))
        self.assertEqual({upload["path"] for upload in snapshot["uploads"]},
                         {f.output(drv) for drv in drvs})
        activities = {entry["drvPath"]: entry for entry in snapshot["derivations"]}
        paths = [activities[drv]["logPath"] for drv in drvs]
        self.assertEqual(len(set(paths)), len(drvs))
        for i, path in enumerate(paths):
            self.assertIn("log-%d" % i, (f.report / path).read_text())
        self.assertTrue(any(entry["path"] == runtime for entry in snapshot["derivations"]))

    def test_failure_summary_references_artifact_safe_log(self):
        f = self.fixture
        drv = f.job("packages.patch", f.node("source.patch?full_index=1", behavior="fail"))
        snapshot = self.failure(f.run("--retries", "0"))
        self.assert_artifact_safe_logs(snapshot)
        failure, = snapshot["rootFailures"]
        self.assertEqual(failure["drvPath"], drv)
        self.assertIn(failure["logPath"], f.summary.read_text())
        self.assertIn("fixture build output", (f.report / failure["logPath"]).read_text())

    def observe_snapshot(self, process, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            path = self.fixture.report / "results.json"
            if path.exists():
                snapshot = json.loads(path.read_text())
                if predicate(snapshot):
                    return snapshot
            if process.poll() is not None:
                self.fail("process exited before the expected live state appeared")
            time.sleep(0.01)
        self.fail("expected live state did not appear before deadline")

    def observe_trace(self, process, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            events = self.fixture.trace()
            if predicate(events):
                return events
            if process.poll() is not None:
                self.fail("process exited before the expected fixture event appeared")
            time.sleep(0.01)
        self.fail("expected fixture event did not appear before deadline")

    def observe_events(self, process, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            events = self.fixture.events()
            if predicate(events):
                return events
            if process.poll() is not None:
                self.fail("process exited before the expected report event appeared")
            time.sleep(0.01)
        self.fail("expected report event did not appear before deadline")

    @contextlib.contextmanager
    def running_fixture(self, *args):
        f = self.fixture
        f.prepare()
        with (f.directory / "process.log").open("w+") as log:
            process = subprocess.Popen(
                f.command(*args), env=f.env(), stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                yield process, log
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()

    def finish_successfully(self, process, log):
        process.wait(timeout=15)
        log.seek(0)
        self.assertEqual(process.returncode, 0, log.read())
        return self.fixture.snapshot()

    def waiting_cache_target(self, outputs=None, name="target"):
        f = self.fixture
        blocker = f.node("blocker", barrier="blocker")
        target = f.node(name, [blocker], **({"outputs": outputs} if outputs else {}))
        app = f.job("packages.app", f.node("app", [target]))
        return blocker, target, app

    def wait_for_build(self, process, drv):
        return self.observe_snapshot(process, lambda snapshot: any(
            node["drvPath"] == drv and node["state"] == "building"
            for node in snapshot["derivations"]
        ))

    def imports(self, snapshot):
        return snapshot.get("cacheReuse", [])

    def test_cache_reuse_imports_dependency_published_during_running_request(self):
        f = self.fixture
        f.config["path_info_missing_output"] = "none"
        blocker, target, app = self.waiting_cache_target(name="source.patch?full_index=1")
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            self.assertTrue(any(event["kind"] == "substitution_miss" and event["drv"] == target for event in f.trace()))
            self.observe_trace(process, lambda events: any(
                event["kind"] == "validity_query" and event["store"] == REMOTE
                and event["fresh"] and f.output(target) in event["paths"] for event in events
            ))
            f.publish([f.output(target)])
            self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == target and entry["state"] == "imported"
                for entry in self.imports(snapshot)
            ))
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {blocker: 1, app: 1})
        self.assertEqual(f.state()["imported"], [f.output(target)])
        entry = next(entry for entry in self.imports(snapshot) if entry["drvPath"] == target)
        self.assertEqual(entry["paths"], [f.output(target)])
        self.assertEqual(entry["neededBy"], ["packages.app"])
        commands = [event for event in f.commands("copy") if "--from" in event["args"]]
        self.assertEqual(len(commands), 1)
        self.assertIn("--stdin", commands[0]["args"])
        self.assertIn("narinfo-cache-negative-ttl", commands[0]["rawArgs"])
        remote_validity = [event for event in f.trace() if event["kind"] == "command"
                           and event["tool"] == "nix-store" and "--store" in event["args"]]
        self.assertTrue(any("narinfo-cache-negative-ttl" in event["rawArgs"] for event in remote_validity))
        self.assertEqual(snapshot["warnings"], [])
        kinds = [event["type"] for event in f.events()]
        self.assertIn("cache-import-start", kinds)
        self.assertIn("cache-import-finished", kinds)
        self.assert_artifact_safe_logs(snapshot)

    def test_cache_reuse_only_imports_cached_roots_needed_by_active_work(self):
        f = self.fixture
        blocker = f.node("blocker", barrier="blocker")
        target = f.job("packages.cached-target", f.node("cached-target", [blocker]), cache="cached")
        unused = f.node("unused-dependency", behavior="fail")
        skipped = f.job("packages.skipped", f.node("skipped", [unused], references=[]), cache="cached")
        # Resolving this output discovers the unused branch, but verifying the
        # cached root must exclude that branch from later follower polls.
        f.config["jobs"][-1]["outputs"] = {"out": None}
        f.cached = [f.output(skipped)]
        witness = f.node("waiting-witness")
        app = f.job("packages.app", f.node("app", [target, witness]))
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            before = len(f.trace())
            # The target's evaluator hit cannot stand in for metadata when
            # another live root needs the target as a dependency.
            f.publish([f.output(target), f.output(unused)])
            imported = self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == target and entry["state"] == "imported"
                for entry in self.imports(snapshot)
            ))
            self.assert_cached(self.jobs_by_attr(imported)["packages.cached-target"])
            self.assert_cached(self.jobs_by_attr(imported)["packages.skipped"])
            entry = next(entry for entry in self.imports(imported) if entry["drvPath"] == target)
            self.assertEqual(entry["neededBy"], ["packages.app"])
            after_import = len(f.trace())
            self.observe_trace(process, lambda events: sum(
                event["kind"] == "path_info" and event["store"] == REMOTE
                and f.output(witness) in event["paths"] for event in events[after_import:]
            ) >= 2)
            queries = [event for event in f.trace()[before:] if event["kind"] == "path_info"]
            self.assertFalse(any(f.output(unused) in event["paths"] for event in queries), queries)
            self.assertEqual(f.state()["import_attempts"], 1)
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {blocker: 1, witness: 1, app: 1})
        self.assertEqual(f.state()["imported"], [f.output(target)])
        self.assertEqual([entry["drvPath"] for entry in self.imports(snapshot)], [target])
        jobs = self.jobs_by_attr(snapshot)
        self.assert_cached(jobs["packages.cached-target"])
        self.assert_cached(jobs["packages.skipped"])
        self.assert_built(jobs["packages.app"])
        graph_queries = [event for event in f.trace() if event["kind"] == "derivation_query"]
        self.assertEqual(len(graph_queries), 1)
        self.assertEqual(set(graph_queries[0]["roots"]), {app, skipped})
        self.assertIn(unused, graph_queries[0]["returned"])

    def test_cache_reuse_waits_for_every_output_before_importing(self):
        f = self.fixture
        outputs = {"out": store_path("target"), "dev": store_path("target-dev")}
        blocker, target, app = self.waiting_cache_target(outputs)
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([outputs["out"]])
            before = len(f.trace())
            self.observe_trace(process, lambda events: any(
                event["kind"] == "path_info" and event["store"] == REMOTE
                and outputs["dev"] in event["paths"] for event in events[before:]
            ))
            self.assertEqual(f.state()["import_attempts"], 0)
            f.publish([outputs["dev"]])
            self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == target and entry["state"] == "imported"
                for entry in self.imports(snapshot)
            ))
            f.release("blocker")
            self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {blocker: 1, app: 1})
        self.assertEqual(set(f.state()["imported"]), set(outputs.values()))
        imports = [event for event in f.trace() if event["kind"] == "import_started"]
        self.assertEqual(len(imports), 1)
        self.assertEqual(set(imports[0]["paths"]), set(outputs.values()))

    def test_cache_reuse_skips_an_active_local_build(self):
        f = self.fixture
        active = f.node("active", barrier="active")
        witness = f.node("waiting-witness")
        f.job("packages.app", f.node("app", [active, witness]))
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, active)
            f.publish([f.output(active)])
            before = len(f.trace())
            self.observe_trace(process, lambda events: sum(
                event["kind"] == "path_info" and event["store"] == REMOTE
                and f.output(witness) in event["paths"] for event in events[before:]
            ) >= 2)
            self.assertEqual(f.state()["import_attempts"], 0)
            f.release("active")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"][active], 1)
        self.assertFalse(any(entry["drvPath"] == active for entry in self.imports(snapshot)))

    def test_cache_reuse_skips_an_active_nix_download(self):
        f = self.fixture
        active = f.node("downloading", download_barrier="download")
        witness = f.node("waiting-witness")
        f.job("packages.app", f.node("app", [active, witness]))
        f.cached = [f.output(active)]
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.observe_snapshot(process, lambda snapshot: any(
                node["drvPath"] == active and node["state"] == "downloading"
                for node in snapshot["derivations"]
            ))
            before = len(f.trace())
            self.observe_trace(process, lambda events: sum(
                event["kind"] == "path_info" and event["store"] == REMOTE
                and f.output(witness) in event["paths"] for event in events[before:]
            ) >= 2)
            self.assertEqual(f.state()["import_attempts"], 0)
            f.release("download")
            snapshot = self.finish_successfully(process, log)
        self.assertNotIn(active, f.state()["attempts"])
        self.assertFalse(any(entry["drvPath"] == active for entry in self.imports(snapshot)))

    def test_cache_reuse_import_failures_back_off_without_failing_build(self):
        f = self.fixture
        blocker, target, app = self.waiting_cache_target()
        witness = f.node("waiting-witness")
        f.config["derivations"][app]["inputDrvs"][witness] = ["out"]
        f.config["import"] = {"behavior": "fail", "error": "error: Connection timed out importing fixture output"}
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([f.output(target)])
            self.observe_trace(process, lambda events: sum(event["kind"] == "import_failed" for event in events) >= 3)
            # A further refresh of another missing output proves that the follower
            # keeps running after exhausting this derivation's retry budget.
            before = len(f.trace())
            self.observe_trace(process, lambda events: any(
                event["kind"] == "path_info" and event["store"] == REMOTE
                and f.output(witness) in event["paths"] for event in events[before:]
            ))
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["import_attempts"], 3)
        self.assertEqual(f.state()["attempts"], {blocker: 1, target: 1, witness: 1, app: 1})
        self.assertEqual(snapshot["rootFailures"], [])
        self.assertIn("timed out", "\n".join(snapshot["warnings"]))
        entry = next(entry for entry in self.imports(snapshot) if entry["drvPath"] == target)
        self.assertEqual(entry["state"], "failed")
        starts = [event["time"] for event in f.events() if event["type"] == "cache-import-start"]
        self.assertGreaterEqual(starts[1] - starts[0], 0.05)
        self.assertGreaterEqual(starts[2] - starts[1], 0.1)

    def test_cache_reuse_respects_disabled_substitution(self):
        f = self.fixture
        blocker, target, app = self.waiting_cache_target()
        f.config["derivations"][target]["env"] = {"allowSubstitutes": ""}
        witness = f.node("waiting-witness")
        f.config["derivations"][app]["inputDrvs"][witness] = ["out"]
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([f.output(target)])
            before = len(f.trace())
            self.observe_trace(process, lambda events: sum(
                event["kind"] == "path_info" and event["store"] == REMOTE
                and f.output(witness) in event["paths"] for event in events[before:]
            ) >= 2)
            self.assertEqual(f.state()["import_attempts"], 0)
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {blocker: 1, target: 1, witness: 1, app: 1})
        self.assertFalse(any(entry["drvPath"] == target for entry in self.imports(snapshot)))

    def test_cache_reuse_multiple_sources_preserve_backoff_and_attempt_logs(self):
        f = self.fixture
        blocker, target, app = self.waiting_cache_target()
        witness = f.node("waiting-witness")
        f.config["derivations"][app]["inputDrvs"][witness] = ["out"]
        middle = "https://middle-cache.fixture.invalid"
        last = "https://last-cache.fixture.invalid"
        f.config["substituters"] = [REMOTE, middle, last]
        f.config["import"] = {"behavior": "fail", "tag_attempts": True}
        f.config["query_barriers"] = {
            middle: {
                "name": "middle-cache",
                # Publication alone can happen after this poll has already
                # missed the first cache. Only block once that cache returned
                # a hit, so the poll has an import to start before it waits.
                "after_cache_hit": {"store": REMOTE, "path": f.output(target)},
            }
        }
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([f.output(target)], REMOTE)
            f.publish([f.output(target)], last)
            self.observe_trace(process, lambda events: any(
                event["kind"] == "barrier_waiting" and event["name"] == "middle-cache"
                for event in events
            ))
            self.observe_events(process, lambda events: any(
                entry["type"] == "cache-import-finished"
                and entry["drvPath"] == target and entry["state"] == "failed"
                for entry in events
            ))
            # The first copy has failed while this same poll is querying its
            # middle source. The last source must not immediately relaunch it.
            f.release("middle-cache")
            self.observe_trace(process, lambda events: sum(event["kind"] == "import_failed" for event in events) >= 3)
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["import_attempts"], 3)
        self.assertEqual(f.state()["attempts"], {blocker: 1, target: 1, witness: 1, app: 1})
        self.assertEqual(snapshot["rootFailures"], [])
        starts = []
        finishes = {}
        starts_this_pass = 0
        for event in f.events():
            if event["type"] == "cache-refresh":
                self.assertLessEqual(starts_this_pass, 1)
                starts_this_pass = 0
            elif event["type"] == "cache-import-start" and event["drvPath"] == target:
                starts_this_pass += 1
                starts.append(event)
            elif event["type"] == "cache-import-finished" and event["drvPath"] == target:
                finishes[event["logPath"]] = event
        self.assertLessEqual(starts_this_pass, 1)
        self.assertEqual(len(starts), 3)
        log_paths = [event["logPath"] for event in starts]
        self.assertEqual(len(set(log_paths)), 3)
        self.assertEqual(set(log_paths), set(finishes))
        for attempt, path in enumerate(log_paths, 1):
            self.assertEqual(finishes[path]["state"], "failed")
            self.assertIn("attempt %d" % attempt, (f.report / path).read_text())

    def test_cache_reuse_rejects_invalid_refresh_intervals(self):
        f = self.fixture
        f.job("packages.app", f.node("app"))
        for value in ("-1", "nan"):
            with self.subTest(value=value):
                result = f.run("--cache-refresh=" + value)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("cache-refresh", result.stdout)
                self.assertEqual(f.commands("build"), [])

    def test_cache_reuse_is_disabled_explicitly_and_for_dry_runs(self):
        f = self.fixture
        blocker, target, app = self.waiting_cache_target()
        with self.running_fixture("--cache-refresh", "0") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([f.output(target)])
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {blocker: 1, target: 1, app: 1})
        self.assertEqual(self.imports(snapshot), [])
        self.assertFalse(any(event["type"].startswith("cache-import") or event["type"] == "cache-refresh" for event in f.events()))
        snapshot = self.success(f.run("--dry-run", "--cache-refresh", "0.05"))
        self.assertEqual(self.imports(snapshot), [])
        self.assertEqual(f.state()["import_attempts"], 0)
        self.assertFalse(any(event["type"].startswith("cache-import") or event["type"] == "cache-refresh" for event in f.events()))

    def test_cache_reuse_cancels_import_when_local_build_starts(self):
        f = self.fixture
        blocker, target, app = self.waiting_cache_target()
        f.config["derivations"][target]["barrier"] = "target"
        f.config["import"] = {"behavior": "hang_before_lock"}
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([f.output(target)])
            self.observe_trace(process, lambda events: any(event["kind"] == "import_started" for event in events))
            f.release("blocker")
            self.wait_for_build(process, target)
            self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == target and entry["state"] == "cancelled"
                for entry in self.imports(snapshot)
            ))
            self.assertNotIn(app, f.state()["attempts"])
            f.release("target")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {blocker: 1, target: 1, app: 1})
        self.assertEqual(f.state()["imported"], [])
        entry = next(entry for entry in self.imports(snapshot) if entry["drvPath"] == target)
        self.assertEqual(entry["state"], "cancelled")

    def test_cache_reuse_cancels_unneeded_import_when_roots_finish(self):
        f = self.fixture
        blocker, target, app = self.waiting_cache_target()
        f.config["import"] = {"behavior": "hang_before_lock"}
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([f.output(target)])
            self.observe_trace(process, lambda events: any(event["kind"] == "import_started" for event in events))
            # A separate local producer wins the race, so no target build starts.
            # The hanging follower must still stop when the root request ends.
            f.make_local([f.output(target)])
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {blocker: 1, app: 1})
        self.assertEqual(f.state()["imported"], [])
        entry = next(entry for entry in self.imports(snapshot) if entry["drvPath"] == target)
        self.assertEqual(entry["state"], "cancelled")

    def test_cache_reuse_cancels_queued_import_pruned_by_an_imported_ancestor(self):
        f = self.fixture
        blocker = f.job("packages.blocker", f.node("blocker", barrier="blocker"))
        # --jobs 1 admits two Nix requests, so occupy both admission slots.
        second_blocker = f.job("packages.second-blocker", f.node("second-blocker", barrier="blocker"))
        dependency = f.node("build-only-dependency", references=[])
        ancestor = f.node("ancestor", [dependency], references=[])
        app = f.job("packages.app", f.node("app", [ancestor]))
        f.config["import_by_path"] = {f.output(dependency): {"behavior": "hang_before_lock"}}
        history = f.directory / "history.json"
        history.write_text(json.dumps({
            "version": 1,
            "derivations": [{"drvPath": drv, "seconds": 10000} for drv in (blocker, second_blocker)],
            "jobs": [],
        }))
        with self.running_fixture("--cache-refresh", "0.05", "--history", str(history)) as (process, log):
            self.wait_for_build(process, blocker)
            held = self.wait_for_build(process, second_blocker)
            self.assertEqual(self.jobs_by_attr(held)["packages.app"]["state"], "queued")
            f.publish([f.output(dependency)])
            self.observe_trace(process, lambda events: any(
                event["kind"] == "import_started" and event["paths"] == [f.output(dependency)]
                for event in events
            ))
            f.publish([f.output(ancestor)])
            self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == ancestor and entry["state"] == "imported"
                for entry in self.imports(snapshot)
            ))
            cancelled = self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == dependency and entry["state"] == "cancelled"
                for entry in self.imports(snapshot)
            ))
            self.assertEqual(self.jobs_by_attr(cancelled)["packages.app"]["state"], "queued")
            self.assertTrue(any(
                node["drvPath"] == blocker and node["state"] == "building"
                for node in cancelled["derivations"]
            ))
            self.assertNotIn(dependency, f.state()["attempts"])
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assert_built(self.jobs_by_attr(snapshot)["packages.app"])
        self.assertEqual(snapshot["rootFailures"], [])
        self.assertEqual(f.state()["attempts"], {blocker: 1, second_blocker: 1, app: 1})
        self.assertEqual(f.state()["imported"], [f.output(ancestor)])
        imports = {entry["drvPath"]: entry for entry in self.imports(snapshot)}
        self.assertEqual(imports[dependency]["state"], "cancelled")
        self.assertEqual(imports[ancestor]["state"], "imported")
        self.assertTrue(any(
            event["type"] == "cache-import-finished" and event["drvPath"] == dependency
            and event["state"] == "cancelled" for event in f.events()
        ))

    def test_cache_reuse_preserves_submitted_dependency_import_after_ancestor_import(self):
        f = self.fixture
        gate = f.node("gate", barrier="gate")
        dependency = f.node("build-only-dependency", [gate], references=[])
        ancestor = f.node("ancestor", [dependency], references=[])
        app = f.job("packages.app", f.node("app", [ancestor]))
        f.config["import_by_path"] = {f.output(dependency): {"barrier": "dependency-import"}}
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, gate)
            f.publish([f.output(dependency)])
            self.observe_trace(process, lambda events: any(
                event["kind"] == "barrier_waiting" and event["name"] == "dependency-import"
                for event in events
            ))
            f.publish([f.output(ancestor)])
            self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == ancestor and entry["state"] == "imported"
                for entry in self.imports(snapshot)
            ))
            # Nix already committed to this dependency walk. Give the import
            # watcher several event-loop turns before releasing the useful copy.
            log.flush()
            log.seek(0)
            heartbeats = log.read().count("STATUS ")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                log.seek(0)
                if log.read().count("STATUS ") >= heartbeats + 3:
                    break
                time.sleep(0.01)
            else:
                self.fail("engine did not progress while the useful import was held")
            held = f.snapshot()
            self.assertEqual(self.jobs_by_attr(held)["packages.app"]["state"], "submitted")
            entry = next(entry for entry in self.imports(held) if entry["drvPath"] == dependency)
            self.assertEqual(entry["state"], "importing")
            f.release("dependency-import")
            imported = self.observe_snapshot(process, lambda snapshot: any(
                entry["drvPath"] == dependency and entry["state"] == "imported"
                for entry in self.imports(snapshot)
            ))
            self.assertEqual(self.jobs_by_attr(imported)["packages.app"]["state"], "submitted")
            self.assertEqual(f.state()["attempts"], {gate: 1})
            f.release("gate")
            snapshot = self.finish_successfully(process, log)
        self.assert_built(self.jobs_by_attr(snapshot)["packages.app"])
        self.assertEqual(snapshot["rootFailures"], [])
        self.assertEqual(f.state()["attempts"], {gate: 1, app: 1})
        self.assertEqual(set(f.state()["imported"]), {f.output(ancestor), f.output(dependency)})
        self.assertTrue(all(entry["state"] == "imported" for entry in self.imports(snapshot)))
        finishes = [event for event in f.events() if event["type"] == "cache-import-finished" and event["drvPath"] == dependency]
        self.assertEqual([event["state"] for event in finishes], ["imported"])

    def test_cache_reuse_bounds_concurrent_imports(self):
        f = self.fixture
        blocker = f.node("blocker", barrier="blocker")
        targets = [f.node("target-%d" % index, [blocker]) for index in range(3)]
        f.job("packages.app", f.node("app", targets))
        f.config["import"] = {"barrier": "imports"}
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            f.publish([f.output(drv) for drv in targets])
            self.observe_trace(process, lambda events: sum(event["kind"] == "import_started" for event in events) >= 2)
            # Keep both import workers blocked while the event loop makes progress.
            log.flush()
            log.seek(0)
            heartbeats = log.read().count("STATUS ")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                log.seek(0)
                if log.read().count("STATUS ") >= heartbeats + 3:
                    break
                time.sleep(0.01)
            else:
                self.fail("engine did not progress while import workers were blocked")
            self.assertEqual(f.state()["import_attempts"], 2)
            f.release("imports")
            self.observe_snapshot(process, lambda snapshot: sum(entry["state"] == "imported" for entry in self.imports(snapshot)) == 3)
            f.release("blocker")
            self.finish_successfully(process, log)
        concurrent = peak = 0
        for event in f.trace():
            if event["kind"] == "import_started":
                concurrent += 1
                peak = max(peak, concurrent)
            elif event["kind"] == "import_finished":
                concurrent -= 1
        self.assertEqual(peak, 2)
        self.assertEqual(concurrent, 0)

    def test_dry_run_drains_more_than_128_evaluated_roots(self):
        f = self.fixture
        for index in range(160):
            name = "package-%03d" % index
            f.job("packages." + name, f.node(name))
        snapshot = self.success(f.run("--dry-run"))
        self.assertEqual(len(snapshot["jobs"]), 160)
        self.assertTrue(snapshot["evaluation"]["complete"])
        self.assertEqual(f.commands("build"), [])
        self.assertEqual(f.commands("copy"), [])
        self.assertIn("160", f.summary.read_text())
        self.assertTrue((f.report / "plan.json").exists())

    def test_aliases_are_preserved_but_derivation_is_built_once(self):
        f = self.fixture
        drv = f.node("aliased")
        f.job("packages.first", drv)
        f.job("legacyPackages.second", drv)
        snapshot = self.success(f.run())
        self.assertEqual(len(snapshot["jobs"]), 1)
        self.assertEqual(set(snapshot["jobs"][0]["attrs"]), {"packages.first", "legacyPackages.second"})
        self.assertEqual(f.state()["attempts"][drv], 1)
        self.assert_built(snapshot["jobs"][0])

    def test_local_and_remote_hits_are_not_rebuilt(self):
        f = self.fixture
        local = f.job("packages.local", f.node("local"), cache="local")
        cached = f.job("packages.cached", f.node("cached"), cache="cached")
        fresh = f.job("packages.fresh", f.node("fresh"))
        f.local = [f.output(local)]
        f.cached = [f.output(cached)]
        snapshot = self.success(f.run())
        jobs = self.jobs_by_attr(snapshot)
        self.assert_cached(jobs["packages.local"])
        self.assert_cached(jobs["packages.cached"])
        self.assert_built(jobs["packages.fresh"])
        self.assertEqual(f.state()["attempts"], {fresh: 1})

    def test_large_cached_set_skips_graph_and_store_queries(self):
        f = self.fixture
        build_branch = f.node("unused-build-leaf", behavior="fail")
        runtime_branch = f.node("unused-runtime-leaf", references=[])
        for index in range(24):
            build_branch = f.node("unused-build-%02d" % index, [build_branch])
            runtime_branch = f.node(
                "unused-runtime-%02d" % index,
                references=[f.output(runtime_branch)],
            )
        for index in range(1000):
            name = "cached-%04d" % index
            outputs = {"out": store_path(name)}
            if index % 3 == 0:
                outputs["dev"] = store_path(name + "-dev")
            f.job(
                "packages." + name,
                f.node(name, [build_branch], outputs=outputs,
                       references=[f.output(runtime_branch)]),
                cache="cached",
            )
            f.cached.extend(outputs.values())
        result = f.run("--copy-to", DESTINATION, "--cache-refresh", "0.05", "--heartbeat", "60")
        snapshot = self.success(result)
        self.assertEqual(len(snapshot["jobs"]), 1000)
        self.assertLess(len(result.stdout.splitlines()), 30, result.stdout)
        self.assertIn("1000", result.stdout)
        self.assertEqual(sum(event["type"] == "job" and event["state"] == "cached" for event in f.events()), 1000)
        self.assertTrue(snapshot["evaluation"]["complete"])
        for job in snapshot["jobs"]:
            self.assert_cached(job)
        self.assertEqual(len(snapshot["plan"]["roots"]), 1000)
        for field in ("builds", "downloads", "unknown"):
            self.assertEqual(snapshot["plan"][field], [], field)
        for command in ("derivation", "path-info", "build", "copy"):
            self.assertEqual(f.commands(command), [], command)
        self.assertFalse(any(event["kind"] == "validity_query" for event in f.trace()))
        self.assertEqual(f.state()["attempts"], {})
        self.assertEqual(snapshot["uploads"], [])
        self.assertEqual(self.imports(snapshot), [])
        self.assertFalse(any(
            event["type"] == "cache-refresh" or event["type"].startswith("cache-import")
            for event in f.events()
        ))

    def test_stale_negative_cache_status_is_rechecked_in_batches_before_graph(self):
        f = self.fixture
        compiler = f.node("unused-compiler", behavior="fail")
        outputs = set()
        for index in range(160):
            name = "now-cached-%03d" % index
            node_outputs = {"out": store_path(name)}
            if index % 7 == 0:
                node_outputs["dev"] = store_path(name + "-dev")
            f.job("packages." + name, f.node(name, [compiler], outputs=node_outputs))
            outputs.update(node_outputs.values())
            (f.local if index % 4 == 0 else f.cached).extend(node_outputs.values())
        snapshot = self.success(f.run("--dry-run"))
        for job in snapshot["jobs"]:
            self.assert_cached(job)
        for field in ("builds", "downloads", "unknown"):
            self.assertEqual(snapshot["plan"][field], [], field)
        local = [event for event in f.trace() if event["kind"] == "validity_query" and event["store"] is None]
        remote = [event for event in f.trace() if event["kind"] == "path_info" and event["store"] == REMOTE]
        self.assertGreater(len(local), 0)
        self.assertGreater(len(remote), 0)
        self.assertLessEqual(len(local), 2, local)
        self.assertLessEqual(len(remote), 2, remote)
        self.assertEqual({path for event in local for path in event["paths"]}, outputs)
        self.assertEqual({path for event in remote for path in event["paths"]}, set(f.cached))
        self.assertEqual(f.commands("derivation"), [])
        self.assertEqual(f.commands("build"), [])
        self.assertEqual(f.commands("copy"), [])

    def test_mixed_cached_roots_only_plan_required_dependencies_and_runtime_closure(self):
        f = self.fixture
        unused = f.node("unused-compiler", behavior="fail")
        unused_runtime = f.node("unused-runtime", references=[])
        skipped = f.job(
            "packages.skipped", f.node("skipped", [unused], references=[f.output(unused_runtime)]),
            cache="cached",
        )
        build_tool = f.node("compiler-build-tool", behavior="fail")
        runtime_leaf = f.node("runtime-leaf", references=[], narSize=400, downloadSize=200)
        runtime = f.node("runtime", references=[f.output(runtime_leaf)], narSize=1000, downloadSize=500)
        dependency = f.job(
            "packages.compiler",
            f.node("compiler", [build_tool], references=[f.output(runtime)],
                   outputs={"out": store_path("compiler"), "dev": store_path("compiler-dev")},
                   narSize=4000, downloadSize=2000),
            cache="cached",
        )
        local = f.node("local-input", references=[])
        app = f.job("packages.app", f.node("app", [dependency, local]))
        f.local = [f.output(local)]
        f.cached = [
            f.output(skipped), f.output(unused_runtime), f.output(dependency),
            f.output(dependency, "dev"), f.output(runtime), f.output(runtime_leaf),
        ]
        snapshot = self.success(f.run("--dry-run"))
        jobs = self.jobs_by_attr(snapshot)
        self.assert_cached(jobs["packages.skipped"])
        self.assert_cached(jobs["packages.compiler"])
        self.assertNotIn(jobs["packages.app"]["state"], ("cached", "local", "substituted"))
        graph_queries = [event for event in f.trace() if event["kind"] == "derivation_query"]
        self.assertEqual(len(graph_queries), 1)
        self.assertEqual(graph_queries[0]["roots"], [app])
        self.assertEqual(set(graph_queries[0]["returned"]), {app, dependency, local, build_tool})
        plan = snapshot["plan"]
        self.assertEqual({node["drvPath"] for node in plan["builds"]}, {app})
        downloads = {item["path"]: item for item in plan["downloads"]}
        self.assertEqual(set(downloads), {f.output(dependency), f.output(runtime), f.output(runtime_leaf)})
        self.assertEqual(downloads[f.output(dependency)]["downloadSize"], 2000)
        self.assertEqual(downloads[f.output(runtime)]["narSize"], 1000)
        self.assertEqual(downloads[f.output(runtime_leaf)]["downloadSize"], 200)
        self.assertIn(f.output(local), plan["localOutputs"])
        self.assertEqual(plan["unknown"], [])
        queried = {path for event in f.trace() if event["kind"] in ("path_info", "validity_query") for path in event["paths"]}
        self.assertNotIn(f.output(skipped), queried)
        self.assertNotIn(f.output(unused_runtime), queried)
        local_queries = [event for event in f.trace() if event["kind"] == "command"
                         and event["tool"] == "nix-store" and "--check-validity" in event["args"]]
        remote_queries = []
        for command in f.commands("path-info"):
            args = command["rawArgs"]
            options = [args[index:index + 3] for index in range(len(args) - 2)]
            remote_queries.append(command)
            self.assertIn("--store", args, "local probes must use direct validity, without installable resolution")
            self.assertEqual(args[args.index("--store") + 1], REMOTE)
            self.assertNotIn(["--option", "substituters", ""], options)
        self.assertTrue(local_queries)
        for command in local_queries:
            self.assertNotIn("--store", command["args"])
            self.assertIn("--print-invalid", command["args"])
            self.assertIn("--stdin", command["args"])
        self.assertTrue(remote_queries)
        self.assertEqual(f.commands("build"), [])
        self.assertEqual(f.commands("copy"), [])

    def test_partial_multioutput_cache_hit_still_requires_build(self):
        f = self.fixture
        compiler = f.node("compiler")
        app = f.job("packages.app", f.node(
            "app", [compiler], outputs={"out": store_path("app"), "dev": store_path("app-dev")},
        ))
        f.cached = [f.output(app)]
        snapshot = self.success(f.run("--dry-run"))
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, {app, compiler})
        self.assertNotIn(self.jobs_by_attr(snapshot)["packages.app"]["state"], ("cached", "local", "substituted"))
        self.assertTrue(f.commands("derivation"))

    def test_cached_hint_with_unknown_output_path_does_not_skip_work(self):
        f = self.fixture
        app = f.job("packages.app", f.node(
            "app", outputs={"out": store_path("app"), "dev": store_path("app-dev")},
        ), cache="cached")
        f.config["jobs"][0]["outputs"] = {"out": f.output(app), "dev": None}
        f.cached = [f.output(app)]
        snapshot = self.success(f.run("--dry-run"))
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, {app})
        self.assertNotIn(self.jobs_by_attr(snapshot)["packages.app"]["state"], ("cached", "local", "substituted"))
        self.assertTrue(f.commands("derivation"))

    def test_local_cached_root_outputs_are_uploaded_without_expanding_graph(self):
        f = self.fixture
        unused = f.node("unused-compiler", behavior="fail")
        outputs = {"out": store_path("local"), "dev": store_path("local-dev")}
        local = f.job("packages.local", f.node("local", [unused], outputs=outputs), cache="local")
        remote = f.job("packages.remote", f.node("remote", [unused]), cache="cached")
        f.local = list(outputs.values())
        f.cached = [f.output(remote)]
        snapshot = self.success(f.run("--copy-to", DESTINATION))
        for job in snapshot["jobs"]:
            self.assert_cached(job)
        self.assertEqual(set(f.state()["copied"]), set(outputs.values()))
        self.assertEqual(len(snapshot["uploads"]), 2)
        self.assertTrue(all(upload["state"] == "uploaded" for upload in snapshot["uploads"]))
        self.assertEqual(f.commands("derivation"), [])
        self.assertEqual(f.commands("build"), [])
        self.assertEqual(f.state()["attempts"], {})
        for field in ("builds", "downloads", "unknown"):
            self.assertEqual(snapshot["plan"][field], [], field)

    def test_plan_separates_downloads_from_builds(self):
        f = self.fixture
        downloaded = f.node("downloaded-compiler", narSize=4096, downloadSize=2048)
        local = f.node("local-dependency")
        root = f.job("packages.app", f.node("app", [downloaded, local]))
        f.cached = [f.output(downloaded)]
        f.local = [f.output(local)]
        snapshot = self.success(f.run("--dry-run"))
        plan = snapshot["plan"]
        self.assertEqual({node["drvPath"] for node in plan["builds"]}, {root})
        self.assertIn(f.output(downloaded), {entry["path"] for entry in plan["downloads"]})
        self.assertIn(f.output(local), plan["localOutputs"])
        self.assertEqual(f.commands("build"), [])

    def test_cache_error_keeps_partial_hits_and_reports_warning(self):
        f = self.fixture
        cached = f.job("packages.cached", f.node("cached"))
        missing = f.job("packages.missing", f.node("missing"))
        f.cached = [f.output(cached)]
        noise = [store_path("unrelated-planner-path-%03d" % index) for index in range(70)]
        cause = "error: HTTP error 503 (Service Unavailable) querying " + REMOTE
        f.config["path_info_error"] = {
            "store": REMOTE,
            "message": cause + "\nthese 70 paths will be fetched (100 MiB download, 200 MiB unpacked):\n"
                       + "\n".join("  " + path for path in noise),
        }
        result = f.run("--dry-run")
        snapshot = self.success(result)
        self.assert_cached(self.jobs_by_attr(snapshot)["packages.cached"])
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, {missing})
        warnings = "\n".join(snapshot["warnings"])
        self.assertIn(cause, warnings)
        self.assertLess(len(warnings), 1024)
        for rendered in (warnings, result.stdout, html.unescape(f.summary.read_text())):
            self.assertIn("HTTP error 503", rendered)
            self.assertIn(REMOTE, rendered)
            self.assertNotIn("unrelated-planner-path", rendered)
        details_files = list((f.report / "logs").glob("cache-query-*.json"))
        self.assertTrue(details_files)
        self.assertTrue(any("logs/" + path.name in warnings for path in details_files))
        details = [json.loads(path.read_text()) for path in details_files]
        relevant = next(item for item in details if cause in item["diagnostics"])
        self.assertIn("path-info", relevant["command"])
        self.assertIn(f.output(cached), relevant["paths"])
        self.assertNotIn(cause, "\n".join(relevant["stderrTail"]), "the fixture must exercise diagnostics lost from the bounded tail")

    def assert_missing_cache_query_preserves_hits(self, missing_output):
        f = self.fixture
        f.config["path_info_missing_output"] = missing_output
        missing = set()
        cached_attrs = []
        for index in range(48):
            attr = "packages.probe-%03d" % index
            drv = f.job(attr, f.node("probe-%03d" % index))
            if index % 3 == 0:
                f.local.append(f.output(drv))
                cached_attrs.append(attr)
            elif index % 3 == 1:
                f.cached.append(f.output(drv))
                cached_attrs.append(attr)
            else:
                missing.add(drv)
        result = f.run("--dry-run", "--heartbeat", "60")
        snapshot = self.success(result)
        jobs = self.jobs_by_attr(snapshot)
        for attr in cached_attrs:
            self.assert_cached(jobs[attr])
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, missing)
        self.assertEqual(snapshot["warnings"], [])
        self.assertNotIn("don't know how to build", result.stdout)
        self.assertNotIn("is not valid", f.summary.read_text())
        trace = f.trace()
        local = [event for event in trace if event["kind"] == "validity_query" and event["store"] is None]
        remote = [event for event in trace if event["kind"] == "path_info"]
        fallback = [event for event in trace if event["kind"] == "validity_query" and event["store"] == REMOTE]
        self.assertTrue(local)
        self.assertLessEqual(len(local), 2)
        self.assertEqual(len(fallback), 1, fallback)
        self.assertLessEqual(len(remote), 2, remote)
        self.assertTrue(all(event["store"] == REMOTE for event in remote))
        graphs = [event for event in trace if event["kind"] == "derivation_query"]
        self.assertEqual(len(graphs), 1)
        self.assertEqual(set(graphs[0]["roots"]), missing)
        self.assertEqual(f.commands("build"), [])
        self.assertEqual(f.commands("copy"), [])

    def test_missing_cache_paths_without_json_preserve_all_available_hits(self):
        self.assert_missing_cache_query_preserves_hits("none")

    def test_partial_cache_json_preserves_initial_and_omitted_hits(self):
        self.assert_missing_cache_query_preserves_hits("partial")

    def test_malformed_cache_json_is_an_actionable_warning(self):
        f = self.fixture
        app = f.job("packages.app", f.node("app"))
        f.config["path_info_malformed_json"] = True
        result = f.run("--dry-run")
        snapshot = self.success(result)
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, {app})
        warnings = "\n".join(snapshot["warnings"])
        self.assertIn("json", warnings.lower())
        self.assertIn(REMOTE, warnings)
        self.assertIn("json", result.stdout.lower())
        self.assertFalse(any(event["kind"] == "validity_query" and event["store"] == REMOTE for event in f.trace()))
        details_files = list((f.report / "logs").glob("cache-query-*.json"))
        self.assertTrue(details_files)
        self.assertTrue(any("logs/" + path.name in warnings for path in details_files))
        details = json.loads(details_files[0].read_text())
        self.assertEqual(details["stdout"].strip(), '{"unfinished":')
        self.assertIn("path-info", details["command"])
        self.assertEqual(details["paths"], [f.output(app)])

    def test_failed_fallback_validity_does_not_invent_cache_hits(self):
        f = self.fixture
        cached = f.job("packages.cached", f.node("cached"))
        missing = f.job("packages.missing", f.node("missing"))
        f.cached = [f.output(cached)]
        f.config["path_info_missing_output"] = "none"
        cause = "error: TLS certificate verification failed for " + REMOTE
        f.config["validity_error"] = {"store": REMOTE, "exit": 7, "message": cause}
        snapshot = self.success(f.run("--dry-run"))
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, {cached, missing})
        for job in snapshot["jobs"]:
            self.assertNotIn(job["state"], ("cached", "local", "substituted"))
        warnings = "\n".join(snapshot["warnings"])
        self.assertIn(cause, warnings)
        self.assertEqual(len([event for event in f.trace() if event["kind"] == "validity_query" and event["store"] == REMOTE]), 1)
        self.assertEqual(len(f.commands("path-info")), 1)
        details = [json.loads(path.read_text()) for path in (f.report / "logs").glob("cache-query-*.json")]
        failed = next(item for item in details if "--check-validity" in item["command"])
        self.assertEqual(failed["status"], "exit 7")
        self.assertEqual(failed["stdout"], "")
        self.assertEqual(set(failed["paths"]), {f.output(cached), f.output(missing)})

    def test_abnormal_metadata_exit_is_not_suppressed_by_normal_misses(self):
        f = self.fixture
        cached = f.job("packages.cached", f.node("cached"))
        missing = f.job("packages.missing", f.node("missing"))
        f.cached = [f.output(cached)]
        # path-info already emits the ordinary missing-path diagnostic. Its
        # unexpected exit status must still surface even without another error.
        f.config["path_info_error"] = {"store": REMOTE, "exit": 7, "message": ""}
        snapshot = self.success(f.run("--dry-run"))
        self.assert_cached(self.jobs_by_attr(snapshot)["packages.cached"])
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, {missing})
        warnings = "\n".join(snapshot["warnings"])
        self.assertIn("exit 7", warnings)
        self.assertIn(REMOTE, warnings)
        self.assertFalse(any(event["kind"] == "validity_query" and event["store"] == REMOTE for event in f.trace()))
        details = [json.loads(path.read_text()) for path in (f.report / "logs").glob("cache-query-*.json")]
        self.assertTrue(any(item["status"] == "exit 7" and "path-info" in item["command"] for item in details))

    def test_repeated_identical_cache_errors_share_one_warning_and_diagnostic(self):
        f = self.fixture
        blocker, target, app = self.waiting_cache_target()
        cause = "error: HTTP error 503 (Service Unavailable) querying " + REMOTE
        poll_paths = [f.output(target), f.output(app)]
        f.config["path_info_error"] = {
            "store": REMOTE,
            "fresh_only": True,
            "paths": poll_paths,
            "message": cause,
        }
        with self.running_fixture("--cache-refresh", "0.05") as (process, log):
            self.wait_for_build(process, blocker)
            self.observe_trace(process, lambda events: sum(
                event["kind"] == "path_info_failed" for event in events
            ) >= 3)
            f.release("blocker")
            snapshot = self.finish_successfully(process, log)
        self.assertEqual(len(snapshot["warnings"]), 1)
        self.assertIn(cause, snapshot["warnings"][0])
        details_files = list((f.report / "logs").glob("cache-query-*.json"))
        self.assertEqual(len(details_files), 1)
        self.assertIn("logs/" + details_files[0].name, snapshot["warnings"][0])
        details = json.loads(details_files[0].read_text())
        self.assertEqual(set(details["paths"]), set(poll_paths))
        self.assertIn(cause, details["diagnostics"])
        self.assertEqual(f.state()["attempts"], {blocker: 1, target: 1, app: 1})

    def test_native_tool_versions_take_precedence_over_package_metadata(self):
        f = self.fixture
        f.job("packages.cached", f.node("cached"), cache="cached")
        env = f.env()
        env["NIX_CI_BUILD_NIX_EVAL_JOBS_VERSION"] = "different-package-version"
        snapshot = self.success(f.run("--dry-run", env=env))
        self.assertEqual(snapshot["context"]["nixVersion"], "nix (Nix) 2.35.3")
        self.assertEqual(snapshot["context"]["nixEvalJobsVersion"], "nix-eval-jobs 2.35.0")

    def test_unsupported_version_flag_uses_explicit_package_metadata(self):
        f = self.fixture
        f.job("packages.cached", f.node("cached"), cache="cached")
        f.config["version_responses"] = {
            "nix-eval-jobs": {"exit": 1, "stderr": "error: unrecognised flag '--version'"},
        }
        env = f.env()
        env["NIX_CI_BUILD_NIX_EVAL_JOBS_VERSION"] = "2.35.0-fixture"
        snapshot = self.success(f.run("--dry-run", env=env))
        expected = "nix-eval-jobs 2.35.0-fixture (Nix package)"
        self.assertEqual(snapshot["context"]["nixEvalJobsVersion"], expected)
        self.assertIn(expected, f.summary.read_text())
        self.assertNotIn("unrecognised flag", f.summary.read_text())
        self.assertEqual(snapshot["warnings"], [])
        self.assertEqual(f.commands("path-info"), [])
        self.assertEqual(f.commands("derivation"), [])

    def test_unsupported_version_flag_without_package_metadata_remains_unknown(self):
        f = self.fixture
        f.job("packages.cached", f.node("cached"), cache="cached")
        f.config["version_responses"] = {
            "nix-eval-jobs": {"exit": 1, "stderr": "error: unrecognised flag '--version'"},
        }
        for metadata in (None, ""):
            with self.subTest(metadata=metadata):
                env = f.env()
                if metadata is not None:
                    env["NIX_CI_BUILD_NIX_EVAL_JOBS_VERSION"] = metadata
                snapshot = self.success(f.run("--dry-run", env=env))
                self.assertEqual(snapshot["context"]["nixEvalJobsVersion"], "unknown")
                self.assertNotIn("unrecognised flag", f.summary.read_text())
                self.assertEqual(snapshot["warnings"], [])

    def test_graph_json_larger_than_16_mib_is_not_truncated(self):
        f = self.fixture
        f.job("packages.large", f.node("large", env={"fixturePadding": "x" * (16 * 1024 * 1024 + 1024)}))
        snapshot = self.success(f.run("--dry-run"))
        self.assertEqual(len(snapshot["plan"]["builds"]), 1)
        self.assertTrue(snapshot["evaluation"]["complete"])

    def test_shared_dependency_is_built_once_and_reported_separately(self):
        f = self.fixture
        dependency = f.node("shared-compiler", delay=0.08)
        a = f.job("packages.a", f.node("a", [dependency]))
        b = f.job("packages.b", f.node("b", [dependency]))
        snapshot = self.success(f.run("--jobs", "2"))
        self.assertEqual(f.state()["attempts"], {dependency: 1, a: 1, b: 1})
        derivations = {node["drvPath"]: node for node in snapshot["derivations"]}
        self.assertIn(dependency, derivations)
        self.assert_built(derivations[dependency])
        text = json.dumps(snapshot) + f.summary.read_text()
        self.assertIn("shared-compiler", text)
        self.assertTrue((f.report / "events.jsonl").read_text().strip())

    def test_live_progress_distinguishes_request_from_actual_build(self):
        f = self.fixture
        compiler = f.node("compiler", delay=0.6)
        app = f.job("packages.app", f.node("app", [compiler], delay=0.02))
        f.prepare()
        with (f.directory / "process.log").open("w+") as log:
            process = subprocess.Popen(f.command(), env=f.env(), stdout=log, stderr=subprocess.STDOUT)
            try:
                snapshot = self.observe_snapshot(
                    process,
                    lambda current: any(
                        node["drvPath"] == compiler and node["state"] == "building"
                        and node["phase"] == "buildPhase"
                        for node in current["derivations"]
                    ),
                )
                job = self.jobs_by_attr(snapshot)["packages.app"]
                self.assertEqual(job["state"], "submitted")
                self.assertEqual(job["buildSeconds"], 0)
                self.assertFalse(any(
                    node["drvPath"] == app and node["state"] == "building"
                    for node in snapshot["derivations"]
                ))
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            log.seek(0)
            output = log.read()
            self.assertEqual(process.returncode, 0, output)
            self.assertTrue(any(line.startswith("BUILD ") and "compiler" in line for line in output.splitlines()), output)
            self.assertIn("requests 1", output)
        job = self.jobs_by_attr(f.snapshot())["packages.app"]
        self.assertGreaterEqual(job["activeSeconds"], 0.6)
        self.assertLess(job["buildSeconds"], job["activeSeconds"] / 2)
        events = [json.loads(line) for line in (f.report / "events.jsonl").read_text().splitlines()]
        dependency_stop = next(index for index, event in enumerate(events) if event["type"] == "activity-stop" and event["drvPath"] == compiler)
        root_start = next(index for index, event in enumerate(events) if event["type"] == "activity-start" and event["drvPath"] == app)
        self.assertLess(dependency_stop, root_start)

    def test_short_build_prints_transitions_without_waiting_for_heartbeat(self):
        f = self.fixture
        drv = f.job("packages.short", f.node("short"))
        result = f.run("--heartbeat", "60", timeout=10)
        self.success(result)
        lines = result.stdout.splitlines()
        submitted = next(index for index, line in enumerate(lines) if line.startswith("REQUEST ") and "short" in line)
        building = next(index for index, line in enumerate(lines) if line.startswith("BUILD ") and "short" in line)
        built = next(index for index, line in enumerate(lines) if line.startswith("DONE ") and "short" in line)
        self.assertLess(submitted, building)
        self.assertLess(building, built)

    def test_verbose_preserves_detailed_lifecycle_events(self):
        f = self.fixture
        cached = f.job("packages.cached", f.node("cached"), cache="cached")
        dependency = f.node("downloaded", references=[])
        app = f.job("packages.app", f.node("app", [dependency]))
        f.cached = [f.output(cached), f.output(dependency)]
        result = f.run("--verbose", "--heartbeat", "60", "--copy-to", DESTINATION)
        snapshot = self.success(result)
        debug = [json.loads(line.split(None, 1)[1]) for line in result.stdout.splitlines() if line.startswith("DEBUG ")]
        self.assertTrue(any(event["type"] == "job" and event.get("state") == "cached" for event in debug))
        self.assertTrue(any(event["type"] == "activity-start" and event.get("state") == "downloading" for event in debug))
        self.assertTrue(any(event["type"] == "activity-stop" for event in debug))
        self.assertTrue(any(event["type"] == "upload" and event.get("state") == "uploaded" for event in debug))
        self.assert_cached(self.jobs_by_attr(snapshot)["packages.cached"])
        self.assert_built(self.jobs_by_attr(snapshot)["packages.app"])
        self.assertEqual(f.state()["attempts"], {app: 1})

    def test_request_level_wait_is_reported_without_marking_package_building(self):
        f = self.fixture
        app = f.job("packages.app", f.node("app"))
        reason = "waiting for a free build slot"
        f.config["request_wait"] = {"reason": reason, "seconds": 0.4}
        f.prepare()
        with (f.directory / "process.log").open("w+") as log:
            process = subprocess.Popen(f.command(), env=f.env(), stdout=log, stderr=subprocess.STDOUT)
            try:
                snapshot = self.observe_snapshot(process, lambda current: bool(current.get("waits")))
                self.assertEqual(len(snapshot["waits"]), 1)
                wait = snapshot["waits"][0]
                self.assertEqual(wait["reason"], reason)
                self.assertEqual(wait["drvs"], [app])
                self.assertGreaterEqual(wait["seconds"], 0)
                self.assertEqual(self.jobs_by_attr(snapshot)["packages.app"]["state"], "submitted")
                self.assertEqual(self.jobs_by_attr(snapshot)["packages.app"]["buildSeconds"], 0)
                self.assertFalse(any(node["state"] == "building" for node in snapshot["derivations"]))
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            log.seek(0)
            output = log.read()
            self.assertEqual(process.returncode, 0, output)
            self.assertIn(reason, output)
        self.assertEqual(f.snapshot()["waits"], [])
        events = [json.loads(line) for line in (f.report / "events.jsonl").read_text().splitlines()]
        starts = [event for event in events if event["type"] == "request-wait"]
        stops = [event for event in events if event["type"] == "request-wait-ended"]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(stops), 1)
        self.assertEqual(starts[0]["requestId"], stops[0]["requestId"])
        self.assertEqual(starts[0]["id"], wait["id"])
        self.assertEqual(stops[0]["id"], wait["id"])
        self.assertTrue(wait["id"])
        self.assertAlmostEqual(starts[0]["time"], wait["startedAt"], delta=0.1)
        self.assertAlmostEqual(stops[0]["seconds"], stops[0]["time"] - starts[0]["time"], delta=0.1)
        self.assertEqual(stops[0]["drvs"], [app])
        self.assertGreaterEqual(stops[0]["seconds"], 0.35)

    def test_unknown_runtime_download_is_observed_validated_and_not_uploaded(self):
        f = self.fixture
        app = f.job("packages.app", f.node("app"))
        runtime = store_path("unknown-runtime")
        f.cached = [runtime]
        f.config["runtime_downloads"] = [{"path": runtime, "seconds": 0.4}]
        f.prepare()
        with (f.directory / "process.log").open("w+") as log:
            process = subprocess.Popen(
                f.command("--copy-to", DESTINATION), env=f.env(),
                stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                snapshot = self.observe_snapshot(
                    process,
                    lambda current: any(
                        node.get("path") == runtime and node["state"] == "downloading"
                        for node in current["derivations"]
                    ),
                )
                download = next(node for node in snapshot["derivations"] if node.get("path") == runtime)
                self.assertIsNone(download["drvPath"])
                self.assertEqual(download["kind"], "download")
                self.assertEqual(download["neededBy"], ["packages.app"])
                self.assertEqual(download["buildSeconds"], 0)
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            log.seek(0)
            output = log.read()
            self.assertEqual(process.returncode, 0, output)
            self.assertTrue(any(line.startswith("FETCH ") and "unknown-runtime" in line for line in output.splitlines()), output)
        snapshot = f.snapshot()
        download = next(node for node in snapshot["derivations"] if node.get("path") == runtime)
        self.assert_cached(download)
        self.assertEqual(download["outputPaths"], [runtime])
        self.assertGreaterEqual(download["downloadSeconds"], 0.35)
        self.assertEqual(f.state()["copied"], [f.output(app)])
        self.assertTrue(any(
            event["kind"] == "validity_query" and event["store"] is None and runtime in event["paths"]
            for event in f.trace()
        ))

    def test_download_activity_is_distinct_from_compilation(self):
        f = self.fixture
        compiler = f.node("cached-compiler", download_delay=0.3)
        app = f.job("packages.app", f.node("app", [compiler]))
        f.cached = [f.output(compiler)]
        result = f.run("--copy-to", DESTINATION)
        snapshot = self.success(result)
        events = [json.loads(line) for line in (f.report / "events.jsonl").read_text().splitlines()]
        starts = [event for event in events if event["type"] == "activity-start" and event["drvPath"] == compiler]
        self.assertEqual([event["state"] for event in starts], ["downloading"])
        self.assertNotIn(compiler, f.state()["attempts"])
        self.assertTrue(any(line.startswith("FETCH ") and "cached-compiler" in line for line in result.stdout.splitlines()), result.stdout)
        node = next(node for node in snapshot["derivations"] if node["drvPath"] == compiler)
        self.assert_cached(node)
        self.assertEqual(f.state()["copied"], [f.output(app)])

    def test_parallel_output_downloads_have_independent_timeline_intervals(self):
        f = self.fixture
        outputs = {"out": store_path("shared-download"), "dev": store_path("shared-download-dev")}
        dependency = f.node("shared-download", outputs=outputs, references=[], download_barrier="downloads")
        first = f.job("packages.first", f.node("first", inputDrvs={dependency: ["out"]}))
        second = f.job("packages.second", f.node("second", inputDrvs={dependency: ["dev"]}))
        f.cached = list(outputs.values())
        with self.running_fixture("--jobs", "2", "--cache-refresh", "0", "--copy-to", DESTINATION) as (process, log):
            events = self.observe_events(process, lambda events: sum(
                event["type"] == "activity-start" and event["drvPath"] == dependency
                for event in events
            ) == 2)
            downloads = [event for event in events if event["type"] == "activity-start" and event["drvPath"] == dependency]
            self.assertEqual({event["path"] for event in downloads}, set(outputs.values()))
            self.assertEqual({event["activityKind"] for event in downloads}, {"download"})
            self.assertEqual(len({event["activityId"] for event in downloads}), 2)
            self.assertEqual(len({event["requestId"] for event in downloads}), 2)
            self.assertFalse(any(event["type"] == "activity-stop" and event["drvPath"] == dependency for event in events))
            f.release("downloads")
            snapshot = self.finish_successfully(process, log)
        events = f.events()
        starts = {event["activityId"]: event for event in events if event["type"] == "activity-start"}
        stops = {event["activityId"]: event for event in events if event["type"] == "activity-stop"}
        self.assertEqual(len(starts), 4)
        self.assertEqual(set(starts), set(stops))
        for identity, start in starts.items():
            self.assertIsInstance(identity, str)
            self.assertIsInstance(start["requestId"], str)
            stop = stops[identity]
            for field in ("drvPath", "path", "requestId", "attempt", "activityKind"):
                self.assertEqual(start[field], stop[field])
            self.assertEqual(start["attempt"], 0)
            self.assertLessEqual(start["time"], stop["time"])
            self.assertAlmostEqual(stop["activitySeconds"], stop["time"] - start["time"], delta=0.1)
        phases = [event for event in events if event["type"] == "phase"]
        self.assertEqual({event["drvPath"] for event in phases}, {first, second})
        for phase in phases:
            start, stop = starts[phase["activityId"]], stops[phase["activityId"]]
            self.assertEqual(phase["activityKind"], "build")
            self.assertEqual(phase["requestId"], start["requestId"])
            self.assertEqual(phase["attempt"], start["attempt"])
            self.assertLessEqual(start["time"], phase["time"])
            self.assertLessEqual(phase["time"], stop["time"])
        for stage in ("evaluation", "planning"):
            stage_events = [event for event in events if event["type"] == "stage" and event["stage"] == stage]
            self.assertEqual([event["state"] for event in stage_events], ["started", "finished"])
            self.assertLessEqual(stage_events[0]["time"], stage_events[1]["time"])
            self.assertLessEqual(stage_events[1]["time"], min(event["time"] for event in starts.values()))
        self.assertEqual(f.state()["attempts"], {first: 1, second: 1})
        self.assertEqual(len(snapshot["uploads"]), 2)
        for upload in snapshot["uploads"]:
            self.assertEqual(upload["state"], "uploaded")
            self.assertLessEqual(upload["queuedAt"], upload["startedAt"])
            self.assertLessEqual(upload["startedAt"], upload["finishedAt"])
            self.assertLessEqual(upload["finishedAt"], snapshot["context"]["finishedAt"])
            self.assertAlmostEqual(upload["seconds"], upload["finishedAt"] - upload["startedAt"], delta=0.1)
            transfer_starts = [event for event in events if event["type"] == "upload-start" and event["path"] == upload["path"]]
            self.assertEqual(len(transfer_starts), 1)
            self.assertAlmostEqual(transfer_starts[0]["time"], upload["startedAt"], delta=0.1)
        self.assertTrue((f.report / "report.html").is_file())
        self.assertGreater((f.report / "report.html").stat().st_size, 0)

    def test_completed_selected_output_download_is_not_reported_active(self):
        f = self.fixture
        outputs = {"out": store_path("split-library"), "dev": store_path("split-library-dev")}
        dependency = f.node("split-library", outputs=outputs, references=[])
        app = f.job("packages.app", f.node("app", [dependency], barrier="app"))
        f.cached = list(outputs.values())
        with self.running_fixture("--cache-refresh", "0") as (process, log):
            snapshot = self.wait_for_build(process, app)
            downloaded = next(node for node in snapshot["derivations"] if node["drvPath"] == dependency)
            self.assertEqual(downloaded["state"], "finished")
            self.assertFalse(downloaded["active"])
            self.assertEqual(downloaded["activeBuilds"], 0)
            self.assertEqual(downloaded["activeDownloads"], 0)
            self.assertIn(outputs["out"], f.state()["local"])
            self.assertNotIn(outputs["dev"], f.state()["local"])
            log_path = f.directory / "process.log"
            before = len(log_path.read_text())
            self.observe_snapshot(process, lambda current: any(
                node["drvPath"] == app and node["active"] and node["seconds"] >= 0.3
                for node in current["derivations"]
            ))
            progress = log_path.read_text()[before:]
            self.assertIn("STATUS ", progress)
            self.assertNotIn("split-library", progress)
            f.release("app")
            self.finish_successfully(process, log)
        self.assertEqual(f.state()["attempts"], {app: 1})
        self.assertNotIn(outputs["dev"], f.state()["local"])
        substitutions = [event for event in f.trace() if event["kind"] == "substituted"]
        self.assertEqual([event["outputs"] for event in substitutions], [[outputs["out"]]])

    def test_queue_rechecks_validity_after_other_work_completes(self):
        f = self.fixture
        triggers = []
        for index in range(5):
            triggers.append(f.job("packages.a%d" % index, f.node("a%d" % index, delay=0.06)))
        queued = f.job("packages.zzz", f.node("zzz"))
        for store in ("local", REMOTE):
            with self.subTest(store=store):
                f.config["cache_after"] = {f.output(queued): {"after_build": triggers[0], "store": store}}
                snapshot = self.success(f.run())
                self.assertNotIn(queued, f.state()["attempts"])
                self.assert_cached(self.jobs_by_attr(snapshot)["packages.zzz"])

    def test_transient_download_is_retried_and_then_succeeds(self):
        f = self.fixture
        source = f.node("source", behavior="transient", fail_attempts=1)
        root = f.job("packages.app", f.node("app", [source]))
        snapshot = self.success(f.run("--retries", "2"))
        self.assertEqual(f.state()["attempts"][source], 2)
        self.assertEqual(f.state()["attempts"][root], 1)
        self.assert_built(self.jobs_by_attr(snapshot)["packages.app"])
        self.assertIn("504", f.all_logs())

    def test_transient_download_retry_limit_is_bounded(self):
        f = self.fixture
        drv = f.job("packages.source", f.node("source", behavior="transient", fail_attempts=99))
        snapshot = self.failure(f.run("--retries", "1"))
        self.assertEqual(f.state()["attempts"][drv], 2)
        self.assertEqual(len(snapshot["rootFailures"]), 1)
        self.assertIn(snapshot["rootFailures"][0]["kind"], ("download", "fetch", "network"))

    def test_failure_is_grouped_once_and_independent_work_continues(self):
        f = self.fixture
        broken = f.node("broken-compiler", behavior="fail", delay=0.2)
        for name in ("a", "b", "c"):
            f.job("packages." + name, f.node(name, [broken]))
        independent = f.job("packages.independent", f.node("independent"))
        snapshot = self.failure(f.run())
        self.assertEqual(f.state()["attempts"][broken], 1)
        jobs = self.jobs_by_attr(snapshot)
        self.assert_built(jobs["packages.independent"])
        self.assertEqual(f.state()["attempts"][independent], 1)
        self.assertTrue(all(jobs["packages." + name]["state"] == "blocked" for name in ("a", "b", "c")))
        failures = snapshot["rootFailures"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["drvPath"], broken)
        self.assertEqual(set(failures[0]["affected"]), {"packages.a", "packages.b", "packages.c"})
        self.assertNotIn("retry", " ".join(event["kind"] for event in f.trace()))

    def test_cached_root_bypasses_failed_input_and_is_not_reported_affected(self):
        f = self.fixture
        compiler = f.node("broken-compiler", behavior="fail")
        f.job("packages.broken", f.node("broken", [compiler]))
        cached = f.job("packages.cached", f.node("cached", [compiler]), cache="cached")
        f.cached = [f.output(cached)]
        snapshot = self.failure(f.run())
        self.assert_cached(self.jobs_by_attr(snapshot)["packages.cached"])
        self.assertEqual(len(snapshot["rootFailures"]), 1)
        self.assertEqual(snapshot["rootFailures"][0]["affected"], ["packages.broken"])
        self.assertEqual(f.state()["attempts"], {compiler: 1})

    def test_eval_cached_aliases_are_not_affected_without_store_metadata(self):
        f = self.fixture
        compiler = f.node("broken-compiler", behavior="fail")
        f.job("packages.broken", f.node("broken", [compiler]))
        cached = f.job("packages.cached", f.node("cached", [compiler]), cache="cached")
        f.job("legacyPackages.cachedAlias", cached, cache="cached")
        # The evaluator hit is trusted without querying its output. Failure
        # attribution must therefore consult job state, not cache metadata.
        snapshot = self.failure(f.run("--retries", "0"))
        jobs = self.jobs_by_attr(snapshot)
        self.assert_cached(jobs["packages.cached"])
        self.assert_cached(jobs["legacyPackages.cachedAlias"])
        self.assertEqual(
            {attr for attr, job in jobs.items() if job["state"] == "blocked"},
            {"packages.broken"},
        )
        self.assertEqual(len(snapshot["rootFailures"]), 1)
        self.assertEqual(snapshot["rootFailures"][0]["drvPath"], compiler)
        self.assertEqual(snapshot["rootFailures"][0]["affected"], ["packages.broken"])
        queried = {path for event in f.trace() if event["kind"] == "path_info" for path in event["paths"]}
        self.assertNotIn(f.output(cached), queried)
        self.assertEqual(f.state()["attempts"], {compiler: 1})
        events = [json.loads(line) for line in (f.report / "events.jsonl").read_text().splitlines()]
        cached_states = [event["state"] for event in events if event["type"] == "job" and event["drvPath"] == cached]
        self.assertTrue(cached_states)
        self.assertEqual(set(cached_states), {"cached"})
        self.assertEqual(
            [event["failure"]["affected"] for event in events if event["type"] == "root-failure"],
            [["packages.broken"]],
        )

    def test_graph_resolved_cached_root_is_excluded_from_dependency_needed_by(self):
        f = self.fixture
        compiler = f.node("broken-compiler", behavior="fail")
        f.job("packages.broken", f.node("broken", [compiler]))
        cached = f.job("packages.cached", f.node("cached", [compiler]), cache="cached")
        # Evaluation cannot establish a complete cache hit until the graph
        # supplies this output path and the store probe verifies it.
        f.config["jobs"][-1]["outputs"] = {"out": None}
        f.cached = [f.output(cached)]
        snapshot = self.failure(f.run("--retries", "0"))
        jobs = self.jobs_by_attr(snapshot)
        self.assert_cached(jobs["packages.cached"])
        self.assertEqual(jobs["packages.broken"]["state"], "blocked")
        self.assertEqual(len(snapshot["rootFailures"]), 1)
        self.assertEqual(snapshot["rootFailures"][0]["drvPath"], compiler)
        self.assertEqual(snapshot["rootFailures"][0]["affected"], ["packages.broken"])
        dependency = next(node for node in snapshot["derivations"] if node["drvPath"] == compiler)
        self.assertEqual(dependency["neededBy"], ["packages.broken"])
        self.assertEqual(f.state()["attempts"], {compiler: 1})

    def test_successful_build_only_outputs_are_uploaded_when_parent_fails(self):
        f = self.fixture
        outputs = {"out": store_path("compiler"), "dev": store_path("compiler-dev")}
        compiler = f.node("compiler", outputs=outputs)
        source = f.node("source", [compiler])
        root = f.job("packages.app", f.node("app", [source], behavior="fail"))
        self.failure(f.run("--copy-to", DESTINATION))
        copied = set(f.state()["copied"])
        self.assertTrue(set(outputs.values()).issubset(copied), copied)
        self.assertIn(f.output(source), copied)
        self.assertNotIn(f.output(root), copied)
        self.assertTrue(f.commands("copy"))
        for command in f.commands("copy"):
            self.assertFalse(any("^" in arg or arg.endswith(".drv") for arg in command["args"]))

    def test_upload_failure_is_separate_from_successful_compilation(self):
        f = self.fixture
        f.job("packages.app", f.node("app"))
        f.config["copy_failure"] = True
        snapshot = self.failure(f.run("--copy-to", DESTINATION, "--retries", "0"))
        self.assert_built(self.jobs_by_attr(snapshot)["packages.app"])
        self.assertEqual(snapshot["rootFailures"], [])
        self.assertTrue(any(upload["state"] == "failed" for upload in snapshot["uploads"]))
        self.assertIn("upload", f.summary.read_text().lower())

    def test_full_logs_survive_and_summary_stays_bounded(self):
        f = self.fixture
        lines = ["build-line-%04d %s" % (i, "x" * 150) for i in range(800)]
        f.job("packages.noisy", f.node("noisy", log=lines, behavior="fail"))
        self.failure(f.run("--retries", "0"))
        log = f.all_logs()
        self.assertIn(lines[0], log)
        self.assertIn(lines[-1], log)
        self.assertLess(len(f.summary.read_bytes()), 1_000_000)
        self.assertNotIn(lines[0], f.summary.read_text())
        self.assertIn("nix build", f.summary.read_text())

    def test_evaluation_process_error_preserves_partial_results(self):
        f = self.fixture
        f.job("packages.first", f.node("first"))
        f.config.update(evaluation_exit=1, evaluation_stderr="fixture evaluation exception")
        snapshot = self.failure(f.run())
        self.assertEqual(len(snapshot["jobs"]), 1)
        self.assertTrue(snapshot["evaluation"]["errors"])
        self.assertIn("fixture evaluation exception", f.all_logs())
        self.assertTrue(f.summary.exists())
        self.assertTrue((f.report / "events.jsonl").read_text().strip())

    def test_decoded_evaluation_errors_are_visible_with_no_successful_jobs(self):
        f = self.fixture
        trace = "error:\n" + (
            "       ... while evaluating a package definition\n"
            "         at /nix/store/fixture-source/lib/attrsets.nix:1571:10:\n"
        ) * 35
        cause = "error: attribute 'ocaml_pcre' missing"
        diagnostic = trace + cause + "\n       at /nix/store/fixture-source/ocaml/default.nix:2585:16:\n"
        for index in range(11):
            attr = "packages.failure-%02d" % index
            f.config["jobs"].append({"attr": attr, "attrPath": attr.split("."), "error": diagnostic, "fatal": False})
        env = f.env()
        env["GITHUB_ACTIONS"] = "true"
        result = f.run("--heartbeat", "60", env=env)
        snapshot = self.failure(result)
        self.assertEqual(snapshot["jobs"], [])
        self.assertEqual(snapshot["evaluation"]["attrs"], 11)
        self.assertEqual(len(snapshot["evaluation"]["errors"]), 11)
        self.assertTrue(snapshot["evaluation"]["complete"])
        self.assertIn(cause, result.stdout)
        self.assertIn(cause, html.unescape(f.summary.read_text()))
        self.assertIn("11 evaluation errors", result.stdout)
        lines = result.stdout.splitlines()
        self.assertTrue(any(line.startswith("FAIL ") for line in lines), result.stdout)
        self.assertTrue(any(line.startswith("::error ") and "ocaml_pcre" in line for line in lines), result.stdout)
        self.assertTrue(any(line.startswith("::group::") and "evaluation" in line.lower() for line in lines), result.stdout)
        self.assertEqual(sum(line.startswith("::group::") for line in lines), lines.count("::endgroup::"))
        self.assertEqual(f.commands("build"), [])
        self.assertEqual(f.commands("copy"), [])

    def test_malformed_evaluation_line_preserves_previous_jobs(self):
        f = self.fixture
        f.job("packages.first", f.node("first"))
        f.job("packages.second", f.node("second"))
        f.config["eval_invalid_after"] = 1
        snapshot = self.failure(f.run())
        self.assertEqual(len(snapshot["jobs"]), 1)
        self.assertTrue(snapshot["evaluation"]["errors"])
        self.assertTrue(f.summary.exists())

    def test_sigint_keeps_cancelled_results_and_existing_logs(self):
        f = self.fixture
        root = f.job("packages.slow", f.node("slow", delay=20, log=["started slow fixture"]))
        f.prepare()
        with (f.directory / "process.log").open("w+") as log:
            process = subprocess.Popen(f.command(), env=f.env(), stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    started = any(
                        event["kind"] == "build_started" and event["drv"] == root
                        for event in f.trace()
                    )
                    if started and "started slow fixture" in f.all_logs():
                        break
                    if process.poll() is not None:
                        break
                    time.sleep(0.02)
                else:
                    self.fail("fixture build did not start before cancellation deadline")
                process.send_signal(signal.SIGINT)
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            log.seek(0)
            self.assertNotEqual(process.returncode, 0, log.read())
        snapshot = f.snapshot()
        self.assertEqual(snapshot["status"], "cancelled")
        self.assertTrue(all(job["state"] == "cancelled" for job in snapshot["jobs"]))
        self.assertTrue(all(job["finishedAt"] is not None for job in snapshot["jobs"]))
        self.assertTrue(snapshot["derivations"])
        self.assertTrue(all(node["state"] == "cancelled" for node in snapshot["derivations"]))
        self.assertTrue(all(node["finishedAt"] is not None for node in snapshot["derivations"]))
        for node in snapshot["derivations"]:
            self.assertAlmostEqual(node["seconds"], node["finishedAt"] - node["startedAt"], delta=0.1)
        self.assertIn("started slow fixture", f.all_logs())
        self.assertTrue(f.summary.exists())
        self.assertTrue((f.report / "report.html").is_file())

    def test_sigterm_preserves_built_packages_and_cancels_upload_queue(self):
        f = self.fixture
        outputs = {name: store_path("app-" + name) for name in ("out", "dev", "doc", "static")}
        f.job("packages.app", f.node("app", outputs=outputs))
        f.config["copy_delay"] = 20
        f.prepare()
        with (f.directory / "process.log").open("w+") as log:
            process = subprocess.Popen(
                f.command("--copy-to", DESTINATION), env=f.env(),
                stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                self.observe_snapshot(
                    process,
                    lambda current: any(upload["state"] == "uploading" for upload in current["uploads"])
                    and any(upload["state"] == "queued" for upload in current["uploads"]),
                )
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            log.seek(0)
            self.assertNotEqual(process.returncode, 0, log.read())
        snapshot = f.snapshot()
        self.assertEqual(snapshot["status"], "cancelled")
        self.assert_built(self.jobs_by_attr(snapshot)["packages.app"])
        self.assertEqual(len(snapshot["uploads"]), 4)
        self.assertTrue(all(upload["state"] == "cancelled" for upload in snapshot["uploads"]))
        started = []
        for upload in snapshot["uploads"]:
            self.assertIsNotNone(upload["finishedAt"])
            self.assertLessEqual(upload["queuedAt"], upload["finishedAt"])
            self.assertLessEqual(upload["finishedAt"], snapshot["context"]["finishedAt"])
            if upload["startedAt"] is None:
                self.assertEqual(upload["seconds"], 0)
            else:
                started.append(upload["path"])
                self.assertLessEqual(upload["queuedAt"], upload["startedAt"])
                self.assertLessEqual(upload["startedAt"], upload["finishedAt"])
                self.assertAlmostEqual(upload["seconds"], upload["finishedAt"] - upload["startedAt"], delta=0.1)
        self.assertGreater(len(started), 0)
        self.assertLess(len(started), 4)
        self.assertEqual({event["path"] for event in f.events() if event["type"] == "upload-start"}, set(started))
        self.assertTrue(f.summary.exists())
        self.assertTrue((f.report / "report.html").is_file())

    def test_shared_dependency_priority_unlocks_more_roots_first(self):
        f = self.fixture
        f.job("packages.a-lone", f.node("a-lone"))
        shared = f.node("shared")
        for name in ("b", "c", "d"):
            f.job("packages." + name, f.node(name, [shared]))
        self.success(f.run())
        starts = [event["drv"] for event in f.trace() if event["kind"] == "build_started"]
        self.assertEqual(starts[0], shared)

    def test_history_prioritizes_the_longer_remaining_chain(self):
        f = self.fixture
        short = f.job("packages.a-short", f.node("a-short"))
        long = f.job("packages.z-long", f.node("z-long"))
        history = f.directory / "history.json"
        history.write_text(json.dumps({
            "version": 1,
            "derivations": [
                {"drvPath": short, "name": "a-short", "system": "x86_64-linux", "buildSeconds": 1},
                {"drvPath": long, "name": "z-long", "system": "x86_64-linux", "buildSeconds": 600},
            ],
            "jobs": [],
        }))
        self.success(f.run("--history", str(history)))
        starts = [event["drv"] for event in f.trace() if event["kind"] == "build_started"]
        self.assertEqual(starts[0], long)

    def test_batch_reports_each_roots_actual_outcome(self):
        f = self.fixture
        common = f.node("common")
        failed = f.job("packages.a-failed", f.node("a-failed", [common], behavior="fail"))
        good = f.job("packages.b-good", f.node("b-good", [common]))
        snapshot = self.failure(f.run("--batch-size", "2", "--retries", "0"))
        jobs = self.jobs_by_attr(snapshot)
        self.assertEqual(jobs["packages.a-failed"]["state"], "failed")
        self.assert_built(jobs["packages.b-good"])
        builds = f.commands("build")
        self.assertTrue(any(failed + "^*" in event["args"] and good + "^*" in event["args"] for event in builds), builds)
        self.assertEqual(f.state()["attempts"], {common: 1, failed: 1, good: 1})

    def test_mixed_batch_retries_only_transient_failure(self):
        f = self.fixture
        common = f.node("common")
        compiler = f.job("packages.compiler", f.node("compiler", [common], behavior="fail"))
        source = f.job("packages.source", f.node("source", [common], behavior="transient", fail_attempts=1))
        snapshot = self.failure(f.run("--batch-size", "2", "--retries", "2"))
        self.assertEqual(f.state()["attempts"], {common: 1, compiler: 1, source: 2})
        self.assert_built(self.jobs_by_attr(snapshot)["packages.source"])
        self.assertEqual(self.jobs_by_attr(snapshot)["packages.compiler"]["state"], "failed")
        self.assertEqual(len(snapshot["rootFailures"]), 1)
        self.assertEqual(snapshot["rootFailures"][0]["drvPath"], compiler)
        self.assertEqual(snapshot["rootFailures"][0]["kind"], "build")
        events = [json.loads(line) for line in (f.report / "events.jsonl").read_text().splitlines()]
        retries = [event for event in events if event["type"] == "retry"]
        self.assertEqual(len(retries), 1)
        self.assertEqual(retries[0]["drvs"], [source])

    def test_abandoned_transient_input_does_not_block_independent_root(self):
        f = self.fixture
        compiler = f.node("compiler", behavior="fail")
        source = f.node("source", behavior="transient", fail_attempts=1)
        f.job("packages.a-broken", f.node("a-broken", [compiler, source]))
        independent = f.job("packages.b-independent", f.node("b-independent", [source]))
        snapshot = self.failure(f.run("--batch-size", "1", "--retries", "2"))
        self.assertEqual(f.state()["attempts"], {compiler: 1, source: 2, independent: 1})
        jobs = self.jobs_by_attr(snapshot)
        self.assertEqual(jobs["packages.a-broken"]["state"], "blocked")
        self.assert_built(jobs["packages.b-independent"])
        self.assertEqual(len(snapshot["rootFailures"]), 1)
        self.assertEqual(snapshot["rootFailures"][0]["drvPath"], compiler)
        events = [json.loads(line) for line in (f.report / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event for event in events if event["type"] == "retry"], [])

    def test_explain_shows_transitive_path_without_building(self):
        f = self.fixture
        llvm = f.node("llvm")
        rust = f.node("rust", [llvm])
        git = f.node("git", [rust])
        f.job("packages.piaf", f.node("piaf", [git]))
        result = f.run("--explain", "packages.piaf")
        self.success(result)
        self.assertEqual(f.commands("build"), [])
        self.assertEqual(f.commands("copy"), [])
        for name in ("packages.piaf", "git", "rust", "llvm"):
            self.assertIn(name, result.stdout)

    def test_compare_reports_new_dependency_work(self):
        f = self.fixture
        f.job("packages.app", f.node("app"))
        self.success(f.run("--dry-run"))
        previous = f.directory / "previous-plan.json"
        previous.write_bytes((f.report / "plan.json").read_bytes())
        compiler = f.node("new-compiler")
        f.config["jobs"].clear()
        f.job("packages.app", f.node("app-v2", [compiler]))
        snapshot = self.success(f.run("--dry-run", "--compare", str(previous)))
        self.assertTrue(snapshot["planDiff"])
        self.assertIn("new-compiler", json.dumps(snapshot["planDiff"]))
        self.assertIn("new-compiler", f.summary.read_text())

    def test_saved_report_renders_without_a_flake_or_nix_commands(self):
        f = self.fixture
        f.job("packages.cached", f.node("cached"), cache="cached")
        self.success(f.run("--dry-run"))
        report = f.report / "report.html"
        self.assertTrue(report.is_file())
        report.unlink()
        snapshot = (f.report / "results.json").read_bytes()
        events = (f.report / "events.jsonl").read_bytes()
        commands = f.trace()
        rendered = subprocess.run(
            [EXECUTABLE, "--render-report", str(f.report)], env=f.env(),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10,
        )
        (f.directory / "render-report.log").write_text(rendered.stdout)
        self.assertEqual(rendered.returncode, 0, rendered.stdout)
        self.assertTrue(report.is_file())
        self.assertGreater(report.stat().st_size, 0)
        self.assertEqual((f.report / "results.json").read_bytes(), snapshot)
        self.assertEqual((f.report / "events.jsonl").read_bytes(), events)
        self.assertEqual(f.trace(), commands)

    def test_output_option_takes_precedence_over_github_summary(self):
        f = self.fixture
        f.job("packages.app", f.node("app"))
        inherited = f.directory / "github-step-summary.md"
        inherited.write_text("previous step\n")
        env = f.env()
        env["GITHUB_STEP_SUMMARY"] = str(inherited)
        self.success(f.run(env=env))
        self.assertTrue(f.summary.exists())
        self.assertEqual(inherited.read_text(), "previous step\n")
        self.assertIn("app", f.summary.read_text())


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: integration.py PATH_TO_NIX_CI_BUILD [unittest arguments]")
    EXECUTABLE = str(Path(sys.argv.pop(1)).resolve())
    unittest.main()
