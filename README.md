# nix-ci-build

`nix-ci-build` is a different take on
[nix-fast-build](https://github.com/Mic92/nix-fast-build) designed specifically
for the CI in
[nix-ocaml/nix-overlays](https://github.com/nix-ocaml/nix-overlays).

It's currently WIP and unreleased. It doesn't support building on remote
machines, and support for it is not currently planned.

### Features / TODO

- [x] nix-eval-jobs + run `nix-build` concurrently while evaluation hasn't
  finished
- [ ] `nix copy` support, upload to a distributed cache while building
- [ ] nix-output-monitor
- [ ]
- [ ]
- [ ]

## License & Copyright

Copyright (c) 2024 António Nuno Monteiro

nix-ci-build is distributed under the 3-Clause BSD License, see [LICENSE](./LICENSE).

