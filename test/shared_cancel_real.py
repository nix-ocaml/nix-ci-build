#!/usr/bin/env python3
"""Prove local cancellation stops workers, Nix, and active fixture builders.

Run inside nix develop with an executable and a new --directory. This uses
independent disposable stores and a host-shell fixture with sandboxing disabled.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time

from shared_plan_real import RealFixture, check, read_json, write_json


def snapshot(pid):
    result = subprocess.run(
        ["ps", "-o", "pid=,ppid=,stat=,lstart=,command=", "-p", str(pid)],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    fields = result.stdout.strip().split(None, 3)
    if len(fields) != 4:
        return None
    return {"pid": int(fields[0]), "parent": int(fields[1]),
            "state": fields[2], "identity": fields[3]}


def live(previous):
    current = snapshot(previous["pid"])
    return current is not None and current["identity"] == previous["identity"] and not current["state"].startswith("Z")


def cancel_run(fixture, name, checkpoint, extra_pids=(), wrapper=None):
    report = fixture.directory / "reports" / name
    tracked = {}
    with fixture.store(name, worker=True) as environment:
        if wrapper:
            environment["PATH"] = str(wrapper) + os.pathsep + environment["PATH"]
        command = [fixture.executable, "--run-plan", str(fixture.plan),
                   "--workers", "1", "--jobs", "1", "--copy-from", fixture.cache_url,
                   "--copy-to", fixture.cache_url, "--report-dir", str(report),
                   "--cache-refresh", "0", "--heartbeat", "0.1", "--retries", "0"]
        process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 30
            while not checkpoint.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            check(checkpoint.exists(), name + " never reached its cancellation checkpoint")
            pid = int(checkpoint.read_text())
            while pid not in tracked:
                current = snapshot(pid)
                check(current is not None, "active child disappeared before cancellation")
                tracked[pid] = current
                if pid == process.pid:
                    break
                pid = current["parent"]
            check(process.pid in tracked, "active command must descend from the local executor")
            check(any("--execute-plan" in item["identity"] for item in tracked.values()), "worker PID was not captured")
            for path in extra_pids:
                deadline = time.monotonic() + 5
                while not path.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                check(path.exists(), "fixture child PID was not recorded")
                current = snapshot(int(path.read_text()))
                check(current is not None, "fixture child is not running")
                tracked[current["pid"]] = current
            interrupted = time.monotonic()
            process.terminate()
            stdout, stderr = process.communicate(timeout=15)
            (report / "runner.stdout").write_text(stdout)
            (report / "runner.stderr").write_text(stderr)
            check(process.returncode == 130, name + " cancellation must exit130, got " + str(process.returncode))
            deadline = time.monotonic() + 3
            while any(live(item) for item in tracked.values()) and time.monotonic() < deadline:
                time.sleep(0.05)
            survivors = [item for item in tracked.values() if live(item)]
            write_json(report / "cancellation-processes.json", {
                "seconds": time.monotonic() - interrupted,
                "tracked": list(tracked.values()), "survivors": survivors,
            })
            check(not survivors, name + " left active child processes: " + json.dumps(survivors))
            scheduler = [json.loads(line) for line in (report / "scheduler-events.jsonl").read_text().splitlines()]
            check(scheduler[-1]["type"] == "run_finish" and scheduler[-1]["status"] == "cancelled", "scheduler must record cancellation")
            attempt = next(event for event in scheduler if event["type"] == "dispatched")
            worker_report = report / "runs" / attempt["runId"] / attempt["groupId"] / attempt["attemptId"]
            execution = read_json(worker_report / "execution.json")
            check(execution["status"] == "cancelled", "worker must finish cancellation before scheduler exits")
            events = [json.loads(line) for line in (worker_report / "execution-events.jsonl").read_text().splitlines()]
            check(events[-1]["type"] == "attempt_finish" and events[-1]["status"] == "cancelled", "attempt must retain truthful terminal status")
            check(not any(event["type"] == "phase_finish" and event.get("phase") == "publish" and event.get("status") == "success" for event in events), "cancelled execution must not publish success")
            return len(tracked)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            # A failing regression must not leave its intentionally slow
            # processes behind. Verify each recorded identity before killing.
            for item in tracked.values():
                if item["pid"] != os.getpid() and live(item):
                    os.kill(item["pid"], signal.SIGKILL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    if args.directory:
        args.directory.mkdir(parents=True, exist_ok=False)
        directory = args.directory
    else:
        directory = Path(tempfile.mkdtemp(prefix="nix-ci-cancel-real-"))
    fixture = RealFixture(args.executable, directory)
    source = fixture.directory / "fixture"
    source.mkdir()
    builder_pid = fixture.directory / "builder.pid"
    sleep_pid = fixture.directory / "sleep.pid"
    (source / "flake.nix").write_text('''{
      outputs = { self }: let settings = import ./settings.nix; in {
        fixture.root = derivation {
          name = "cancellation-fixture";
          system = settings.system;
          builder = "/bin/sh";
          builderPid = settings.builderPid;
          sleepPid = settings.sleepPid;
          args = [ "-eu" "-c" ''
            printf '%s\\n' "$$" > "$builderPid"
            /bin/sleep 30 &
            sleeper=$!
            printf '%s\\n' "$sleeper" > "$sleepPid"
            wait "$sleeper"
            printf fixture-built > "$out"
          '' ];
        };
      };
    }
    ''')
    with fixture.store("planner") as environment:
        system = fixture.run("system", ["nix", "eval", "--raw", "--impure", "--expr", "builtins.currentSystem"], environment).stdout.strip()
        (source / "settings.nix").write_text(
            "{ system = %s; builderPid = %s; sleepPid = %s; }\n"
            % (json.dumps(system), json.dumps(str(builder_pid)), json.dumps(str(sleep_pid))))
        sets = fixture.directory / "sets.json"
        write_json(sets, {"sets": [{"id": "fixture", "flake": "path:" + str(source) + "#fixture"}]})
        fixture.run("plan", [fixture.executable, "--plan-sets", str(sets), "--copy-from", fixture.cache_url,
                    "--report-dir", str(fixture.plan), "--jobs", "1"], environment)
    active_processes = cancel_run(fixture, "active-build", builder_pid, [sleep_pid])

    wrapper = fixture.directory / "import-wrapper"
    wrapper.mkdir()
    import_pid = fixture.directory / "import.pid"
    nix = wrapper / "nix"
    nix.write_text(
        "#!/bin/sh\n"
        'case " $* " in\n'
        '  *" copy --derivation "*)\n'
        "    printf '%s\\n' \"$$\" > " + shlex.quote(str(import_pid)) + "\n"
        "    exec /bin/sleep 30\n"
        "    ;;\n"
        "esac\n"
        "exec " + shlex.quote(shutil.which("nix")) + ' "$@"\n')
    nix.chmod(0o755)
    importing_processes = cancel_run(fixture, "importing-plan", import_pid, wrapper=wrapper)
    write_json(fixture.directory / "verification.json", {
        "status": "success", "cancelledRuns": 2,
        "activeBuildProcessesChecked": active_processes,
        "importProcessesChecked": importing_processes,
        "survivingProcesses": 0,
    })
    print("Local cancellation left no workers, Nix commands, or builders: " + str(fixture.directory))


if __name__ == "__main__":
    main()
