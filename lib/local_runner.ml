(* A second execution adapter. Each group still uses the same verified worker
   protocol; the local scheduler only controls readiness and process
   capacity. *)
type status =
  | Pending
  | Running
  | Succeeded
  | Failed of string
  | Blocked of string list

exception Cancelled

let status_name = function
  | Pending -> "queued"
  | Running -> "running"
  | Succeeded -> "success"
  | Failed _ -> "failed"
  | Blocked _ -> "blocked"

let dispatch ~workers ~groups ~execute ~on_state =
  if workers < 1 then invalid_arg "workers must be positive";
  let states = Hashtbl.create (List.length groups) in
  let by_id = Hashtbl.create (List.length groups) in
  List.iter groups ~f:(fun (group : Shared_plan.group) ->
    if Hashtbl.mem by_id group.id then failwith ("Duplicate group " ^ group.id);
    Hashtbl.add by_id group.id group;
    Hashtbl.add states group.id Pending);
  let visited = Hashtbl.create (List.length groups) in
  let rec visit active id =
    if List.mem id ~set:active then failwith ("Group dependency cycle at " ^ id);
    if not (Hashtbl.mem visited id)
    then (
      let group =
        match Hashtbl.find_opt by_id id with
        | Some group -> group
        | None -> failwith ("Unknown prerequisite group " ^ id)
      in
      List.iter group.needs ~f:(visit (id :: active));
      Hashtbl.add visited id ())
  in
  List.iter groups ~f:(fun (group : Shared_plan.group) -> visit [] group.id);
  let set id status =
    Hashtbl.replace states id status;
    on_state id status
  in
  List.iter groups ~f:(fun (group : Shared_plan.group) ->
    on_state group.id Pending);
  Eio.Switch.run (fun sw ->
    let finished = Eio.Stream.create workers in
    let running = ref 0 in
    let rec block_dependents () =
      let changed = ref false in
      List.iter groups ~f:(fun (group : Shared_plan.group) ->
        if Hashtbl.find states group.id = Pending
        then
          let failed =
            List.filter group.needs ~f:(fun id ->
              match Hashtbl.find states id with
              | Failed _ | Blocked _ -> true
              | _ -> false)
          in
          if failed <> []
          then (
            changed := true;
            set group.id (Blocked failed)));
      if !changed then block_dependents ()
    in
    let rec loop () =
      block_dependents ();
      List.iter groups ~f:(fun (group : Shared_plan.group) ->
        if
          !running < workers
          && Hashtbl.find states group.id = Pending
          && List.for_all group.needs ~f:(fun id ->
            Hashtbl.find states id = Succeeded)
        then (
          incr running;
          set group.id Running;
          Eio.Fiber.fork ~sw (fun () ->
            let result =
              try execute group with
              | Eio.Cancel.Cancelled _ as exn -> raise exn
              | exn -> Error (Printexc.to_string exn)
            in
            Eio.Stream.add finished (group.id, result))));
      if !running > 0
      then (
        let id, result = Eio.Stream.take finished in
        decr running;
        set
          id
          (match result with Ok () -> Succeeded | Error error -> Failed error);
        loop ())
      else if Hashtbl.to_seq_values states |> Seq.exists (( = ) Pending)
      then failwith "No runnable group remains in the dependency plan"
    in
    loop ());
  List.map groups ~f:(fun (group : Shared_plan.group) ->
    group.id, Hashtbl.find states group.id)

