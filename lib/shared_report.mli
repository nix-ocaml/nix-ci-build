val render : directory:string -> reports:string -> output:string -> unit
(** Combine a portable shared dependency plan and saved worker reports.

    The output is a self-contained [index.html], an auditable [aggregate.json],
    and a compact [summary.md]. No Nix process or network access is needed.
    Report discovery is bounded and does not follow symlinks. Missing evidence,
    failed attempts, and retries remain explicit; engine success alone does not
    establish that the worker published its outputs. *)
