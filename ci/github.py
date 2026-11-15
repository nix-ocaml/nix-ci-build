#!/usr/bin/env python3
"""GitHub workflow adapter for the portable shared-plan CLI.

Run from the caller's checkout. Only planning evaluates its flake references;
workers use the downloaded plan, normalized config, and signed builder closure.
"""

import argparse
import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
from urllib.parse import parse_qsl, quote, urlsplit


DEFAULT_RUNNERS = {
    "x86_64-linux": "ubuntu-latest",
    "aarch64-linux": "ubuntu-24.04-arm",
    "aarch64-darwin": "macos-latest",
}
BUILDER_CACHE = "https://cache.thalheim.io"
BUILDER_KEY = "cache.thalheim.io-1:R7msbosLEZKrxk/lKxf9BTjOOH7Ax3H0Qj0/6wiHOgc="
STORE_PATH = re.compile(r"/nix/store/[a-z0-9]{32}-[^/\s]+")
SYSTEM = re.compile(r"[a-zA-Z0-9_]+-[a-zA-Z0-9_]+")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def text(value, label):
    require(isinstance(value, str) and value.strip() and not any(
        ord(char) < 32 for char in value), label + " must be a nonempty single-line string")
    return value


def object_fields(value, label, allowed):
    require(isinstance(value, dict), label + " must be an object")
    require(not set(value) - set(allowed), label + " has unknown fields")
    return value


def cache_uri(value, label):
    value = text(value, label)
    require(not any(char.isspace() for char in value), label + " must not contain whitespace")
    parsed = urlsplit(value)
    require(parsed.scheme in {"https", "http", "s3", "file"}
            and (parsed.netloc or parsed.scheme == "file" and parsed.path.startswith("/")),
            label + " must be an HTTP, S3, or absolute file cache URI")
    require(not parsed.username and not parsed.password and not parsed.fragment,
            label + " must not embed credentials or a fragment")
    sensitive = {"secret-key", "secret-key-file", "token", "access_token", "password",
                 "access-key", "secret-access-key"}
    require(not any(key.lower() in sensitive for key, _ in parse_qsl(parsed.query)),
            label + " must use environment credentials, not URI secrets")
    return value


def key_bytes(value, length, label):
    require(isinstance(value, str) and value.count(":") == 1, label + " has invalid format")
    name, encoded = value.split(":")
    require(name and not any(char.isspace() for char in name), label + " has invalid name")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error):
        raise ValueError(label + " has invalid encoding") from None
    require(len(data) == length, label + " has invalid length")
    return name, data


