{
  description = "nix-ci-build flake";

  inputs.nixpkgs.url = "github:nix-ocaml/nix-overlays";
  inputs.nix-eval-jobs-src.url = "github:nix-community/nix-eval-jobs";

  outputs = { self, nixpkgs, nix-eval-jobs-src }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (system:
        let
          pkgs = nixpkgs.legacyPackages.${system}.extend (self: super: {
            ocamlPackages = super.ocaml-ng.ocamlPackages_5_3;
          });
        in
        f pkgs);
    in
    {
      packages = forAllSystems (pkgs:
        let
          inherit (pkgs) lib system makeWrapper ocamlPackages stdenv;
          nix-eval-jobs = nix-eval-jobs-src.outputs.packages.${system}.default;
          path = lib.makeBinPath [ nix-eval-jobs ];
        in
        {
          default =
            let
              stdenv' =
                if stdenv.isDarwin && !stdenv.isAarch64
                then pkgs.overrideSDK stdenv "11.0"
                else stdenv;
            in
            ocamlPackages.buildDunePackage {
              stdenv = stdenv';
              pname = "nix-ci-build";
              version = "n/a";
              src = let fs = lib.fileset; in fs.toSource {
                root = ./.;
                fileset = fs.unions [
                  ./bin
                  ./lib
                  ./dune-project
                  ./nix-ci-build.opam
                ];
              };
              nativeBuildInputs = [ makeWrapper ];
              buildInputs = [ nix-eval-jobs ];
              propagatedBuildInputs = with ocamlPackages; [
                cmdliner
                eio_main
                logs
                fmt
                ppx_deriving_yojson
              ];
              postInstall = ''
                wrapProgram "$out/bin/nix-ci-build" --prefix PATH : ${path}
              '';
            };
        });
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ self.packages.${pkgs.system}.default ];
          nativeBuildInputs = with pkgs.ocamlPackages; [
            merlin
            ocamlformat
          ];
        };
      });
    };
}
