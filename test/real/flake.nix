{
  description = "Opt-in nix-ci-build integration fixtures using the host shell";

  outputs = _: {
    legacyPackages = builtins.listToAttrs (
      map
        (system: {
          name = system;
          value =
            let
              # real_test.py replaces the run ID in a temporary copy, ensuring
              # that a previous smoke test cannot satisfy these builds.
              mk =
                name: body: extra:
                builtins.derivation (
                  {
                    name = "nix-ci-build-real-${name}-FIXTURE_RUN_ID";
                    inherit system;
                    builder = "/bin/sh";
                    outputs = [ "out" ];
                    args = [
                      "-c"
                      ''
                        set -eu
                        printf 'fixture-build: ${name}\n' >&2
                        ${body}
                      ''
                    ];
                    preferLocalBuild = true;
                    allowSubstitutes = false;
                  }
                  // extra
                );
              shared = mk "shared" ''printf 'shared\n' > "$out"'' { };
              left = mk "left" ''printf '%s\n' '${shared}' > "$out"'' { };
              right = mk "right" ''printf '%s\n' '${shared}' > "$out"'' { };
              multi =
                mk "multi"
                  ''
                    printf 'runtime\n' > "$out"
                    printf 'development\n' > "$dev"
                  ''
                  {
                    outputs = [
                      "out"
                      "dev"
                    ];
                  };
              broken = mk "broken" ''
                printf 'fixture: deterministic compiler failure\n' >&2
                exit 17
              '' { };
              blocked = mk "blocked" ''printf '%s\n' '${broken}' > "$out"'' { };
              independent = mk "independent" ''printf 'independent\n' > "$out"'' { };
              dependencyMulti =
                mk "dependency-multi"
                  ''
                    printf 'runtime dependency\n' > "$out"
                    printf 'unused development output\n' > "$dev"
                  ''
                  {
                    outputs = [
                      "out"
                      "dev"
                    ];
                  };
              dependencyConsumer = mk "dependency-consumer" ''
                printf '%s\n' '${dependencyMulti}' > "$out"
              '' { };
              # The test publishes reuseMulti only after this input has started
              # building. Its FIFO keeps the consumer's Nix request alive while
              # the dependency waits, without occupying a CPU with a busy loop.
              reuseGate =
                mk "reuse-gate"
                  ''
                    printf 'waiting\n' > "$startedMarker"
                    IFS= read -r released < "$gate"
                    printf 'gate complete\n' > "$out"
                  ''
                  {
                    gate = "FIXTURE_REUSE_GATE";
                    startedMarker = "FIXTURE_REUSE_STARTED";
                  };
              reuseMulti =
                mk "reuse-multi"
                  ''
                    printf 'built\n' >> "$buildMarker"
                    printf 'runtime dependency\n' > "$out"
                    printf 'development dependency\n' > "$dev"
                  ''
                  {
                    dependency = reuseGate;
                    buildMarker = "FIXTURE_REUSE_BUILT";
                    outputs = [
                      "out"
                      "dev"
                    ];
                    allowSubstitutes = true;
                  };
              reuseConsumer = mk "reuse-consumer" ''
                printf '%s\n' '${reuseMulti}' > "$out"
              '' { };
            in
            {
              success = { inherit left right multi; };
              failure = { inherit broken blocked independent; };
              cache = { inherit dependencyConsumer; };
              preparation = { inherit dependencyMulti; };
              reuse = { inherit reuseConsumer; };
              reusePreparation = { inherit reuseGate reuseMulti; };
              uploadFailure = { inherit independent; };
            };
        })
        [
          "aarch64-darwin"
          "x86_64-darwin"
          "aarch64-linux"
          "x86_64-linux"
        ]
    );
  };
}
