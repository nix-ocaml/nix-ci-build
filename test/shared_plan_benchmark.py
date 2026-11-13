#!/usr/bin/env python3
"""Bounded comparison with real, unmodified packages from this repository's lock.

Only fmt, astring, and their common topkg dependency may build. Everything else
must already exist in the read caches. Each worker uses a fresh Linux chroot
store; no paths are removed from the machine's ordinary store.

Run with a packaged nix-ci-build binary (so nix-eval-jobs is on its PATH):
  python3 test/shared_plan_benchmark.py result/bin/nix-ci-build --directory DIR
The directory must not exist. Reports and stores are retained on failure.
"""

import argparse
import collections
import concurrent.futures
import json
import os
from pathlib import Path
import platform
import subprocess
import threading
import time


DEFAULT_CACHES = [
    "https://anmonteiro.nix-cache.workers.dev",
    "https://cache.nixos.org",
]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def store_path(path):
    return path if path.startswith("/") else "/nix/store/" + path


def normalize_graph(value):
    """Accept Nix derivation JSON before and after the versioned schema."""
    result = {}
    for drv, node in value.get("derivations", value).items():
        inputs = node.get("inputDrvs", node.get("inputs", {}).get("drvs", {}))
        result[store_path(drv)] = {
            "name": node["name"],
            "system": node["system"],
            "inputs": {
                store_path(dep): outputs.get("outputs", [])
                if isinstance(outputs, dict) else outputs
                for dep, outputs in inputs.items()
            },
            "outputs": {
                name: store_path(output.get("path") or node.get("env", {}).get(name))
                if output.get("path") or node.get("env", {}).get(name) else None
                for name, output in node["outputs"].items()
            },
        }
    return result


def missing_derivations(graph, roots, available):
    """Mirror Nix's output cache cuts, failing closed on incomplete recipes."""
    missing = set()
    visited = set()

    def visit(drv, outputs):
        node = graph[drv]
        outputs = sorted(node["outputs"]) if "*" in outputs else outputs
        require(bool(outputs), "Empty output selection for " + drv)
        paths = [node["outputs"][name] for name in outputs]
        require(all(paths), "Missing work has an unresolved output: " + drv)
        key = (drv, tuple(sorted(outputs)))
        if key in visited or all(path in available for path in paths):
            return
        visited.add(key)
        missing.add(drv)
        for dependency, selected in node["inputs"].items():
            visit(dependency, selected)

    for root in roots:
        visit(root["drvPath"], root["outputs"])
    return missing


def cache_paths(directory):
    result = set()
    for info in directory.glob("*.narinfo"):
        fields = dict(line.split(": ", 1) for line in info.read_text().splitlines() if ": " in line)
        if fields.get("URL") and (directory / fields["URL"]).is_file():
            result.add(fields["StorePath"])
    return result


def directory_bytes(directory):
    return sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())


def new_cache(directory):
    directory.mkdir(parents=True)
    (directory / "nix-cache-info").write_text("StoreDir: /nix/store\nWantMassQuery: 1\n")
    return directory