let load directory =
  let unwrap = function Ok value -> value | Error error -> failwith error in
  let manifest = Json.read (Filename.concat directory "execution-plan.json") in
  if Json.member "version" manifest <> `Int 1
  then failwith "Unsupported execution plan version";
  let graph = unwrap (Plan.of_yojson (Json.member "graph" manifest)) in
  let saved = unwrap (Shared_plan.of_yojson (Json.member "plan" manifest)) in
  let cached = Hashtbl.create 1024 in
  List.iter
    (Json.strings (Json.member "cachedPaths" manifest))
    ~f:(fun path -> Hashtbl.replace cached path ());
  let plan =
    unwrap
      (Shared_plan.create
         graph
         ~requests:saved.requests
         ~availability:(fun path ->
           if Hashtbl.mem cached path
           then
             Plan.Cached
               { download_size = None; nar_size = None; references = [] }
           else Plan.Missing))
  in
  if Shared_plan.to_yojson saved <> Shared_plan.to_yojson plan
  then
    failwith "Execution plan does not match its dependency graph and ownership";
  manifest, plan

let supported_systems process_mgr =
  let read name =
    let result =
      Backend.run process_mgr (Backend.nix [ "config"; "show"; name ])
    in
    if not (Backend.successful result)
    then
      failwith
        ("Cannot read local executor capabilities: " ^ Backend.error result);
    String.split_on_char ~sep:' ' (String.trim result.stdout)
    |> List.filter ~f:(fun value -> value <> "")
  in
  read "system" @ read "extra-platforms"

let run ~directory ~workers ~copy_from (config : Engine.config) env =
  let destination =
    match config.copy_to with
    | Some value -> value
    | None ->
      failwith "--run-plan requires --copy-to so completed work is published"
  in
  let directory =
    if Filename.is_relative directory
    then Filename.concat (Sys.getcwd ()) directory
    else directory
  in
  let manifest, plan = load directory in
  let process_mgr = Eio.Stdenv.process_mgr env in
  (if plan.groups <> []
   then
     let systems = supported_systems process_mgr in
     List.iter plan.groups ~f:(fun (group : Shared_plan.group) ->
       if not (List.mem group.system ~set:systems)
       then
         failwith
           ("Local executor does not support "
           ^ group.system
           ^ " (group "
           ^ group.id
           ^ ")")));
  Json.mkdir config.report_dir;
  let previous_error =
    Filename.concat config.report_dir "execution-error.json"
  in
  if Sys.file_exists previous_error then Sys.remove previous_error;
  let plan_id = Shared_trace.plan_id manifest in
  let run_id = Shared_trace.fresh_id "local" in
  let worker_id = "local:" ^ Unix.gethostname () in
  let run_dir =
    Filename.concat (Filename.concat config.report_dir "runs") run_id
  in
  Json.mkdir run_dir;
  let channel =
    open_out_gen
      [ Open_wronly; Open_creat; Open_append; Open_binary ]
      0o600
      (Filename.concat config.report_dir "scheduler-events.jsonl")
  in
  let clock = Eio.Stdenv.mono_clock env in
  let started = Eio.Time.Mono.now clock in
  let elapsed () =
    Mtime.Span.to_float_ns (Mtime.span started (Eio.Time.Mono.now clock)) /. 1e9
  in
  let sequence = ref 0 in
  let emit ?group_id ?attempt_id kind fields =
    incr sequence;
    let event =
      `Assoc
        ([ "version", `Int 1
         ; "planId", `String plan_id
         ; "runId", `String run_id
         ; "groupId", Json.optional Json.str group_id
         ; "attemptId", Json.optional Json.str attempt_id
         ; "workerId", `String worker_id
         ; "sequence", `Int !sequence
         ; "time", `Float (Unix.gettimeofday ())
         ; "elapsed", `Float (elapsed ())
         ; "type", `String kind
         ]
        @ fields)
    in
    Yojson.Safe.to_channel channel event;
    output_char channel '\n';
    flush channel
  in
  let attempts = Hashtbl.create (List.length plan.groups) in
  let statuses = Hashtbl.create (List.length plan.groups) in
  let checkpoint status =
    Json.atomic_write
      (Filename.concat run_dir "run-state.json")
      (`Assoc
          [ "version", `Int 1
          ; "planId", `String plan_id
          ; "runId", `String run_id
          ; "status", `String status
          ; "elapsed", `Float (elapsed ())
          ; ( "groups"
            , `Assoc
                (Hashtbl.to_seq statuses
                |> List.of_seq
                |> List.sort ~cmp:(fun (a, _) (b, _) -> String.compare a b)) )
          ])
  in
  let interrupted = ref false in
  let handler = Sys.Signal_handle (fun _ -> interrupted := true) in
  let int_handler = Sys.signal Sys.sigint handler
  and term_handler = Sys.signal Sys.sigterm handler in
  Fun.protect
    ~finally:(fun () ->
      Sys.set_signal Sys.sigint int_handler;
      Sys.set_signal Sys.sigterm term_handler;
      close_out_noerr channel)
    (fun () ->
       emit
         "run_start"
         [ "groups", `Int (List.length plan.groups); "workers", `Int workers ];
       try
         let execute_groups () =
           dispatch
             ~workers
             ~groups:plan.groups
             ~on_state:(fun id state ->
               let attempt_id =
                 if state = Running
                 then (
                   let attempt = Shared_trace.fresh_id "attempt" in
                   Hashtbl.add attempts id attempt;
                   Some attempt)
                 else Hashtbl.find_opt attempts id
               in
               let kind, extra =
                 match state with
                 | Pending -> "queued", []
                 | Running -> "dispatched", []
                 | Succeeded -> "completed", [ "exitCode", `Int 0 ]
                 | Failed error -> "completed", [ "error", `String error ]
                 | Blocked needs -> "blocked", [ "blockedBy", Json.strs needs ]
               in
               let fields = ("status", `String (status_name state)) :: extra in
               Hashtbl.replace statuses id (`Assoc fields);
               emit ~group_id:id ?attempt_id kind fields;
               checkpoint "running";
               Printf.printf
                 "%s %s\n%!"
                 (String.uppercase_ascii (status_name state))
                 id)
             ~execute:(fun (group : Shared_plan.group) ->
               let attempt = Hashtbl.find attempts group.id in
               let report_dir =
                 Filename.concat (Filename.concat run_dir group.id) attempt
               in
               Json.mkdir report_dir;
               let optional flag = function
                 | None -> []
                 | Some value -> [ flag; value ]
               in
               let command =
                 [ "env"
                 ; "-u"
                 ; "GITHUB_OUTPUT"
                 ; "-u"
                 ; "GITHUB_STEP_SUMMARY"
                 ; "NIX_CI_BUILD_RUN_ID=" ^ run_id
                 ; "NIX_CI_BUILD_ATTEMPT_ID=" ^ attempt
                 ; "NIX_CI_BUILD_WORKER_ID=" ^ worker_id
                 ; Sys.executable_name
                 ; "--execute-plan"
                 ; directory
                 ; "--group"
                 ; group.id
                 ; "--copy-to"
                 ; destination
                 ; "--report-dir"
                 ; report_dir
                 ; "--jobs"
                 ; string_of_int config.jobs
                 ; "--batch-size"
                 ; string_of_int config.batch_size
                 ; "--retries"
                 ; string_of_int config.retries
                 ; "--heartbeat"
                 ; string_of_float config.heartbeat
                 ; "--cache-refresh"
                 ; string_of_float config.cache_refresh
                 ]
                 @ List.concat_map copy_from ~f:(fun source ->
                   [ "--copy-from"; source ])
                 @ optional "--history" config.history
                 @ if config.verbose then [ "--verbose" ] else []
               in
               let result =
                 Backend.run
                   process_mgr
                   ~cancel_grace:(clock, 10.)
                   ~capture:false
                   ~log_path:(Filename.concat report_dir "worker.log")
                   command
               in
               if Backend.successful result
               then Ok ()
               else Error (Backend.error result))
         in
         let states =
           Eio.Fiber.first execute_groups (fun () ->
             let rec monitor () =
               if !interrupted then raise Cancelled;
               Eio.Time.Mono.sleep clock 0.1;
               monitor ()
             in
             monitor ())
         in
         let success =
           List.for_all states ~f:(fun (_, state) -> state = Succeeded)
         in
         let status = if success then "success" else "failed" in
         emit
           "run_finish"
           [ "status", `String status; "durationSeconds", `Float (elapsed ()) ];
         checkpoint status;
         if success then 0 else 1
       with
       | exn ->
         let status =
           match exn with
           | Eio.Cancel.Cancelled _ | Cancelled -> "cancelled"
           | _ -> "failed"
         in
         emit
           "run_finish"
           [ "status", `String status
           ; "error", `String (Printexc.to_string exn)
           ];
         checkpoint status;
         raise exn)