def normalize_config(value):
    value = object_fields(value, "config", {"sets", "runners", "cache", "limits", "nixConfig", "timeoutMinutes"})
    timeout = value.get("timeoutMinutes", 360)
    require(type(timeout) is int and 1 <= timeout <= 360,
            "timeoutMinutes must be an integer between 1 and 360")
    sets = value.get("sets")
    require(isinstance(sets, list) and sets, "sets must be a nonempty array")
    selected = []
    for entry in sets:
        entry = object_fields(entry, "set", {"id", "flake"})
        selected.append({"id": text(entry.get("id"), "set.id"),
                         "flake": text(entry.get("flake"), "set.flake")})
    require(len({entry["id"] for entry in selected}) == len(selected), "set IDs must be unique")
    runners = dict(DEFAULT_RUNNERS)
    supplied = value.get("runners", {})
    require(isinstance(supplied, dict), "runners must be an object")
    for system, labels in supplied.items():
        require(isinstance(system, str) and SYSTEM.fullmatch(system), "invalid runner system")
        require(isinstance(labels, str) or isinstance(labels, list) and labels,
                "runner must be a label or nonempty array of labels")
        for label in [labels] if isinstance(labels, str) else labels:
            text(label, "runner label")
        runners[system] = labels
    cache = object_fields(value.get("cache"), "cache", {"read", "write", "publicKeys"})
    require(isinstance(cache.get("read"), list) and cache["read"], "cache.read must be a nonempty array")
    reads = list(dict.fromkeys(cache_uri(uri, "cache.read entry") for uri in cache["read"]))
    destination = cache_uri(cache.get("write"), "cache.write")
    keys = cache.get("publicKeys")
    require(isinstance(keys, list) and keys, "cache.publicKeys must be a nonempty array")
    for key in keys:
        key_bytes(key, 32, "cache public key")
    limits = object_fields(value.get("limits", {}), "limits",
                           {"maxBuilds", "maxBoundaryNarBytes", "allowedDerivations"})
    for name in ["maxBuilds", "maxBoundaryNarBytes"]:
        if name in limits:
            require(type(limits[name]) is int and limits[name] >= 0, name + " must be a nonnegative integer")
    if "allowedDerivations" in limits:
        require(isinstance(limits["allowedDerivations"], list), "allowedDerivations must be an array")
        for ref in limits["allowedDerivations"]:
            text(ref, "allowed derivation")
            if ref.startswith("/nix/store/"):
                require(STORE_PATH.fullmatch(ref) and ref.endswith(".drv"), "invalid allowed derivation path")
    nix_config = value.get("nixConfig", "")
    require(isinstance(nix_config, str) and "\x00" not in nix_config, "nixConfig must be a string")
    for line in nix_config.splitlines():
        setting = line.split("#", 1)[0].strip()
        require(not re.match(r"!?include\s", setting), "nixConfig cannot include unretained files")
        require(not re.match(r"(?:extra-)?(?:secret-key-files|access-tokens|netrc-file)\s*=", setting),
                "nixConfig must not contain private credentials")
        if re.match(r"require-sigs\s*=", setting):
            require(setting.split("=", 1)[1].strip() == "true", "signature verification must remain enabled")
        if re.match(r"(?:extra-)?(?:substituters|trusted-substituters)\s*=", setting):
            for uri in setting.split("=", 1)[1].split():
                cache_uri(uri, "nixConfig cache")
    return {"sets": selected, "runners": runners,
            "cache": {"read": reads, "write": destination, "publicKeys": list(dict.fromkeys(keys))},
            "limits": limits, "nixConfig": nix_config, "timeoutMinutes": timeout}


def nix_config(config):
    return "\n".join([
        config["nixConfig"].rstrip(),
        "extra-experimental-features = nix-command flakes",
        "extra-substituters = " + " ".join(dict.fromkeys([BUILDER_CACHE, *config["cache"]["read"]])),
        "extra-trusted-public-keys = " + " ".join(dict.fromkeys([BUILDER_KEY, *config["cache"]["publicKeys"]])),
        "require-sigs = true", "",
    ])


def github_value(filename, name, value):
    path = os.environ.get(filename)
    if path:
        delimiter = "nix_ci_" + secrets.token_hex(16)
        with open(path, "a") as stream:
            stream.write(name + "<<" + delimiter + "\n" + value + "\n" + delimiter + "\n")


def configure(config):
    rendered = nix_config(config)
    github_value("GITHUB_OUTPUT", "nix-config", rendered)
    github_value("GITHUB_ENV", "NIX_CONFIG", rendered)
    github_value("GITHUB_OUTPUT", "timeout-minutes", str(config["timeoutMinutes"]))


def command(argv, *, capture=False, env=None):
    environment = dict(os.environ if env is None else env)
    environment.pop("NIX_CACHE_SIGNING_KEY", None)
    return subprocess.run(argv, check=True, text=True, env=environment,
                          stdout=subprocess.PIPE if capture else None).stdout


def nix_json(*args):
    return json.loads(command(["nix", *args], capture=True))


def current_system():
    result = command(["nix", "eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
                     capture=True).strip()
    require(SYSTEM.fullmatch(result), "Nix returned an invalid host system")
    return result


@contextmanager
def signing_key(config, artifact_directories=()):
    secret = os.environ.get("NIX_CACHE_SIGNING_KEY", "").strip()
    name, data = key_bytes(secret, 64, "NIX_CACHE_SIGNING_KEY")
    public = name + ":" + base64.b64encode(data[32:]).decode()
    require(public in config["cache"]["publicKeys"], "signing key does not match cache.publicKeys")
    parent = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())).resolve()
    for artifact in artifact_directories:
        require(not parent.is_relative_to(Path(artifact).resolve()),
                "the private key directory must be outside uploaded artifacts")
    with tempfile.TemporaryDirectory(prefix="nix-ci-signing-", dir=parent) as directory:
        path = Path(directory) / "key"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(secret + "\n")
        yield path


