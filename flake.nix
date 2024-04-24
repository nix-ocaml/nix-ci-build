{
  description = "nix-ci-build flake";

  inputs.nix-filter.url = "github:numtide/nix-filter";
  inputs.flake-utils.url = "github:numtide/flake-utils";
  inputs.nixpkgs = {
    url = "github:nix-ocaml/nix-overlays";
    inputs.flake-utils.follows = "flake-utils";
  };

  outputs =
    { self
    , nixpkgs
    , flake-utils
    , nix-filter
    }:
    flake-utils.lib.eachDefaultSystem
      (system:
      let
        pkgs = nixpkgs.legacyPackages."${system}".extend (self: super: {
          ocamlPackages = super.ocaml-ng.ocamlPackages_5_2;
        });
        inherit (pkgs)
          lib
          makeWrapper
          ocamlPackages
          stdenv;
        path = lib.makeBinPath (with pkgs; [
          nix-eval-jobs
          nix-eval-jobs.nix
        ]);
        # Needed for x86_64-darwin
        buildDunePackage =
          if stdenv.isDarwin && !stdenv.isAarch64
          then
            ocamlPackages.buildDunePackage.override
              { stdenv = pkgs.overrideSDK stdenv "11.0"; }
          else ocamlPackages.buildDunePackage;
        nix-ci-build = buildDunePackage {
          pname = "nix-ci-build";
          version = "n/a";
          src = with nix-filter.lib; filter {
            root = ./.;
            include = [
              "bin"
              "lib"
              "dune-project"
              "nix-ci-build.opam"
            ];
          };
          nativeBuildInputs = [ makeWrapper ];
          buildInputs = [ pkgs.nix-eval-jobs ];
          propagatedBuildInputs = with ocamlPackages; [
            cmdliner
            eio_main
            logs
            fmt
            ppx_yojson_conv
          ];

          postInstall = ''
            wrapProgram "$out/bin/nix-ci-build" \
              --prefix PATH : ${path}
          '';
        };
      in
      {
        packages = {
          default = nix-ci-build;
        };
        devShells = {
          default = pkgs.mkShell {
            inputsFrom = [ nix-ci-build ];
            nativeBuildInputs = with pkgs.ocamlPackages; [
              merlin
              ocamlformat
            ];
          };
        };
      });
}
