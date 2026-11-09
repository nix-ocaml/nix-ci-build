#!/usr/bin/env python3
"""A small, stateful Nix protocol fixture for the executable integration tests.

It models dependencies, local/remote validity, concurrent builds, structured
activity logs and failed downloads.  It intentionally rejects attempts to
realize derivations while copying, so cache tests exercise already-built paths.
"""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import sys
import time


DIRECTORY = Path(os.environ["NIX_CI_FIXTURE"])
CONFIG = json.loads((DIRECTORY / "fixture.json").read_text())
NODES = CONFIG.get("derivations", {})
OUTPUT_TO_DRV = {
    output: drv
    for drv, node in NODES.items()
    for output in node["outputs"].values()
}
REMOTE = "https://cache.fixture.invalid"


@contextlib.contextmanager
def state():
    with (DIRECTORY / "state.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = DIRECTORY / "state.json"
        value = json.loads(path.read_text())
        yield value
        temporary = DIRECTORY / ("state.%s.tmp" % os.getpid())
        temporary.write_text(json.dumps(value))
        temporary.replace(path)


def record(kind, **fields):
    # Older macOS Python versions use a process-relative monotonic epoch.
    # These records are compared across several independent fixture processes.
    item = {"kind": kind, "time": time.time(), "pid": os.getpid(), **fields}
    with (DIRECTORY / "trace.jsonl").open("a") as trace:
        fcntl.flock(trace, fcntl.LOCK_EX)
        trace.write(json.dumps(item) + "\n")
        trace.flush()


def emit(item):
    print("@nix " + json.dumps(item), file=sys.stderr, flush=True)


def message(text, level=0):
    emit({"action": "msg", "level": level, "msg": text})


def stripped_args(args):
    """Remove global options while retaining subcommand flags and arguments."""
    result = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("--experimental-features", "--extra-experimental-features"):
            index += 2
        elif arg == "--option":
            index += 3
        elif arg in ("--accept-flake-config", "--show-trace", "--offline"):
            index += 1
        else:
            result.append(arg)
            index += 1
    return result


def paths_from_args(args):
    paths = []
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in (
            "--store", "--to", "--from", "--log-format", "--max-jobs",
            "--cores", "--timeout", "--max-silent-time", "--out-link",
            "--add-root", "--substituters", "--extra-substituters",
        ):
            skip = True
        elif arg.startswith("/nix/store/"):
            paths.append(arg)
    if "--stdin" in args:
        paths.extend(line.strip() for line in sys.stdin if line.strip())
    return paths


def option(args, name, default=None):
    if name in args:
        return args[args.index(name) + 1]
    return next((arg[len(name) + 1:] for arg in args if arg.startswith(name + "=")), default)


def closure(roots):
    found = set()

    def visit(drv):
        if drv in found or drv not in NODES:
            return
        found.add(drv)
        for dependency in NODES[drv].get("inputDrvs", {}):
            visit(dependency)

    for root in roots:
        visit(root.split("^")[0])
    return found


def derivations(args):
    roots = paths_from_args(args)
    selected = closure(roots) if "--recursive" in args or "-r" in args else set(roots)
    if not roots:
        selected = set(NODES)
    result = {}
    for drv in sorted(selected):
        node = NODES[drv]
        result[drv] = {
            "name": node["name"],
            "system": node.get("system", "x86_64-linux"),
            "outputs": {name: {"path": path} for name, path in node["outputs"].items()},
            "inputDrvs": node.get("inputDrvs", {}),
            "inputSrcs": [],
            "env": {"name": node["name"], "out": node["outputs"]["out"], **node.get("env", {})},
            "builder": "/bin/sh",
            "args": [],
        }
    record("derivation_query", roots=roots, returned=sorted(result))
    print(json.dumps(result))
    return 0


def references_for_path(path):
    node = NODES.get(OUTPUT_TO_DRV.get(path), {})
    return node.get("references", [
        output
        for dependency in node.get("inputDrvs", {})
        for output in NODES[dependency]["outputs"].values()
    ])


def path_info(args):
    paths = paths_from_args(args)
    store = option(args, "--store")
    record("path_info", paths=paths, store=store)
    query_barrier = CONFIG.get("query_barriers", {}).get(store)
    if query_barrier and "narinfo-cache-negative-ttl" in sys.argv:
        publication = query_barrier["after_publication"]
        with state() as current:
            published = publication["path"] in current["remote"].get(publication["store"], [])
        if published:
            barrier(query_barrier["name"])
    with state() as current:
        available = set(current["local"] if store is None else current["remote"].get(store, []))
    if "--all" in args:
        paths = sorted(available)
    if "--recursive" in args or "-r" in args:
        pending = list(dict.fromkeys(paths))
        seen = set(pending)
        for path in pending:
            for reference in references_for_path(path):
                if reference not in seen:
                    seen.add(reference)
                    pending.append(reference)
        paths = pending
    result = {}
    missing = False
    for path in paths:
        if path not in available:
            missing = True
            result[path] = None
            continue
        drv = OUTPUT_TO_DRV.get(path)
        node = NODES.get(drv, {})
        result[path] = {
            "path": path,
            "deriver": drv,
            "narHash": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "narSize": node.get("narSize", 1024),
            "downloadSize": node.get("downloadSize", 512),
            "references": references_for_path(path),
            "valid": True,
            "registrationTime": 0,
            "ultimate": False,
        }
    if "--json" in args:
        print(json.dumps(result))
    else:
        for path in paths:
            if path in available:
                print(path)
    if missing:
        print("error: path is not valid in the requested store", file=sys.stderr)
    failure = CONFIG.get("path_info_error")
    if failure and failure.get("store") == store:
        print(failure["message"], file=sys.stderr)
        return failure.get("exit", 1)
    return 1 if missing else 0


def next_activity():
    with state() as current:
        current["activity"] += 1
        return current["activity"]


@contextlib.contextmanager
def output_locks(outputs):
    """Local builds and imports contend for the same output-path locks."""
    with contextlib.ExitStack() as stack:
        for output in sorted(set(outputs)):
            lock = stack.enter_context((DIRECTORY / (Path(output).name + ".output.lock")).open("a"))
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def barrier(name):
    if name is None:
        return
    record("barrier_waiting", name=name)
    deadline = time.monotonic() + 25
    while not (DIRECTORY / ("release-" + name)).exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("fixture barrier timed out: " + name)
        time.sleep(0.01)
    record("barrier_released", name=name)


def realize(drv):
    node = NODES[drv]
    outputs = list(node["outputs"].values())
    # Nix tries substitutes before realizing inputs. A running request does not
    # keep asking the remote cache once it has committed to the build path.
    with state() as current:
        valid = all(output in current["local"] for output in outputs)
        cached_source = next((source for source in CONFIG.get("substituters", [REMOTE]) if all(
            output in current["remote"].get(source, []) for output in outputs
        )), None) if node.get("env", {}).get("allowSubstitutes", "1") == "1" else None
    if valid:
        return True
    if cached_source:
        with output_locks(outputs):
            with state() as current:
                if all(output in current["local"] for output in outputs):
                    return True
            activity = next_activity()
            emit({"action": "start", "id": activity, "level": 3, "type": 108,
                  "text": "copying path", "fields": [outputs[0], cached_source], "parent": 0})
            barrier(node.get("download_barrier"))
            time.sleep(node.get("download_delay", 0))
            with state() as current:
                current["local"] = sorted(set(current["local"] + outputs))
            record("substituted", drv=drv, outputs=outputs)
            emit({"action": "stop", "id": activity})
            return True
    record("substitution_miss", drv=drv)
    failed_dependencies = 0
    for dependency in node.get("inputDrvs", {}):
        if not realize(dependency):
            failed_dependencies += 1
    if failed_dependencies:
        message("error: %d dependencies of derivation '%s' failed to build" % (failed_dependencies, drv))
        return False
    # Output locks are acquired after inputs are ready. An external cache import
    # can make these outputs valid while this request waits for its inputs.
    with output_locks(outputs):
        with state() as current:
            valid = all(output in current["local"] for output in outputs)
        if valid:
            record("build_avoided", drv=drv, outputs=outputs)
            return True
        with state() as current:
            attempt = current["attempts"].get(drv, 0) + 1
            current["attempts"][drv] = attempt
        record("build_started", drv=drv, attempt=attempt)
        activity = next_activity()
        emit({"action": "start", "id": activity, "level": 3, "type": 105,
              "text": "building '%s'" % drv, "fields": [drv, "", 1, 1], "parent": 0})
        emit({"action": "result", "id": activity, "type": 104, "fields": ["buildPhase"]})
        for line in node.get("log", ["fixture build output for " + node["name"]]):
            emit({"action": "result", "id": activity, "type": 101, "fields": [line]})
        barrier(node.get("barrier"))
        time.sleep(node.get("delay", 0.01))
        behavior = node.get("behavior", "success")
        failed = behavior == "fail" or (behavior == "transient" and attempt <= node.get("fail_attempts", 1))
        if failed:
            if behavior == "transient":
                message("error: builder for '%s' failed with exit code 1; last log lines:\n       > unable to download 'https://fixture.invalid/source.tar.gz': HTTP error 504 (Gateway Timeout)" % drv)
            else:
                message("error: builder for '%s' failed with exit code 1; last log lines:\n       > %s" % (drv, node.get("failure", "fixture compiler error")))
            emit({"action": "stop", "id": activity})
            record("build_failed", drv=drv, attempt=attempt, behavior=behavior)
            return False
        with state() as current:
            current["local"] = sorted(set(current["local"] + outputs))
            current["built"].append(drv)
            for target, trigger in CONFIG.get("cache_after", {}).items():
                if trigger["after_build"] == drv:
                    if trigger.get("store", "local") == "local":
                        current["local"] = sorted(set(current["local"] + [target]))
                    else:
                        destination = trigger["store"]
                        current["remote"][destination] = sorted(set(current["remote"].get(destination, []) + [target]))
        emit({"action": "stop", "id": activity})
        record("build_finished", drv=drv, attempt=attempt, outputs=outputs)
        return True


def build(args):
    roots = [path.split("^")[0] for path in paths_from_args(args)]
    if "--dry-run" in args:
        print(json.dumps([{"drvPath": drv, "outputs": NODES[drv]["outputs"]} for drv in roots]))
        return 0
    wait = CONFIG.get("request_wait")
    if wait:
        activity = next_activity()
        emit({"action": "start", "id": activity, "level": 3, "type": 111,
              "text": wait["reason"], "fields": [], "parent": 0})
        time.sleep(wait["seconds"])
        emit({"action": "stop", "id": activity})
    for download in CONFIG.get("runtime_downloads", []):
        path = download["path"]
        with state() as current:
            valid = path in current["local"]
        if valid:
            continue
        activity = next_activity()
        emit({"action": "start", "id": activity, "level": 3, "type": 108,
              "text": "copying runtime closure path", "fields": [path, REMOTE], "parent": 0})
        time.sleep(download["seconds"])
        with state() as current:
            current["local"] = sorted(set(current["local"] + [path]))
        emit({"action": "stop", "id": activity})
        record("runtime_download_finished", path=path)
    successful = True
    for drv in roots:
        if not realize(drv):
            successful = False
    return 0 if successful else 100


def copy(args):
    paths = paths_from_args(args)
    if any("^" in path or path.endswith(".drv") for path in paths):
        print("fixture: copying must never realize a derivation", file=sys.stderr)
        return 97
    source = option(args, "--from")
    if source is not None:
        return import_paths(source, paths)
    destination = option(args, "--to")
    with state() as current:
        missing = [path for path in paths if path not in current["local"]]
    if missing:
        print("fixture: copy called for an unrealized output", file=sys.stderr)
        return 96
    record("copy_started", paths=paths, destination=destination)
    time.sleep(CONFIG.get("copy_delay", 0))
    if CONFIG.get("copy_failure"):
        print("error: cache upload fixture failure", file=sys.stderr)
        return 1
    with state() as current:
        current["copied"].extend(paths)
        current["remote"][destination] = sorted(set(current["remote"].get(destination, []) + paths))
    record("copy_finished", paths=paths, destination=destination)
    return 0


def import_paths(source, paths):
    options = dict(CONFIG.get("import", {}))
    for path in paths:
        options.update(CONFIG.get("import_by_path", {}).get(path, {}))
    with state() as current:
        missing = [path for path in paths if path not in current["remote"].get(source, [])]
        current["import_attempts"] = current.get("import_attempts", 0) + 1
        attempt = current["import_attempts"]
    record("import_started", paths=paths, source=source, attempt=attempt)
    if missing:
        print("error: fixture import requested unavailable cache outputs", file=sys.stderr)
        return 96
    barrier(options.get("before_lock_barrier"))
    if options.get("behavior") == "hang_before_lock":
        time.sleep(25)
    with output_locks(paths):
        barrier(options.get("barrier"))
        time.sleep(options.get("delay", 0))
        if options.get("behavior") == "fail":
            error = options.get("error", "error: HTTP error 504 importing fixture output")
            if options.get("tag_attempts"):
                error += " (attempt %d)" % attempt
            print(error, file=sys.stderr)
            record("import_failed", paths=paths, source=source)
            return 1
        with state() as current:
            current["local"] = sorted(set(current["local"] + paths))
            current["imported"] = sorted(set(current.get("imported", []) + paths))
        record("import_finished", paths=paths, source=source)
    return 0


def evaluate():
    for index, job in enumerate(CONFIG.get("jobs", [])):
        if CONFIG.get("eval_invalid_after") == index:
            print("{invalid evaluation JSON", flush=True)
            break
        print(json.dumps(job), flush=True)
        time.sleep(CONFIG.get("eval_delay", 0))
    if CONFIG.get("evaluation_stderr"):
        print(CONFIG["evaluation_stderr"], file=sys.stderr, flush=True)
    return CONFIG.get("evaluation_exit", 0)


def main():
    tool = globals().get("TOOL_NAME", Path(sys.argv[0]).name)
    args = stripped_args(sys.argv[1:])
    record("command", tool=tool, args=args, rawArgs=sys.argv[1:])
    if args == ["--version"]:
        print("nix-eval-jobs 2.35.0" if tool == "nix-eval-jobs" else "nix (Nix) 2.35.3")
        return 0
    if tool == "nix-eval-jobs":
        return evaluate()
    if tool == "nix-store":
        if "--add-root" in args:
            paths = paths_from_args(args)
            with state() as current:
                valid = all(path in current["local"] for path in paths)
            if not valid:
                print("fixture: GC pin attempted to realize an unavailable output", file=sys.stderr)
                return 96
            root = option(args, "--add-root")
            Path(root).parent.mkdir(parents=True, exist_ok=True)
            Path(root).write_text("\n".join(paths))
            print("\n".join(paths))
            return 0
        print("fixture: unsupported nix-store command: %r" % args, file=sys.stderr)
        return 95
    if args[:2] == ["config", "show"] or args[:1] == ["show-config"]:
        substituters = CONFIG.get("substituters", [REMOTE])
        if "--json" in args:
            print(json.dumps({"substituters": {"value": substituters}, "experimental-features": {"value": ["nix-command", "flakes"]}}))
        else:
            print(" ".join(substituters))
        return 0
    if args[:2] == ["derivation", "show"] or args[:1] == ["show-derivation"]:
        return derivations(args)
    if args[:1] == ["path-info"]:
        return path_info(args)
    if args[:1] == ["build"]:
        return build(args)
    if args[:1] == ["copy"]:
        return copy(args)
    if args[:1] == ["log"]:
        for path in paths_from_args(args):
            print("\n".join(NODES[path].get("log", [])))
        return 0
    print("fixture: unsupported nix command: %r" % args, file=sys.stderr)
    return 94


if __name__ == "__main__":
    sys.exit(main())
