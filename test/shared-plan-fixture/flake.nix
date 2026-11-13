{
  description = "Opt-in shared-plan integration fixture; no external inputs";

  outputs =
    { self }:
    let
      # The runner writes these settings into its temporary copy. This fixture
      # deliberately uses the host shell with sandboxing disabled; it must not
      # be used as a production package definition.
      settings = import ./settings.nix;
      mk =
        name: dependencies: extra:
        derivation (
          {
            inherit name;
            system = settings.system;
            builder = "/bin/sh";
            outputs = [ "out" ];
            args = [
              "-eu"
              "-c"
              ''
                for dependency in $dependencies; do
                  test -f "$dependency"
                  read -r value < "$dependency"
                  test "$value" = fixture-built
                done
                printf '%s\n' "$name" >> "$ledger"
                for output in $outputs; do
                  eval "path=\$$output"
                  printf '%s\n' fixture-built > "$path"
                done
              ''
            ];
            ledger = settings.ledger;
            dependencies = map builtins.toString dependencies;
          }
          // extra
        );
      compiler = mk "opaque-shared-tool" [ ] { outputs = [ "out" "dev" ]; };
      nativeBranch = mk "native-private-branch" [ compiler.out ] { };
      crossBranch = mk "cross-private-branch" [ compiler.dev ] { };
      nativeApp = mk "native-consumer" [ nativeBranch ] { };
      crossApp = mk "cross-consumer" [ crossBranch ] { };
    in
    {
      native = {
        app = nativeApp;
        alias = nativeApp;
      };
      cross.app = crossApp;
      noSubstitute.app = mk "non-substitutable-consumer" [ ] {
        allowSubstitutes = false;
      };
    };
}
