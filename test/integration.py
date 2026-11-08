#!/usr/bin/env python3
"""End-to-end tests for nix-ci-build using deterministic, concurrent fake stores.

Usage: python3 test/integration.py PATH_TO_NIX_CI_BUILD [unittest arguments]
No real Nix store, credentials, network or GitHub environment is needed.
"""

import hashlib
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
            "remote": {REMOTE: self.cached},
            "attempts": {},
            "activity": 0,
            "built": [],
            "copied": [],
        }))

    def env(self):
        env = os.environ.copy()
        for key in list(env):
            if key.startswith("GITHUB_") or key in ("NIX_CONFIG", "NIX_REMOTE"):
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
        cached = f.job("packages.cached", f.node("cached"), cache="cached")
        missing = f.job("packages.missing", f.node("missing"))
        f.cached = [f.output(cached)]
        f.config["path_info_error"] = {
            "store": REMOTE,
            "message": "error: HTTP error 503 (Service Unavailable) querying fixture cache",
        }
        snapshot = self.success(f.run("--dry-run"))
        self.assertEqual({node["drvPath"] for node in snapshot["plan"]["builds"]}, {missing})
        self.assertIn("503", "\n".join(snapshot["warnings"]))

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
            self.assertIn("building compiler", output)
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
        submitted = next(index for index, line in enumerate(lines) if "submitted" in line and "packages.short" in line)
        building = next(index for index, line in enumerate(lines) if "building" in line and Path(drv).name in line)
        built = next(index for index, line in enumerate(lines) if "built" in line and "packages.short" in line)
        self.assertLess(submitted, building)
        self.assertLess(building, built)

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
            self.assertTrue(any("downloading" in line and "unknown-runtime" in line for line in output.splitlines()), output)
        snapshot = f.snapshot()
        download = next(node for node in snapshot["derivations"] if node.get("path") == runtime)
        self.assert_cached(download)
        self.assertEqual(download["outputPaths"], [runtime])
        self.assertGreaterEqual(download["downloadSeconds"], 0.35)
        self.assertEqual(f.state()["copied"], [f.output(app)])
        self.assertTrue(any(
            event["kind"] == "path_info" and event["store"] is None and runtime in event["paths"]
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
        self.assertIn("downloading cached-compiler", result.stdout)
        node = next(node for node in snapshot["derivations"] if node["drvPath"] == compiler)
        self.assert_cached(node)
        self.assertEqual(f.state()["copied"], [f.output(app)])

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
        self.assertTrue(f.summary.exists())

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