def signed_uri(uri, key):
    separator = "&" if "?" in uri else "?"
    return uri + separator + "secret-key=" + quote(str(key), safe="/")


def identity(group):
    return {"groupId": group, "runId": os.environ.get("NIX_CI_BUILD_RUN_ID"),
            "attemptId": os.environ.get("NIX_CI_BUILD_ATTEMPT_ID")}


def bootstrap(args, config):
    started = time.time()
    directory = Path(args.tool)
    metadata = {"startedAt": started, "status": "failed", "operation": args.operation}
    if args.group:
        metadata.update(identity(args.group))
    try:
        system = current_system()
        if args.operation == "export":
            require(args.flake, "bootstrap export requires --flake")
            directory.mkdir(parents=True, exist_ok=True)
            with signing_key(config, [directory, args.report]) as key:
                tool = command(["nix", "build", "--accept-flake-config", "-L", "--no-link",
                                "--print-out-paths", args.flake], capture=True).strip()
                built = time.time()
                require(STORE_PATH.fullmatch(tool), "bootstrap must produce exactly one store path")
                (directory / "path").write_text(tool + "\n")
                (directory / "system").write_text(system + "\n")
                write_json(directory / "closure.json", nix_json("path-info", "--recursive", "--json", tool))
                destination = signed_uri((directory / "store").resolve().as_uri() + "?compression=zstd", key)
                command(["nix", "copy", "--to", destination, tool])
                metadata.update(buildSeconds=built - started, exportSeconds=time.time() - built)
        else:
            tool = (directory / "path").read_text().strip()
            require(STORE_PATH.fullmatch(tool), "invalid builder artifact path")
            require((directory / "system").read_text().strip() == system,
                    "builder artifact targets a different host system")
            command(["nix", "copy", "--from", (directory / "store").resolve().as_uri(), tool])
        metadata.update(toolPath=tool, system=system, status="success")
        if os.environ.get("GITHUB_PATH"):
            with open(os.environ["GITHUB_PATH"], "a") as stream:
                stream.write(tool + "/bin\n")
        github_value("GITHUB_OUTPUT", "system", system)
    except Exception as error:
        metadata["error"] = str(error)
        raise
    finally:
        metadata.update(finishedAt=time.time(), durationSeconds=time.time() - started)
        write_json(Path(args.report) / "bootstrap.json", metadata)


def resolve_allowed(config):
    refs = config["limits"].get("allowedDerivations")
    if refs is None:
        return None
    result = set()
    for ref in refs:
        drv = ref if ref.startswith("/nix/store/") else command(
            ["nix", "eval", "--raw", "--apply", "value: value.drvPath", ref], capture=True).strip()
        require(STORE_PATH.fullmatch(drv) and drv.endswith(".drv"),
                "allowedDerivations must resolve to exact derivation paths")
        result.add(drv)
    return sorted(result)


def validate_plan(manifest, config, allowed):
    plan = manifest["plan"]
    requests = [entry["id"] for entry in plan["requests"]]
    require(sorted(requests) == sorted(entry["id"] for entry in config["sets"]),
            "plan request IDs differ from configured sets")
    groups = plan["groups"]
    require(len({group["id"] for group in groups}) == len(groups), "duplicate execution group IDs")
    members = [drv for group in groups for drv in group["members"]]
    require(len(members) == len(set(members)), "a derivation has multiple owners")
    require(all(group["kind"] in {"shared", "package"} for group in groups), "unexpected group kind")
    for group in groups:
        require(group["system"] in config["runners"], "configure a runner for " + group["system"])
    if allowed is not None:
        unexpected = sorted(set(members) - set(allowed))
        require(not unexpected, "plan contains derivations outside allowedDerivations: " + ", ".join(unexpected))
    maximum = config["limits"].get("maxBuilds")
    require(maximum is None or len(members) <= maximum, "plan exceeds limits.maxBuilds")
    graph = manifest["graph"]
    owned_outputs = {path for drv in members for path in graph[drv]["outputs"].values() if path}
    boundary = {path for group in groups for path in group["requiredPaths"]} - owned_outputs
    require(boundary <= set(manifest["cachedPaths"]), "plan boundary is not available in the read caches")
    return {"ownedDerivations": sorted(members), "cachedBoundaryPaths": sorted(boundary),
            "sharedGroups": sum(group["kind"] == "shared" for group in groups),
            "packageGroups": sum(group["kind"] == "package" for group in groups),
            "warm": not groups}


