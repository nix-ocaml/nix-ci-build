open Cmdliner

let main
      flake
      jobs
      copy_to
      output
      report_dir
      dry_run
      explain
      compare
      history
      heartbeat
      cache_refresh
      batch_size
      retries
      verbose
  =
  if
    jobs < 1
    || batch_size < 1
    || retries < 0
    || heartbeat <= 0.
    || (not (Float.is_finite heartbeat))
    || cache_refresh < 0.
    || not (Float.is_finite cache_refresh)
  then (
    prerr_endline
      "jobs, batch-size and heartbeat must be positive; retries must be \
       nonnegative; cache-refresh must be finite and nonnegative";
    2)
  else
    let config =
      { Nix_ci_build.Engine.flake
      ; jobs
      ; copy_to
      ; output
      ; report_dir
      ; dry_run
      ; explain
      ; compare
      ; history
      ; heartbeat
      ; cache_refresh
      ; batch_size
      ; retries
      ; verbose
      }
    in
    Eio_main.run (Nix_ci_build.Engine.run config)

let command =
  let flake =
    Arg.(
      required
      & opt (some string) None
      & info
          [ "f"; "flake" ]
          ~docv:"FLAKE#ATTR"
          ~doc:"Package set to evaluate and build.")
  in
  let jobs =
    Arg.(
      value
      & opt int (Domain.recommended_domain_count ())
      & info
          [ "j"; "jobs" ]
          ~doc:
            "Evaluation workers; admits up to twice this many Nix build \
             requests.")
  in
  let copy_to =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "copy-to" ]
          ~docv:"URL"
          ~doc:
            "Copy realized outputs, including build dependencies, to this \
             store.")
  in
  let output =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "o"; "output" ]
          ~docv:"FILE"
          ~doc:
            "Write a Markdown summary to FILE; defaults to GITHUB_STEP_SUMMARY \
             in Actions. A summary is always saved in the report directory.")
  in
  let report_dir =
    Arg.(
      value
      & opt string "nix-ci-build-report"
      & info
          [ "report-dir" ]
          ~docv:"DIR"
          ~doc:"Directory for durable plans, results, events and full logs.")
  in
  let dry_run =
    Arg.(
      value
      & flag
      & info
          [ "dry-run" ]
          ~doc:"Evaluate and report the plan without building or uploading.")
  in
  let explain =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "explain" ]
          ~docv:"ATTR"
          ~doc:"Explain missing dependencies for an attribute; implies dry-run.")
  in
  let compare =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "compare" ]
          ~docv:"JSON"
          ~doc:"Compare the plan with an earlier plan.json or results.json.")
  in
  let history =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "history" ]
          ~docv:"JSON"
          ~doc:
            "Use earlier results.json timings to prioritize the critical path.")
  in
  let heartbeat =
    Arg.(
      value
      & opt float 30.
      & info
          [ "heartbeat" ]
          ~docv:"SECONDS"
          ~doc:"Interval for aggregate live progress and report checkpoints.")
  in
  let batch_size =
    Arg.(
      value
      & opt int 1
      & info
          [ "batch-size" ]
          ~docv:"N"
          ~doc:"Submit up to N related roots together; defaults to one.")
  in
  let cache_refresh =
    Arg.(
      value
      & opt float 30.
      & info
          [ "cache-refresh" ]
          ~docv:"SECONDS"
          ~doc:
            "Refresh missing dependencies in configured caches while building; \
             defaults to 30 seconds, or 0 to disable opportunistic imports.")
  in
  let retries =
    Arg.(
      value
      & opt int 2
      & info
          [ "retries" ]
          ~docv:"N"
          ~doc:
            "Maximum retries for recognized transient download/upload errors.")
  in
  let verbose =
    Arg.(
      value
      & flag
      & info
          [ "v"; "verbose" ]
          ~doc:
            "Show detailed lifecycle events in the console. Full logs and \
             structured events are always saved in the report directory.")
  in
  Cmd.v
    (Cmd.info
       "nix-ci-build"
       ~doc:"Plan, build and report Nix package sets in CI")
    Term.(
      const main
      $ flake
      $ jobs
      $ copy_to
      $ output
      $ report_dir
      $ dry_run
      $ explain
      $ compare
      $ history
      $ heartbeat
      $ cache_refresh
      $ batch_size
      $ retries
      $ verbose)

let () = exit (Cmd.eval' command)
