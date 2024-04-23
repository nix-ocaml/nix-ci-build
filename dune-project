(lang dune 3.13)

(name nix-ci-build)

(generate_opam_files true)

(source
 (github nix-ocaml/nix-ci-build))

(authors "Antonio Nuno Monteiro <anmonteiro@gmail.com>")

(maintainers "Antonio Nuno Monteiro <anmonteiro@gmail.com>")

(homepage "https://github.com/nix-ci-build/piaf")

; (bug_reports "https://github.com/anmonteiro/piaf/issues")

(license "BSD-3-clause")

(package
 (name nix-ci-build)
 (synopsis "TODO")
 (description "TODO")
 (depends
  (ocaml
   (>= "5.1"))
  logs
  eio_main))