def boundary_closure(paths, caches):
    closure = {}
    for path in paths:
        found = False
        for cache in caches:
            try:
                values = nix_json("path-info", "--store", cache, "--recursive", "--json", path)
            except subprocess.CalledProcessError:
                continue
            if isinstance(values, list):
                values = {value["path"]: value for value in values if value}
            if path not in values or not all(values.values()):
                continue
            require(all(type(value.get("narSize")) is int and value["narSize"] >= 0
                        for value in values.values()), "cache returned invalid boundary NAR sizes")
            closure.update(values)
            found = True
            break
        require(found, "no complete cached closure for boundary " + path)
    return closure


def matrices(manifest, config, system):
    require(SYSTEM.fullmatch(system), "invalid planner host system")
    groups = manifest["plan"]["groups"]
    shared, packages = [], []
    for group in groups:
        row = {"group": group["id"], "system": group["system"],
               "runner": config["runners"][group["system"]], "consumers": group["consumers"]}
        (shared if group["kind"] == "shared" else packages).append(row)
    bootstrap = [{"system": host, "runner": config["runners"][host]}
                 for host in sorted({group["system"] for group in groups} - {system})]
    return {"shared": {"include": shared}, "packages": {"include": packages},
            "bootstrap": {"include": bootstrap}, "has-shared": bool(shared),
            "has-packages": bool(packages), "has-bootstrap": bool(bootstrap)}


def plan_sets(args, config):
    directory = Path(args.plan)
    directory.mkdir(parents=True, exist_ok=True)
    write_json(directory / "workflow-config.json", config)
    write_json(directory / "sets.json", {key: config[key] for key in ["sets", "runners"]})
    started = time.time()
    metadata = {"startedAt": started, "status": "failed"}
    bounds = {"status": "failed"}
    try:
        environment = dict(os.environ)
        environment.pop("GITHUB_OUTPUT", None)
        argv = [args.tool, "--plan-sets", str(directory / "sets.json"), "--report-dir", args.plan]
        for cache in config["cache"]["read"]:
            argv += ["--copy-from", cache]
        command(argv, env=environment)
        manifest = read_json(directory / "execution-plan.json")
        allowed = resolve_allowed(config)
        bounds.update(validate_plan(manifest, config, allowed), allowedDerivations=allowed)
        maximum = config["limits"].get("maxBoundaryNarBytes")
        if maximum is not None:
            closure = boundary_closure(bounds["cachedBoundaryPaths"], config["cache"]["read"])
            total = sum(info["narSize"] for info in closure.values())
            write_json(directory / "boundary-closure.json", closure)
            bounds.update(boundaryNarBytes=total, boundaryPaths=len(closure))
            require(total <= maximum, "cached boundary exceeds limits.maxBoundaryNarBytes")
        bounds["status"] = "success"
        outputs = matrices(manifest, config, args.system or current_system())
        write_json(directory / "workflow-matrices.json", outputs)
        metadata["status"] = "success"
        for name, value in outputs.items():
            github_value("GITHUB_OUTPUT", name, json.dumps(value, separators=(",", ":")))
    except Exception as error:
        bounds["status"] = "failed"
        metadata["error"] = bounds["error"] = str(error)
        raise
    finally:
        metadata.update(finishedAt=time.time(), durationSeconds=time.time() - started)
        write_json(directory / "planning.json", metadata)
        write_json(directory / "workflow-bounds.json", bounds)


