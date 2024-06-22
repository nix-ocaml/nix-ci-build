{
  description = "nix-ci-build flake";

  inputs.nix-filter.url = "github:numtide/nix-filter";
  inputs.flake-utils.url = "github:numtide/flake-utils";
  inputs.nixpkgs = {
    url = "github:nix-ocaml/nix-overlays";
    inputs.flake-utils.follows = "flake-utils";
  };
  inputs.nix-eval-jobs-src.url = "github:nix-community/nix-eval-jobs?rev=d0b436132958c3e272df9f08e0cbe75e86527582";

  outputs = { self, nixpkgs, flake-utils, nix-filter, nix-eval-jobs-src }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = nixpkgs.legacyPackages."${system}".extend (self: super: {
            ocamlPackages = super.ocaml-ng.ocamlPackages_5_2;
          });
          inherit (pkgs) lib makeWrapper ocamlPackages stdenv;
          nix-eval-jobs = nix-eval-jobs-src.outputs.packages."${system}".default;
          path = lib.makeBinPath [ nix-eval-jobs ];
          # Needed for x86_64-darwin
          buildDunePackage =
            if stdenv.isDarwin && !stdenv.isAarch64 then
              ocamlPackages.buildDunePackage.override
                { stdenv = pkgs.overrideSDK stdenv "11.0"; }
            else
              ocamlPackages.buildDunePackage;
        in
        {
          packages = {
            default = buildDunePackage {
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
              buildInputs = [ nix-eval-jobs ];
              propagatedBuildInputs = with ocamlPackages; [
                cmdliner
                eio_main
                logs
                fmt
                ppx_yojson_conv
              ];
              postInstall = ''
                wrapProgram "$out/bin/nix-ci-build" --prefix PATH : ${path}
              '';
            };
          };
          devShells = {
            default = pkgs.mkShell {
              inputsFrom = [ self.packages.${system}.default ];
              nativeBuildInputs = with pkgs.ocamlPackages; [
                merlin
                ocamlformat
              ];
            };
          };
        });
}
