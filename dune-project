(lang dune 3.13)

(name nix-ci-build)

(generate_opam_files true)

(source
 (github nix-ocaml/nix-ci-build))

(authors "Antonio Nuno Monteiro <anmonteiro@gmail.com>")

(maintainers "Antonio Nuno Monteiro <anmonteiro@gmail.com>")

(homepage "https://github.com/nix-ocaml/nix-ci-build")

(license "BSD-3-clause")

(package
 (name nix-ci-build)
 (synopsis "Build and report Nix package sets in CI")
 (description "Dependency-aware scheduling, durable build reports, and cache uploads for Nix package sets.")
 (depends
  (ocaml
   (>= "5.1"))
  cmdliner
  yojson
  fmt
  logs
  eio_main))