def saved_plan(directory, config):
    plan = Path(directory)
    saved = normalize_config(read_json(plan / "workflow-config.json"))
    require(saved == config, "worker configuration differs from the saved plan")
    bounds = read_json(plan / "workflow-bounds.json")
    require(bounds["status"] == "success", "planning bounds did not pass")
    manifest = read_json(plan / "execution-plan.json")
    require((bounds["allowedDerivations"] is None) == ("allowedDerivations" not in config["limits"]),
            "saved derivation bounds differ from configured limits")
    checked = validate_plan(manifest, config, bounds["allowedDerivations"])
    require(all(bounds.get(name) == value for name, value in checked.items()),
            "saved plan differs from its planning bounds")
    maximum = config["limits"].get("maxBoundaryNarBytes")
    if maximum is not None:
        closure = read_json(plan / "boundary-closure.json")
        require(set(checked["cachedBoundaryPaths"]) <= set(closure), "saved boundary closure is incomplete")
        sizes = [info["narSize"] for info in closure.values()]
        require(all(type(size) is int and size >= 0 for size in sizes), "saved boundary sizes are invalid")
        require(bounds.get("boundaryNarBytes") == sum(sizes) <= maximum,
                "saved boundary exceeds limits.maxBoundaryNarBytes or differs from its planning bounds")
    return manifest


def execute(args, config):
    plan = Path(args.plan)
    manifest = saved_plan(plan, config)
    require(any(group["id"] == args.group for group in manifest["plan"]["groups"]),
            "requested group is absent from the plan")
    with signing_key(config, [plan, args.report]) as key:
        argv = [args.tool, "--execute-plan", args.plan, "--group", args.group,
                "--copy-to", signed_uri(config["cache"]["write"], key), "--report-dir", args.report]
        for cache in config["cache"]["read"]:
            argv += ["--copy-from", cache]
        command(argv)


def aggregate(args, config):
    saved_plan(args.plan, config)
    stages = json.loads(os.environ.get("NIX_CI_BUILD_STAGE_RESULTS", "{}"))
    require(isinstance(stages, dict) and all(
        isinstance(name, str) and result in {"success", "failure", "cancelled", "skipped"}
        for name, result in stages.items()), "invalid workflow stage results")
    failed = {name: result for name, result in stages.items() if result in {"failure", "cancelled"}}
    status = {"stages": stages, "status": "failed" if failed else "incomplete"}
    write_json(Path(args.report) / "workflow-status.json", status)
    Path(args.reports).mkdir(parents=True, exist_ok=True)
    command([args.tool, "--aggregate-plan", args.plan, "--reports", args.reports, "--report-dir", args.report])
    report = read_json(Path(args.report) / "aggregate.json")
    status.update(observedReportStatus=report["status"],
                  status="success" if not failed and report["status"] == "success" else "failed")
    write_json(Path(args.report) / "workflow-status.json", status)
    if failed:
        summary = Path(args.report) / "summary.md"
        if summary.exists():
            summary.replace(Path(args.report) / "observed-summary.md")
        details = ", ".join(name + " (" + result + ")" for name, result in failed.items())
        summary.write_text("## Workflow failed\n\n" + details +
            ".\n\nThe combined HTML and JSON reports contain the available worker evidence; "
            "they do not establish success for the failed workflow stages.\n")
        raise ValueError("workflow stages failed or were cancelled: " + details)
    require(report["status"] == "success", "combined report contains failed, blocked, or missing workers")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("configure")
    boot = commands.add_parser("bootstrap")
    boot.add_argument("operation", choices=["export", "import"])
    boot.add_argument("--tool", default="tool")
    boot.add_argument("--report", required=True)
    boot.add_argument("--flake")
    boot.add_argument("--group")
    plan = commands.add_parser("plan")
    plan.add_argument("--tool", default="nix-ci-build")
    plan.add_argument("--plan", default="plan")
    plan.add_argument("--system")
    worker = commands.add_parser("execute")
    worker.add_argument("--tool", default="nix-ci-build")
    worker.add_argument("--plan", default="plan")
    worker.add_argument("--report", default="report")
    worker.add_argument("--group", required=True)
    report = commands.add_parser("aggregate")
    report.add_argument("--tool", default="nix-ci-build")
    report.add_argument("--plan", default="plan")
    report.add_argument("--reports", default="reports")
    report.add_argument("--report", default="aggregate")
    args = parser.parse_args()
    config = normalize_config(read_json(args.config))
    if args.command == "configure":
        configure(config)
        return
    os.environ["NIX_CONFIG"] = nix_config(config)
    {"bootstrap": bootstrap, "plan": plan_sets, "execute": execute, "aggregate": aggregate}[args.command](args, config)


if __name__ == "__main__":
    main()
