#!/usr/bin/env python3
"""Exercise the workflow adapter's bounds, artifact, and credential boundaries."""

import base64
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit


MODULE = Path(__file__).resolve().parents[1] / "ci" / "github.py"
SPEC = importlib.util.spec_from_file_location("github_workflow", MODULE)
workflow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workflow)

SECRET = "test-cache:" + base64.b64encode(bytes(range(64))).decode()
PUBLIC = "test-cache:" + base64.b64encode(bytes(range(32, 64))).decode()


def store(name, char="a"):
    return "/nix/store/" + char * 32 + "-" + name


SHARED, FIRST, SECOND = [store(name + ".drv", char)
                         for name, char in [("shared", "a"), ("first", "b"), ("second", "c")]]
OUT, DEV, BOUNDARY = store("shared"), store("shared-dev"), store("dependency", "d")


def configuration(**overrides):
    value = {"sets": [{"id": "first", "flake": ".#first"}, {"id": "second", "flake": ".#second"}],
             "cache": {"read": ["https://cache.example"], "write": "s3://build-cache?region=us-east-1",
                       "publicKeys": [PUBLIC]}}
    value.update(overrides)
    return workflow.normalize_config(value)


def manifest():
    return {"version": 1, "cachedPaths": [], "graph": {
        SHARED: {"outputs": {"out": OUT, "dev": DEV}},
        FIRST: {"outputs": {"out": store("first", "b")}},
        SECOND: {"outputs": {"out": store("second", "c")}}},
        "plan": {"requests": [{"id": "first"}, {"id": "second"}], "groups": [
            {"id": "shared", "kind": "shared", "system": "x86_64-linux", "members": [SHARED],
             "consumers": ["first", "second"], "requiredPaths": []},
            {"id": "first", "kind": "package", "system": "x86_64-linux", "members": [FIRST],
             "consumers": ["first"], "requiredPaths": [OUT]},
            {"id": "second", "kind": "package", "system": "x86_64-linux", "members": [SECOND],
             "consumers": ["second"], "requiredPaths": [DEV]}]}}


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="workflow-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plan = self.root / "plan"
        self.report = self.root / "report"
        self.output = self.root / "output"
        self.output.touch()
        self.env = patch.dict(os.environ, {"RUNNER_TEMP": str(self.root),
            "GITHUB_OUTPUT": str(self.output), "GITHUB_ENV": str(self.root / "env"),
            "GITHUB_PATH": str(self.root / "path"), "NIX_CACHE_SIGNING_KEY": SECRET,
            "NIX_CI_BUILD_RUN_ID": "github:owner/repo:123:build", "NIX_CI_BUILD_ATTEMPT_ID": "2",
            "NIX_CI_BUILD_STAGE_RESULTS": "{}"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def save_plan(self, config=None, selected=None, allowed=None):
        config = config or configuration()
        selected = selected or manifest()
        bounds = workflow.validate_plan(selected, config, allowed)
        bounds.update(status="success", allowedDerivations=allowed)
        workflow.write_json(self.plan / "workflow-config.json", config)
        workflow.write_json(self.plan / "workflow-bounds.json", bounds)
        workflow.write_json(self.plan / "execution-plan.json", selected)
        return config, selected, bounds

    def plan_args(self):
        return SimpleNamespace(plan=str(self.plan), tool="nix-ci-build", system="x86_64-linux")

    def execute_args(self):
        return SimpleNamespace(plan=str(self.plan), report=str(self.report), tool="nix-ci-build", group="first")

    def test_normalized_config_survives_artifact_round_trip(self):
        config = configuration(timeoutMinutes=20, nixConfig="sandbox = false\n",
                               runners={"aarch64-linux": ["self-hosted", "ARM64"]})
        self.assertEqual(workflow.normalize_config(json.loads(json.dumps(config))), config)
        workflow.configure(config)
        self.assertIn("timeout-minutes<<", self.output.read_text())
        self.assertIn("\n20\n", self.output.read_text())
        rendered = (self.root / "env").read_text()
        self.assertIn("sandbox = false", rendered)
        self.assertIn(workflow.BUILDER_CACHE, rendered)
        self.assertIn(workflow.BUILDER_KEY, rendered)
        self.assertIn("require-sigs = true", rendered)
        self.assertNotIn(SECRET, rendered)
        self.assertEqual(configuration()["timeoutMinutes"], 360)

    def test_invalid_config_fails_before_nix(self):
        cases = [
            {"timeoutMinutes": 0}, {"timeoutMinutes": 361}, {"timeoutMinutes": True},
            {"limits": {"maxBuilds": True}}, {"limits": {"maxBoundaryNarBytes": -1}},
            {"limits": {"allowedDerivations": ["/nix/store/invalid.drv"]}},
            {"sets": [{"id": "same", "flake": ".#a"}, {"id": "same", "flake": ".#b"}]},
            {"runners": {"aarch64-linux": []}}, {"runners": {"aarch64-linux": [4]}},
            {"unexpected": True}, {"nixConfig": "require-sigs = false"},
            {"nixConfig": "include /private/file"},
            {"nixConfig": "access-tokens = github.com=private"},
            {"nixConfig": "extra-secret-key-files = /private/file"},
            {"nixConfig": "extra-substituters = https://user:private@cache.example"},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                configuration(**overrides)

    def test_cache_credentials_cannot_enter_saved_config(self):
        for uri in ["https://user:private@cache.example", "s3://cache?secret-key=private",
                    "https://cache.example?token=private", "https://cache.example\nsetting=value"]:
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                configuration(cache={"read": [uri], "write": "s3://cache", "publicKeys": [PUBLIC]})

    def test_exact_bounds_count_owned_derivations_and_all_output_boundaries(self):
        selected = manifest()
        config = configuration(limits={"maxBuilds": 3})
        bounds = workflow.validate_plan(selected, config, [SHARED, FIRST, SECOND])
        self.assertEqual(bounds["ownedDerivations"], sorted([SHARED, FIRST, SECOND]))
        self.assertEqual(bounds["cachedBoundaryPaths"], [])
        selected["plan"]["groups"][1]["requiredPaths"].append(BOUNDARY)
        with self.assertRaisesRegex(ValueError, "boundary"):
            workflow.validate_plan(selected, config, None)
        selected["cachedPaths"].append(BOUNDARY)
        self.assertEqual(workflow.validate_plan(selected, config, None)["cachedBoundaryPaths"], [BOUNDARY])
        with self.assertRaisesRegex(ValueError, "allowedDerivations"):
            workflow.validate_plan(selected, config, [SHARED, FIRST])
        with self.assertRaisesRegex(ValueError, "maxBuilds"):
            workflow.validate_plan(selected, configuration(limits={"maxBuilds": 2}), None)
        selected["plan"]["groups"][1]["members"].append(SHARED)
        with self.assertRaisesRegex(ValueError, "multiple owners"):
            workflow.validate_plan(selected, config, None)

    def test_matrices_bootstrap_only_actual_foreign_systems(self):
        selected = manifest()
        selected["plan"]["groups"][2]["system"] = "aarch64-linux"
        outputs = workflow.matrices(selected, configuration(), "x86_64-linux")
        self.assertEqual(outputs["bootstrap"]["include"],
                         [{"system": "aarch64-linux", "runner": "ubuntu-24.04-arm"}])
        self.assertEqual(len(outputs["shared"]["include"]), 1)
        self.assertEqual(len(outputs["packages"]["include"]), 2)
        selected["plan"]["groups"] = []
        warm = workflow.matrices(selected, configuration(), "x86_64-linux")
        self.assertFalse(any(warm[key] for key in ["has-shared", "has-packages", "has-bootstrap"]))

    def test_unknown_actual_system_requires_runner(self):
        selected = manifest()
        selected["plan"]["groups"][0]["system"] = "x86_64-darwin"
        with self.assertRaisesRegex(ValueError, "configure a runner"):
            workflow.validate_plan(selected, configuration(), None)

    def test_allowlist_resolves_flakes_without_reinterpreting_literal_paths(self):
        config = configuration(limits={"allowedDerivations": [SHARED, ".#first", "github:owner/repo"]})
        with patch.object(workflow, "command", side_effect=[FIRST, SECOND]) as command:
            self.assertEqual(workflow.resolve_allowed(config), sorted([SHARED, FIRST, SECOND]))
        self.assertEqual([call.args[0][-1] for call in command.call_args_list], [".#first", "github:owner/repo"])
        self.assertTrue(all("--apply" in call.args[0] for call in command.call_args_list))

    def test_cached_boundary_counts_shared_closure_once_with_cache_fallback(self):
        second = store("other-dependency", "f")
        common = store("common", "g")
        def info(*args):
            if args[2] == "https://unavailable.example":
                raise subprocess.CalledProcessError(1, ["nix"])
            return {args[-1]: {"narSize": 30}, common: {"narSize": 100}}
        with patch.object(workflow, "nix_json", side_effect=info):
            closure = workflow.boundary_closure([BOUNDARY, second],
                        ["https://unavailable.example", "https://cache.example"])
        self.assertEqual(sum(value["narSize"] for value in closure.values()), 160)
        with patch.object(workflow, "nix_json", return_value={BOUNDARY: None}), self.assertRaisesRegex(ValueError, "complete cached closure"):
            workflow.boundary_closure([BOUNDARY], ["https://cache.example"])

    def planner_command(self, selected):
        def run(argv, **kwargs):
            self.assertNotIn("GITHUB_OUTPUT", kwargs["env"])
            workflow.write_json(self.plan / "execution-plan.json", selected)
        return run

    def test_failed_guard_cannot_publish_job_matrix(self):
        args = self.plan_args()
        with patch.object(workflow, "command", side_effect=self.planner_command(manifest())):
            with self.assertRaisesRegex(ValueError, "maxBuilds"):
                workflow.plan_sets(args, configuration(limits={"maxBuilds": 2}))
        self.assertEqual(self.output.read_text(), "")
        self.assertEqual(workflow.read_json(self.plan / "workflow-bounds.json")["status"], "failed")
        self.assertFalse((self.plan / "workflow-matrices.json").exists())

    def test_plan_preserves_bootstrap_and_emits_only_after_guard(self):
        workflow.write_json(self.plan / "bootstrap.json", {"status": "success", "toolPath": store("builder")})
        with patch.object(workflow, "command", side_effect=self.planner_command(manifest())):
            workflow.plan_sets(self.plan_args(), configuration(limits={"maxBuilds": 3}))
        self.assertEqual(workflow.read_json(self.plan / "bootstrap.json")["status"], "success")
        self.assertIn("has-shared<<", self.output.read_text())
        self.assertNotIn(SECRET, (self.plan / "workflow-config.json").read_text())
        self.assertEqual(workflow.read_json(self.plan / "workflow-bounds.json")["status"], "success")

    def test_boundary_budget_failure_retains_exact_measurement_without_matrix(self):
        selected = manifest()
        selected["plan"]["groups"][0]["requiredPaths"].append(BOUNDARY)
        selected["cachedPaths"].append(BOUNDARY)
        with patch.object(workflow, "command", side_effect=self.planner_command(selected)), \
             patch.object(workflow, "boundary_closure", return_value={BOUNDARY: {"narSize": 101}}), \
             self.assertRaisesRegex(ValueError, "maxBoundaryNarBytes"):
            workflow.plan_sets(self.plan_args(), configuration(limits={"maxBoundaryNarBytes": 100}))
        bounds = workflow.read_json(self.plan / "workflow-bounds.json")
        self.assertEqual((bounds["status"], bounds["boundaryNarBytes"]), ("failed", 101))
        self.assertEqual(self.output.read_text(), "")

    def test_signing_key_is_private_temporary_and_removed_on_failure(self):
        key = None
        with self.assertRaisesRegex(RuntimeError, "copy failed"):
            with workflow.signing_key(configuration(), [self.plan, self.report]) as key:
                self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700)
                self.assertEqual(key.read_text().strip(), SECRET)
                self.assertFalse(key.is_relative_to(self.plan))
                raise RuntimeError("copy failed")
        self.assertFalse(key.exists())
        with patch.dict(os.environ, {"RUNNER_TEMP": str(self.report)}), self.assertRaisesRegex(ValueError, "outside uploaded"):
            with workflow.signing_key(configuration(), [self.report]):
                self.fail("key must not be written into artifacts")

    def test_subprocess_never_inherits_secret(self):
        value = workflow.command([sys.executable, "-c", "import os; print(os.getenv('NIX_CACHE_SIGNING_KEY', 'absent'))"], capture=True)
        self.assertEqual(value.strip(), "absent")

    def test_builder_export_uses_signatures_without_retaining_key(self):
        tool = self.root / "tool"
        args = SimpleNamespace(operation="export", tool=str(tool), report=str(self.plan), group=None, flake="path:/builder#default")
        copied = []
        def run(argv, **kwargs):
            if argv[1] == "eval":
                return "x86_64-linux"
            if argv[1] == "build":
                return store("builder")
            if argv[1] == "path-info":
                return json.dumps({store("builder"): {"narSize": 100}})
            self.assertEqual(argv[1:3], ["copy", "--to"])
            key = Path(parse_qs(urlsplit(argv[3]).query)["secret-key"][0])
            self.assertEqual(key.read_text().strip(), SECRET)
            self.assertNotIn(SECRET, repr(argv))
            copied.append(key)
        with patch.object(workflow, "command", side_effect=run):
            workflow.bootstrap(args, configuration())
        self.assertFalse(copied[0].exists())
        self.assertEqual((tool / "system").read_text().strip(), "x86_64-linux")
        self.assertEqual(workflow.read_json(self.plan / "bootstrap.json")["status"], "success")
        self.assertNotIn(SECRET, (self.plan / "bootstrap.json").read_text())
        self.assertEqual((self.root / "path").read_text().strip(), store("builder") + "/bin")

    def test_missing_or_untrusted_signing_key_prevents_build(self):
        args = SimpleNamespace(operation="export", tool=str(self.root / "tool"), report=str(self.plan), group=None, flake=".#builder")
        with patch.dict(os.environ, {"NIX_CACHE_SIGNING_KEY": ""}), \
             patch.object(workflow, "current_system", return_value="x86_64-linux"), \
             patch.object(workflow, "command") as command, self.assertRaisesRegex(ValueError, "NIX_CACHE_SIGNING_KEY"):
            workflow.bootstrap(args, configuration())
        command.assert_not_called()
        self.assertEqual(workflow.read_json(self.plan / "bootstrap.json")["status"], "failed")
        other_key = "other:" + PUBLIC.split(":")[1]
        with self.assertRaisesRegex(ValueError, "does not match"):
            with workflow.signing_key(configuration(cache={"read": ["https://cache.example"],
                    "write": "s3://cache", "publicKeys": [other_key]})):
                self.fail("untrusted signing key")

    def test_worker_reuses_reviewed_plan_without_flake_evaluation(self):
        config = configuration(limits={"allowedDerivations": [".#first", ".#second", SHARED]})
        self.save_plan(config, allowed=[SHARED, FIRST, SECOND])
        copied = []
        def run(argv, **kwargs):
            self.assertEqual(argv[0], "nix-ci-build")
            self.assertIn("--execute-plan", argv)
            destination = argv[argv.index("--copy-to") + 1]
            key = Path(parse_qs(urlsplit(destination).query)["secret-key"][0])
            self.assertTrue(key.exists())
            self.assertNotIn(SECRET, repr(argv))
            copied.append(key)
        with patch.object(workflow, "resolve_allowed", side_effect=AssertionError("worker evaluated a flake")), \
             patch.object(workflow, "command", side_effect=run):
            workflow.execute(self.execute_args(), config)
        self.assertFalse(copied[0].exists())

    def test_workers_reject_failed_or_changed_plan_bounds(self):
        config, selected, bounds = self.save_plan()
        bounds["status"] = "failed"
        workflow.write_json(self.plan / "workflow-bounds.json", bounds)
        with patch.object(workflow, "command") as command, self.assertRaisesRegex(ValueError, "bounds did not pass"):
            workflow.execute(self.execute_args(), config)
        command.assert_not_called()
        bounds["status"] = "success"
        bounds["ownedDerivations"].remove(SHARED)
        workflow.write_json(self.plan / "workflow-bounds.json", bounds)
        with self.assertRaisesRegex(ValueError, "differs from its planning bounds"):
            workflow.saved_plan(self.plan, config)
        with self.assertRaisesRegex(ValueError, "configuration differs"):
            workflow.saved_plan(self.plan, configuration(timeoutMinutes=20))

    def test_worker_requires_saved_boundary_measurement(self):
        config, _, bounds = self.save_plan(configuration(limits={"maxBoundaryNarBytes": 100}))
        bounds["boundaryNarBytes"] = 101
        workflow.write_json(self.plan / "workflow-bounds.json", bounds)
        workflow.write_json(self.plan / "boundary-closure.json", {BOUNDARY: {"narSize": 101}})
        with self.assertRaisesRegex(ValueError, "boundary exceeds"):
            workflow.saved_plan(self.plan, config)

    def aggregate_args(self):
        return SimpleNamespace(plan=str(self.plan), report=str(self.report), reports=str(self.root / "workers"), tool="nix-ci-build")

    def renderer(self, status):
        def run(argv, **kwargs):
            workflow.write_json(self.report / "aggregate.json", {"status": status, "evidence": "retained"})
            (self.report / "index.html").write_text("observed HTML: " + status)
            (self.report / "summary.md").write_text("Observed build status: " + status)
        return run

    def test_rendering_success_does_not_mask_failed_or_missing_workers(self):
        config, _, _ = self.save_plan()
        for status in ["failed", "incomplete"]:
            with self.subTest(status=status), patch.object(workflow, "command", side_effect=self.renderer(status)), \
                 self.assertRaisesRegex(ValueError, "combined report"):
                workflow.aggregate(self.aggregate_args(), config)
            self.assertEqual(workflow.read_json(self.report / "aggregate.json")["status"], status)
            self.assertEqual(workflow.read_json(self.report / "workflow-status.json")["status"], "failed")

    def test_failed_workflow_stage_cannot_claim_old_report_success(self):
        config, _, _ = self.save_plan()
        with patch.dict(os.environ, {"NIX_CI_BUILD_STAGE_RESULTS": '{"plan":"success","shared":"cancelled","packages":"skipped"}'}), \
             patch.object(workflow, "command", side_effect=self.renderer("success")), \
             self.assertRaisesRegex(ValueError, "stages failed or were cancelled"):
            workflow.aggregate(self.aggregate_args(), config)
        self.assertEqual(workflow.read_json(self.report / "aggregate.json")["status"], "success")
        self.assertEqual((self.report / "index.html").read_text(), "observed HTML: success")
        self.assertIn("Workflow failed", (self.report / "summary.md").read_text())
        self.assertIn("shared (cancelled)", (self.report / "summary.md").read_text())
        self.assertEqual(workflow.read_json(self.report / "workflow-status.json")["status"], "failed")
        self.assertEqual((self.report / "observed-summary.md").read_text(), "Observed build status: success")

    def test_empty_plan_and_skipped_worker_stages_succeed(self):
        selected = manifest()
        selected["plan"]["groups"] = []
        config, _, _ = self.save_plan(selected=selected)
        with patch.dict(os.environ, {"NIX_CI_BUILD_STAGE_RESULTS": '{"plan":"success","shared":"skipped","packages":"skipped"}'}), \
             patch.object(workflow, "command", side_effect=self.renderer("success")):
            workflow.aggregate(self.aggregate_args(), config)
        self.assertEqual(workflow.read_json(self.report / "workflow-status.json")["status"], "success")


if __name__ == "__main__":
    unittest.main()