class Benchmark:
    def __init__(self, executable, directory, caches, max_seed_bytes):
        self.executable = str(executable.resolve())
        self.directory = directory.resolve()
        self.repo = Path(__file__).resolve().parents[1]
        self.caches = caches
        self.max_seed_bytes = max_seed_bytes
        self.logs = self.directory / "commands"
        self.logs.mkdir()
        self.command_lock = threading.Lock()
        self.commands = []
        self.counter = 0
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("NIX_", "GITHUB_"))}
        self.env["NO_COLOR"] = "1"
        self.env["NIX_CONFIG"] = "\n".join([
            "experimental-features = nix-command flakes",
            "substituters =", "extra-substituters =", "builders =",
            "require-sigs = false", "build-users-group =", "sandbox = true",
            "narinfo-cache-negative-ttl = 0", "narinfo-cache-positive-ttl = 0",
            "max-jobs = 1", "cores = 1", "connect-timeout = 15", "download-attempts = 2",
        ]) + "\n"
        self.summary = {"version": 1, "startedAt": time.time(), "status": "running"}
        self.seed = new_cache(self.directory / "seed-cache")

    def run(self, label, command, env=None, allow_failure=False, timeout=900):
        with self.command_lock:
            self.counter += 1
            prefix = self.logs / ("%03d-%s" % (self.counter, label))
        started = time.time()
        print("[%s] %s" % (label, " ".join(command[:5])), flush=True)
        with prefix.with_suffix(".stdout").open("w+") as stdout, \
                prefix.with_suffix(".stderr").open("w+") as stderr:
            result = subprocess.run(command, env=env or self.env, stdout=stdout,
                                    stderr=stderr, text=True, timeout=timeout)
            stdout.seek(0)
            output = stdout.read()
            stderr.seek(0)
            error = stderr.read()
        record = {"label": label, "command": command, "exitCode": result.returncode,
                  "startedAt": started, "finishedAt": time.time(),
                  "durationSeconds": time.time() - started,
                  "stdout": prefix.with_suffix(".stdout").name,
                  "stderr": prefix.with_suffix(".stderr").name}
        with self.command_lock:
            self.commands.append(record)
            write_json(self.logs / "index.json", self.commands)
        require(allow_failure or result.returncode == 0,
                "%s exited %d; see %s\n%s" % (label, result.returncode, prefix, error[-8000:]))
        return output, record

    def resolve(self):
        started = time.time()
        lock = read_json(self.repo / "flake.lock")
        input_node = lock["nodes"][lock["root"]]["inputs"]["nixpkgs"]
        source = lock["nodes"][input_node]["locked"]
        require(source["type"] == "github" and source["owner"] == "nix-ocaml"
                and source["repo"] == "nix-overlays", "Expected the existing locked nix-overlays input")
        reference = "github:%s/%s/%s" % (source["owner"], source["repo"], source["rev"])
        expression = """let
          f = builtins.getFlake %s;
          p = f.legacyPackages.x86_64-linux.ocaml-ng.ocamlPackages_5_5;
        in builtins.mapAttrs (_: d: {
          inherit (d) name system drvPath outputs;
          outputPaths = builtins.listToAttrs (map
            (output: { name = output; value = d.${output}.outPath; }) d.outputs);
        }) { inherit (p) fmt astring topkg; }""" % json.dumps(reference)
        output, _ = self.run("resolve-packages", ["nix", "eval", "--json", "--expr", expression])
        self.packages = json.loads(output)
        self.withheld = {package["drvPath"] for package in self.packages.values()}
        self.withheld_paths = {path for package in self.packages.values()
                               for path in package["outputPaths"].values()}
        output, _ = self.run("read-recipes", ["nix", "derivation", "show", "--recursive",
                            self.packages["fmt"]["drvPath"], self.packages["astring"]["drvPath"]])
        self.graph = normalize_graph(json.loads(output))
        topkg = self.packages["topkg"]["drvPath"]
        for name in ["fmt", "astring"]:
            require(topkg in self.graph[self.packages[name]["drvPath"]]["inputs"],
                    name + " no longer directly consumes the exact topkg derivation")
        boundary = {self.graph[dependency]["outputs"][output]
                                for drv in self.withheld
                                for dependency, outputs in self.graph[drv]["inputs"].items()
                                if dependency not in self.withheld for output in outputs}
        require(None not in boundary, "Benchmark boundary contains an unresolved output")
        self.boundary = sorted(boundary)
        require(len(self.withheld) == 3 and len(self.boundary) <= 32,
                "Fixture changed beyond the three-derivation budget")
        self.fixture = self.directory / "packages"
        self.fixture.mkdir()
        (self.fixture / "flake.nix").write_text("""{
          outputs = _: let
            p = (builtins.getFlake %s).legacyPackages.x86_64-linux.ocaml-ng.ocamlPackages_5_5;
          in { fmt.package = p.fmt; astring.package = p.astring; };
        }
        """ % json.dumps(reference))
        self.summary.update(nixOverlays=source, packages=self.packages, boundaryPaths=self.boundary,
                            resolutionSeconds=time.time() - started)
        write_json(self.directory / "packages.json", self.packages)

    def seed_cache(self):
        started = time.time()
        providers = {}
        closure = {}
        # Query closure metadata before downloading any NAR, so a changed input
        # cannot silently turn the experiment into a multi-gigabyte rebuild.
        for path in self.boundary:
            for index, cache in enumerate(self.caches):
                output, record = self.run("probe-seed-%d" % index,
                    ["nix", "path-info", "--store", cache, "--recursive", "--json", path],
                    allow_failure=True)
                if record["exitCode"]:
                    continue
                infos = json.loads(output)
                if isinstance(infos, list):
                    infos = {info["path"]: info for info in infos if info}
                if path not in infos or any(info is None for info in infos.values()):
                    continue
                providers[path] = cache
                closure.update(infos)
                break
            require(path in providers, "No complete cached closure for boundary " + path)
        require(not self.withheld_paths.intersection(closure),
                "An upstream runtime closure contains one of the withheld outputs")
        nar_bytes = sum(info["narSize"] for info in closure.values())
        require(nar_bytes <= self.max_seed_bytes,
                "Seed closure exceeds byte budget: %d > %d" % (nar_bytes, self.max_seed_bytes))
        write_json(self.directory / "seed-closure.json", closure)
        transfer_errors = []
        # Base closures often live in both caches. Seed those from the fallback
        # first, then copy overlay-only roots. A stale narinfo in either cache
        # may be recoverable from the other; no transfer invokes a builder.
        for attempt in range(2):
            for index, cache in reversed(list(enumerate(self.caches))):
                missing = sorted(set(closure) - cache_paths(self.seed))
                if not missing:
                    break
                output, record = self.run("probe-transfer-%d-%d" % (attempt, index),
                    ["nix-store", "--check-validity", "--print-invalid", "--store", cache, *missing],
                    allow_failure=True)
                if record["exitCode"]:
                    continue
                invalid = set(output.splitlines())
                require(invalid <= set(missing), "Unexpected cache validity output")
                paths = [path for path in missing if path not in invalid]
                if not paths:
                    continue
                _, record = self.run("copy-seed-%d-%d" % (attempt, index),
                    ["nix", "copy", "--from", cache, "--to", self.seed.as_uri() + "?compression=zstd", *paths],
                    allow_failure=True)
                if record["exitCode"]:
                    transfer_errors.append(record["stderr"])
        self.seed_paths = cache_paths(self.seed)
        require(set(closure) <= self.seed_paths,
                "Seed cache is incomplete; missing cached NARs: " + repr(sorted(set(closure) - self.seed_paths)))
        require(not self.withheld_paths.intersection(self.seed_paths), "Withheld output entered seed cache")
        self.summary["seed"] = {"durationSeconds": time.time() - started,
                                "paths": len(self.seed_paths), "narBytes": nar_bytes,
                                "fileBytes": directory_bytes(self.seed),
                                "maxNarBytes": self.max_seed_bytes,
                                "transferErrorLogs": transfer_errors}

    def plan(self, name, packages):
        directory = self.directory / "plans" / name
        sets = self.directory / (name + "-sets.json")
        write_json(sets, {"sets": [{"id": package, "flake": "path:%s#%s" % (self.fixture, package)}
                                   for package in packages]})
        _, timing = self.run("plan-" + name, [self.executable, "--plan-sets", str(sets),
                             "--copy-from", self.seed.as_uri(), "--report-dir", str(directory)])
        manifest = read_json(directory / "execution-plan.json")
        expected = {self.packages[package]["drvPath"] for package in packages} | {self.packages["topkg"]["drvPath"]}
        groups = manifest["plan"]["groups"]
        members = [drv for group in groups for drv in group["members"]]
        require(set(members) == expected and len(members) == len(expected),
                "Plan exceeded its exact build allowlist: " + repr(members))
        roots = {root["drvPath"] for request in manifest["plan"]["requests"] for root in request["roots"]}
        require(roots == {self.packages[package]["drvPath"] for package in packages},
                "The planned roots differ from the locked derivations")
        shared = [group for group in groups if group["kind"] == "shared"]
        require((len(packages) == 1 and not shared and len(groups) == 1)
                or (len(packages) == 2 and len(shared) == 1 and len(groups) == 3
                    and shared[0]["members"] == [self.packages["topkg"]["drvPath"]]),
                "Unexpected ownership shape; refusing an unbounded comparison")
        return {"name": name, "directory": directory, "groups": groups,
                "planningSeconds": timing["durationSeconds"]}

    def execute(self, plan, group, cache):
        name = plan["name"] + "-" + group["id"]
        store = self.directory / "workers" / name
        require(not store.exists(), "Worker store must start empty: " + str(store))
        environment = dict(self.env)
        environment["NIX_REMOTE"] = str(store)
        environment["NIX_CI_BUILD_RUN_ID"] = plan["name"]
        environment["NIX_CI_BUILD_ATTEMPT_ID"] = "1"
        report = self.directory / "reports" / plan["name"] / group["id"]
        started = time.time()
        report.mkdir(parents=True)
        bootstrap = {"groupId": group["id"], "runId": plan["name"], "attemptId": "1",
                     "startedAt": started, "operation": "verify-bounded-work", "status": "failed"}
        try:
            # Only raw recipes/source paths are imported in preflight; dependency
            # outputs are fetched by the real worker and timed in its own trace.
            roots = [root["drvPath"] for root in group["roots"]]
            self.run("recipes-" + name, ["nix", "copy", "--derivation", "--from",
                     (plan["directory"] / "store").as_uri(), *roots], env=environment)
            output, _ = self.run("local-paths-" + name, ["nix", "path-info", "--all", "--json"],
                                 env=environment)
            infos = json.loads(output)
            local = set(infos) if isinstance(infos, dict) else {info["path"] for info in infos}
            require(not self.withheld_paths.intersection(local), "Fresh worker already contains benchmark output")
            available = self.seed_paths | cache_paths(cache) | local
            missing = missing_derivations(self.graph, group["roots"], available)
            require(missing == set(group["members"]) and missing <= self.withheld,
                    "Worker preflight rejects unexpected builds: " + repr(sorted(missing)))
            require(set(group["requiredPaths"]) <= available, "Worker prerequisite is unpublished")
            bootstrap.update(status="success", missingDerivations=sorted(missing))
        except Exception as error:
            bootstrap["error"] = str(error)
            raise
        finally:
            bootstrap.update(finishedAt=time.time(), durationSeconds=time.time() - started)
            write_json(report / "bootstrap.json", bootstrap)
        _, timing = self.run("execute-" + name, [self.executable,
            "--execute-plan", str(plan["directory"]), "--group", group["id"],
            "--copy-from", self.seed.as_uri(), "--copy-from", cache.as_uri(),
            "--copy-to", cache.as_uri() + "?compression=zstd", "--report-dir", str(report),
            "--jobs", "1", "--cache-refresh", "0", "--retries", "0"], env=environment)
        execution = read_json(report / "execution.json")
        results = read_json(report / "results.json")
        require(execution["status"] == "success" and results["status"] == "success",
                "Worker did not finish successfully")
        built = [item for item in results["derivations"]
                 if item["state"] == "built" and item.get("buildSeconds", 0) > 0]
        require({item["drvPath"] for item in built} == set(group["members"]),
                "Observed build activity did not match bounded ownership")
        trace = [json.loads(line) for line in (report / "execution-events.jsonl").read_text().splitlines()]
        phases = {event["phase"]: event["durationSeconds"] for event in trace
                  if event["type"] == "phase_finish"}
        return {"groupId": group["id"], "preflightSeconds": bootstrap["durationSeconds"],
                "executionSeconds": timing["durationSeconds"], "phases": phases,
                "builds": [{"drvPath": item["drvPath"], "name": item["name"],
                            "buildSeconds": item["buildSeconds"]} for item in built],
                "report": str(report.relative_to(self.directory))}

    def compare(self):
        self.resolve()
        self.seed_cache()
        independent = [self.plan(package, [package]) for package in ["fmt", "astring"]]
        coordinated = self.plan("coordinated", ["fmt", "astring"])
        independent_caches = [new_cache(self.directory / "output-caches" / plan["name"])
                              for plan in independent]
        shared_cache = new_cache(self.directory / "output-caches" / "coordinated")
        started = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.execute, plan, plan["groups"][0], cache)
                       for plan, cache in zip(independent, independent_caches)]
            independent_results = [future.result() for future in futures]
        independent_wall = time.time() - started
        started = time.time()
        shared = next(group for group in coordinated["groups"] if group["kind"] == "shared")
        coordinated_results = [self.execute(coordinated, shared, shared_cache)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.execute, coordinated, group, shared_cache)
                       for group in coordinated["groups"] if group["kind"] == "package"]
            coordinated_results += [future.result() for future in futures]
        coordinated_wall = time.time() - started
        expected_roots = {self.packages[name]["drvPath"]: 1 for name in ["fmt", "astring"]}
        for name, results, expected_topkg in [("independent", independent_results, 2),
                                              ("coordinated", coordinated_results, 1)]:
            observed = collections.Counter(build["drvPath"] for result in results for build in result["builds"])
            expected = collections.Counter(expected_roots)
            expected[self.packages["topkg"]["drvPath"]] = expected_topkg
            require(observed == expected, "Observed comparison differs from expected duplication: " + repr(observed))
            self.summary[name] = {"workers": results, "observedBuildCounts": dict(observed),
                "buildCount": sum(observed.values()),
                "buildSeconds": sum(build["buildSeconds"] for result in results for build in result["builds"])}
        self.summary["independent"].update(wallSeconds=independent_wall,
            planningSeconds=sum(plan["planningSeconds"] for plan in independent),
            outputCacheFileBytes=sum(directory_bytes(cache) for cache in independent_caches))
        self.summary["coordinated"].update(wallSeconds=coordinated_wall,
            planningSeconds=coordinated["planningSeconds"], outputCacheFileBytes=directory_bytes(shared_cache))
        for plan in [*independent, coordinated]:
            self.run("aggregate-" + plan["name"], [self.executable,
                "--aggregate-plan", str(plan["directory"]),
                "--reports", str(self.directory / "reports" / plan["name"]),
                "--report-dir", str(self.directory / "aggregate" / plan["name"])])
        self.summary["status"] = "success"

    def finish(self, error=None):
        if error:
            self.summary.update(status="failed", error=str(error))
        self.summary["finishedAt"] = time.time()
        write_json(self.directory / "benchmark.json", self.summary)
        lines = ["# Shared dependency comparison", "", "Status: **%s**" % self.summary["status"], ""]
        if error:
            lines += ["The bounded experiment stopped: `%s`" % str(error).replace("`", "'"), ""]
        if "independent" in self.summary:
            lines += ["Unmodified `fmt` and `astring` from the repository's locked nix-overlays; only those roots and `topkg` were missing.", "",
                      "| Observed metric | Independent stores | Coordinated stores |",
                      "| --- | ---: | ---: |"]
            for label, field, unit in [("Derivations built", "buildCount", ""),
                                       ("Build activity", "buildSeconds", " s"),
                                       ("Worker wall time", "wallSeconds", " s"),
                                       ("Planning", "planningSeconds", " s"),
                                       ("Published cache files", "outputCacheFileBytes", " bytes")]:
                values = [self.summary[case][field] for case in ["independent", "coordinated"]]
                lines.append("| %s | %s | %s |" % (label, *["%.2f%s" % (value, unit) for value in values]))
            lines += ["", "Build activity is elapsed Nix build time, not CPU time. Both cases run up to two workers with one core each on the same machine. The coordinated case adds a prerequisite barrier; small packages may finish later despite avoiding duplicate work. Seed/bootstrap costs are separate. Cache file bytes are bytes on disk, not measured network traffic.", "",
                      "Full worker traces, phase timings, exact derivations, bounded-work checks, and aggregate reports are attached."]
        (self.directory / "summary.md").write_text("\n".join(lines) + "\n")


