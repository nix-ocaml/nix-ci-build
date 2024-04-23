{
  description = "nix-ci-build flake";

  inputs.nix-filter.url = "github:numtide/nix-filter";
  inputs.flake-utils.url = "github:numtide/flake-utils";
  inputs.nixpkgs-for-eval-jobs.url = "github:nixOS/nixpkgs?rev=c082856b850ec60cda9f0a0db2bc7bd8900d708c";
  inputs.nixpkgs = {
    url = "github:nix-ocaml/nix-overlays";
    inputs.flake-utils.follows = "flake-utils";
  };

  outputs =
    { self
    , nixpkgs
    , nixpkgs-for-eval-jobs
    , flake-utils
    , nix-filter
    }:
    flake-utils.lib.eachDefaultSystem (system:
    let
      pkgs = nixpkgs.legacyPackages."${system}".extend (self: super: {
        ocamlPackages = super.ocaml-ng.ocamlPackages_5_1;
        nix-eval-jobs =
          nixpkgs-for-eval-jobs.legacyPackages."${system}".nix-eval-jobs;
      });
    in
    {
      packages = {
        default =
          let
            path = pkgs.lib.makeBinPath (with pkgs; [
              nix-eval-jobs
              nix-eval-jobs.nix
            ]);
          in
          with pkgs.ocamlPackages; buildDunePackage {
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

            propagatedBuildInputs = [
              cmdliner
              eio_main
              logs
              fmt
              ppx_yojson_conv
            ];
          };
      };
    });
}
