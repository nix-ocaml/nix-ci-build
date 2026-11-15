open Cmdliner

let main
      flake
      plan_sets
      execute_plan
      group
      copy_from
      github_output
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
  else if
    List.length
      (List.filter ~f:Option.is_some [ flake; plan_sets; execute_plan ])
    <> 1
  then (
    prerr_endline
      "Choose exactly one of --flake, --plan-sets, or --execute-plan";
    2)
  else if execute_plan <> None <> (group <> None)
  then (
    prerr_endline "--execute-plan and --group must be used together";
    2)
  else if execute_plan <> None && (dry_run || explain <> None)
  then (
    prerr_endline
      "--execute-plan cannot be combined with --dry-run or --explain";
    2)
  else
    let config =
      { Nix_ci_build.Engine.flake = Option.value ~default:"" flake
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
    try
      Eio_main.run (fun env ->
        match plan_sets, execute_plan with
        | Some sets_file, None ->
          Nix_ci_build.Shared_run.plan
            ~sets_file
            ~directory:report_dir
            ~jobs
            ~copy_from
            ~github_output:
              (match github_output with
              | Some _ -> github_output
              | None -> Sys.getenv_opt "GITHUB_OUTPUT")
            env
        | None, Some directory ->
          Nix_ci_build.Shared_run.execute
            ~directory
            ~group_id:(Option.get group)
            ~copy_from
            config
            env
        | _ -> Nix_ci_build.Engine.run config env)
    with
    | exn ->
      let message = Printexc.to_string exn in
      prerr_endline ("Cannot complete build plan: " ^ message);
      (try
         Nix_ci_build.Json.mkdir report_dir;
         Nix_ci_build.Json.atomic_write
           (Filename.concat report_dir "execution-error.json")
           (`Assoc
               [ ( "group"
                 , match group with Some id -> `String id | None -> `Null )
               ; "error", `String message
               ]);
         Option.iter
           (fun id ->
              Nix_ci_build.Json.atomic_write
                (Filename.concat report_dir "execution.json")
                (`Assoc
                    [ "version", `Int 1
                    ; "group", `String id
                    ; "status", `String "failed"
                    ; "error", `String message
                    ]);
              let append path =
                let channel =
                  open_out_gen
                    [ Open_wronly; Open_creat; Open_append ]
                    0o600
                    path
                in
                Fun.protect
                  ~finally:(fun () -> close_out_noerr channel)
                  (fun () ->
                     Printf.fprintf
                       channel
                       "\n\
                        **Execution group failed:** `%s`\n\n\
                        ```text\n\
                        %s\n\
                        ```\n"
                       id
                       message)
              in
              append (Filename.concat report_dir "summary.md");
              Option.iter
                append
                (match output with
                | Some _ -> output
                | None -> Sys.getenv_opt "GITHUB_STEP_SUMMARY"))
           group
       with
      | _ -> ());
      1

let command =
  let flake =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "f"; "flake" ]
          ~docv:"FLAKE#ATTR"
          ~doc:"Package set to evaluate and build.")
  in
  let plan_sets =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "plan-sets" ]
          ~docv:"JSON"
          ~doc:
            "Evaluate named package sets together and export a portable \
             shared-dependency plan to --report-dir.")
  in
  let execute_plan =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "execute-plan" ]
          ~docv:"DIR"
          ~doc:
            "Execute one owned group from a saved plan and derivation bundle; \
             requires --group and --copy-to.")
  in
  let group =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "group" ]
          ~docv:"ID"
          ~doc:"Group from the execution plan to build.")
  in
  let copy_from =
    Arg.(
      value
      & opt_all string []
      & info
          [ "copy-from" ]
          ~docv:"URL"
          ~doc:
            "Shared cache to query/import; repeat for multiple caches. \
             Defaults to configured substituters.")
  in
  let github_output =
    Arg.(
      value
      & opt (some string) None
      & info
          [ "github-output" ]
          ~docv:"FILE"
          ~doc:
            "Append dynamic matrix outputs to FILE; defaults to GITHUB_OUTPUT \
             when planning sets.")
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
      $ plan_sets
      $ execute_plan
      $ group
      $ copy_from
      $ github_output
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
