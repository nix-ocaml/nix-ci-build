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
            in
            {
              success = { inherit left right multi; };
              failure = { inherit broken blocked independent; };
              cache = { inherit dependencyConsumer; };
              preparation = { inherit dependencyMulti; };
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