def self_test():
    legacy = {"/nix/store/a-root.drv": {
        "name": "root", "system": "x86_64-linux", "inputDrvs": {},
        "outputs": {"out": {"path": "/nix/store/a-root"}},
    }}
    modern = {"version": 3, "derivations": {"a-root.drv": {
        "name": "root", "system": "x86_64-linux", "inputs": {"drvs": {}},
        "outputs": {"out": {"hash": "fixed-output-hash", "method": "flat"}},
        "env": {"out": "/nix/store/a-root"},
    }}}
    assert normalize_graph(legacy) == normalize_graph(modern)
    graph = {
        "root": {"inputs": {"shared": ["out"], "compiler": ["out"]}, "outputs": {"out": "/root"}},
        "shared": {"inputs": {"compiler": ["out"]}, "outputs": {"out": "/shared", "dev": "/shared-dev"}},
        "compiler": {"inputs": {}, "outputs": {"out": "/compiler"}},
    }
    roots = [{"drvPath": "root", "outputs": ["out"]}]
    assert missing_derivations(graph, roots, {"/compiler"}) == {"root", "shared"}
    assert missing_derivations(graph, roots, {"/compiler", "/shared"}) == {"root"}
    assert missing_derivations(graph, roots, {"/root"}) == set()
    assert missing_derivations(graph, roots, set()) == {"root", "shared", "compiler"}
    assert missing_derivations(graph, [{"drvPath": "shared", "outputs": ["out", "dev"]}],
                               {"/compiler", "/shared"}) == {"shared"}
    try:
        missing_derivations(graph, [{"drvPath": "missing", "outputs": ["out"]}], set())
    except KeyError:
        pass
    else:
        raise AssertionError("Missing graph nodes must fail closed")
    graph["unresolved"] = {"inputs": {}, "outputs": {"out": None}}
    try:
        missing_derivations(graph, [{"drvPath": "unresolved", "outputs": ["out"]}], set())
    except RuntimeError:
        pass
    else:
        raise AssertionError("Unresolved missing outputs must fail closed")
    print("Bounded-work guard checks passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", nargs="?", type=Path)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--copy-from", action="append", dest="caches")
    parser.add_argument("--max-seed-bytes", type=int, default=2 * 1024 ** 3)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    require(platform.system() == "Linux", "Real package builds require Linux chroot stores")
    require(args.executable and args.executable.is_file(), "Pass a built nix-ci-build executable")
    require(args.directory is not None, "Pass --directory to retain all experiment evidence")
    args.directory.mkdir(parents=True, exist_ok=False)
    benchmark = Benchmark(args.executable, args.directory, args.caches or DEFAULT_CACHES, args.max_seed_bytes)
    try:
        benchmark.compare()
    except Exception as error:
        benchmark.finish(error)
        raise
    benchmark.finish()


if __name__ == "__main__":
    main()
