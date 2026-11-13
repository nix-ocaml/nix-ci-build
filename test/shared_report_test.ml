module Report = Nix_ci_build.Shared_report
module Plan = Nix_ci_build.Plan
module Shared = Nix_ci_build.Shared_plan
module Trace = Nix_ci_build.Shared_trace
module Json = Nix_ci_build.Json

let check condition message = if not condition then failwith message
let unwrap = function Ok value -> value | Error message -> failwith message
let obj fields = `Assoc fields
let strings values = Json.strs values
let get = Json.member
let text key json = Json.string (get key json)
let items key json = Json.list (get key json)

let write path json =
  Json.mkdir (Filename.dirname path);
  Json.atomic_write path json

let write_text path contents =
  Json.mkdir (Filename.dirname path);
  let channel = open_out_bin path in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () -> output_string channel contents)

let read path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> really_input_string channel (in_channel_length channel))

let rec remove path =
  if (Unix.lstat path).st_kind = Unix.S_DIR
  then (
    Array.iter (Sys.readdir path) ~f:(fun name ->
      remove (Filename.concat path name));
    Unix.rmdir path)
  else Unix.unlink path

let temporary f =
  let path = Filename.temp_file "shared-report-test-" "" in
  Unix.unlink path;
  Unix.mkdir path 0o700;
  Fun.protect ~finally:(fun () -> remove path) (fun () -> f path)

let drv name = "/nix/store/" ^ name ^ ".drv"
let edge name : Plan.edge = { drv_path = drv name; outputs = [ "out" ] }

let node name inputs : Plan.node =
  { drv_path = drv name
  ; name
  ; system = "x86_64-linux"
  ; allow_substitutes = true
  ; inputs = List.map inputs ~f:edge
  ; outputs = [ "out", Some ("/nix/store/" ^ name) ]
  }

let fixture ?(consumer = "native") directory =
  let nodes =
    [ node "compiler" []
    ; node "native" [ "compiler" ]
    ; node "cross" [ "compiler" ]
    ]
  in
  let graph = Plan.of_nodes nodes in
  let requests : Shared.request list =
    [ { id = consumer; roots = [ edge "native" ] }
    ; { id = "cross"; roots = [ edge "cross" ] }
    ]
  in
  let plan =
    unwrap (Shared.create graph ~requests ~availability:(fun _ -> Plan.Missing))
  in
  let graph_json =
    obj
      (List.map nodes ~f:(fun node ->
         ( node.Plan.drv_path
         , obj
             [ "name", `String node.name
             ; "system", `String node.system
             ; ( "outputs"
               , obj
                   (List.map node.outputs ~f:(fun (name, value) ->
                      name, Json.optional Json.str value)) )
             ; ( "inputDrvs"
               , obj
                   (List.map node.inputs ~f:(fun (edge : Plan.edge) ->
                      edge.Plan.drv_path, strings edge.outputs)) )
             ] )))
  in
  let manifest =
    obj
      [ "version", `Int 1
      ; "graph", graph_json
      ; "plan", Shared.to_yojson plan
      ; "cachedPaths", `List []
      ]
  in
  write (directory ^ "/plan/execution-plan.json") manifest;
  let group name =
    List.find plan.groups ~f:(fun group ->
      List.mem (drv name) ~set:group.Shared.members)
  in
  plan, Trace.plan_id manifest, group

let execution ~plan_id ~run ~attempt ~group ~start status =
  obj
    [ "version", `Int 1
    ; "planId", `String plan_id
    ; "runId", `String run
    ; "attemptId", `String attempt
    ; "groupId", `String group
    ; "startedAt", `Float start
    ; "finishedAt", `Float (start +. 8.)
    ; "status", `String status
    ; "imported", strings [ "/nix/store/compiler" ]
    ; "published", strings [ "/nix/store/output" ]
    ]

let worker directory ~plan_id ~run ~attempt (group : Shared.group) ~start status
  =
  let path = directory ^ "/reports/" ^ attempt in
  write
    (path ^ "/execution.json")
    (execution ~plan_id ~run ~attempt ~group:group.id ~start status);
  path

let event ~plan_id ~run ~attempt ~group ~time kind fields =
  obj
    ([ "version", `Int 1
     ; "planId", `String plan_id
     ; "runId", `String run
     ; "attemptId", `String attempt
     ; "groupId", `String group
     ; "time", `Float time
     ; "type", `String kind
     ]
    @ fields)

let events path values =
  write_text
    path
    (String.concat ~sep:"\n" (List.map values ~f:Yojson.Safe.to_string) ^ "\n")

let render directory =
  Report.render
    ~directory:(directory ^ "/plan")
    ~reports:(directory ^ "/reports")
    ~output:(directory ^ "/aggregate");
  Json.read (directory ^ "/aggregate/aggregate.json")

let group_json report group =
  List.find (items "groups" report) ~f:(fun value ->
    text "id" value = group.Shared.id)

let seed directory plan_id (plan : Shared.t) =
  List.iteri plan.groups ~f:(fun i group ->
    ignore
      (worker
         directory
         ~plan_id
         ~run:"run-one"
         ~attempt:("attempt-" ^ string_of_int i)
         group
         ~start:(100. +. (float_of_int i *. 10.))
         "success"))

let test_complete_and_missing () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    seed directory plan_id plan;
    let report = render directory in
    check
      (text "status" report = "success")
      "all verified worker results should succeed";
    check
      (Json.number (get "success" (get "counts" report)) = 3.)
      "three groups should succeed";
    let native = group "native" in
    let report_dir =
      List.find (items "groups" report) ~f:(fun value ->
        text "id" value = native.id)
      |> items "attempts"
      |> List.hd
      |> text "source"
    in
    Sys.remove (directory ^ "/reports/" ^ report_dir ^ "/execution.json");
    write
      (directory ^ "/reports/" ^ report_dir ^ "/results.json")
      (obj
         [ "status", `String "success"
         ; ( "context"
           , obj
               [ "runId", `String "run-one"
               ; "attemptId", `String report_dir
               ; "groupId", `String native.id
               ; "startedAt", `Float 115.
               ] )
         ]);
    let report = render directory in
    check
      (text "status" report = "incomplete")
      "engine success alone must not imply publication";
    check
      (text "status" (group_json report native) = "incomplete")
      "unfinished worker stays incomplete";
    remove (directory ^ "/reports/" ^ report_dir);
    let report = render directory in
    check
      (text "status" (group_json report native) = "missing")
      "absent worker must remain missing")

let test_failure_and_retry () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    seed directory plan_id plan;
    let native = group "native" in
    let path =
      worker
        directory
        ~plan_id
        ~run:"run-one"
        ~attempt:"retry-failed"
        native
        ~start:200.
        "failed"
    in
    write (path ^ "/results.json") (obj [ "status", `String "success" ]);
    let report = render directory in
    check
      (text "status" report = "failed")
      "later publication failure overrides earlier success";
    ignore
      (worker
         directory
         ~plan_id
         ~run:"run-one"
         ~attempt:"retry-success"
         native
         ~start:300.
         "success");
    events
      (directory ^ "/reports/scheduler-events.jsonl")
      [ event
          ~plan_id
          ~run:"run-one"
          ~attempt:"retry-failed"
          ~group:native.id
          ~time:208.
          "completed"
          [ "status", `String "failed" ]
      ];
    let report = render directory in
    check
      (text "status" report = "success")
      "successful retry can complete the group without inheriting older \
       scheduler failure";
    check
      (List.length (items "attempts" (group_json report native)) = 3)
      "failed attempt must remain inspectable")

let test_same_directory_retries () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    seed directory plan_id plan;
    let native = group "native" in
    let path =
      worker
        directory
        ~plan_id
        ~run:"run-one"
        ~attempt:"retry-new"
        native
        ~start:300.
        "success"
    in
    let event attempt time kind status =
      event
        ~plan_id
        ~run:"run-one"
        ~attempt
        ~group:native.id
        ~time
        kind
        (if status = "" then [] else [ "status", `String status ])
    in
    events
      (path ^ "/execution-events.jsonl")
      [ event "retry-old" 200. "attempt_start" ""
      ; event "retry-old" 208. "attempt_finish" "failed"
      ; event "retry-new" 300. "attempt_start" ""
      ; event "retry-new" 308. "attempt_finish" "success"
      ];
    let report = render directory in
    check
      (text "status" report = "success")
      "old terminal failure must not poison new attempt in append-only stream";
    let attempts = items "attempts" (group_json report native) in
    check
      (List.length attempts = 3)
      "append-only event file must retain separate attempts";
    check
      (List.exists attempts ~f:(fun attempt ->
         text "attemptId" attempt = "retry-old"
         && text "status" attempt = "failed"))
      "old failed attempt must remain explicit")

let test_current_run_isolation () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    seed directory plan_id plan;
    ignore
      (worker
         directory
         ~plan_id
         ~run:"run-two"
         ~attempt:"new-run-shared"
         (group "compiler")
         ~start:400.
         "success");
    let report = render directory in
    check (text "activeRunId" report = "run-two") "newer run should be selected";
    check
      (text "status" (group_json report (group "native")) = "missing")
      "old run success must not fill new run evidence";
    check
      (text "status" report = "incomplete")
      "partial newer run must remain incomplete";
    ignore
      (worker
         directory
         ~plan_id:"unrelated-plan"
         ~run:"wrong"
         ~attempt:"wrong-plan"
         (group "native")
         ~start:1000.
         "success");
    let report = render directory in
    check
      (text "activeRunId" report = "run-two")
      "different plan must not become active";
    check
      (items "diagnostics" report <> [])
      "ignored unrelated report should be visible")

let test_phases_and_scheduler () =
  temporary (fun directory ->
    let _, plan_id, group = fixture directory in
    let shared = group "compiler"
    and native = group "native" in
    let path =
      worker
        directory
        ~plan_id
        ~run:"run-one"
        ~attempt:"worker"
        shared
        ~start:100.
        "success"
    in
    let event time kind fields =
      event
        ~plan_id
        ~run:"run-one"
        ~attempt:"worker"
        ~group:shared.id
        ~time
        kind
        fields
    in
    events
      (path ^ "/execution-events.jsonl")
      [ event 100. "attempt_start" []
      ; event
          101.
          "phase_start"
          [ "phase", `String "import_prerequisites"; "elapsed", `Float 1. ]
      ; event
          50.
          "phase_finish"
          [ "phase", `String "import_prerequisites"
          ; "elapsed", `Float 5.
          ; "durationSeconds", `Float 4.
          ; "status", `String "success"
          ]
      ];
    events
      (directory ^ "/reports/scheduler-events.jsonl")
      [ obj
          [ "planId", `String plan_id
          ; "runId", `String "run-one"
          ; "time", `Float 100.
          ; "type", `String "run_start"
          ]
      ; obj
          [ "planId", `String plan_id
          ; "runId", `String "run-one"
          ; "groupId", `String native.id
          ; "time", `Float 120.
          ; "type", `String "blocked"
          ; "status", `String "blocked"
          ; "blockedBy", strings [ shared.id ]
          ]
      ];
    let report = render directory in
    let attempt = group_json report shared |> items "attempts" |> List.hd in
    let phase = items "phases" attempt |> List.hd in
    check
      (get "durationSeconds" phase = `Float 4.)
      "phase duration must use monotonic measurement";
    check
      (get "finishedAt" phase = `Float 105.)
      "wall-clock adjustments must not make negative timeline phases";
    check
      (text "status" (group_json report native) = "blocked")
      "scheduler-blocked group should explain missing worker";
    check
      (get "blockedBy" (get "scheduled" (group_json report native))
      = strings [ shared.id ])
      "blocker identity must survive aggregation")

let test_evidence_safety () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    seed directory plan_id plan;
    let native = group "native" in
    let path =
      worker
        directory
        ~plan_id
        ~run:"run-one"
        ~attempt:"corrupted"
        native
        ~start:400.
        "success"
    in
    write_text (path ^ "/execution-events.jsonl") "{truncated event\n";
    Unix.symlink
      (directory ^ "/reports")
      (directory ^ "/reports/recursive-symlink");
    let report = render directory in
    check
      (text "status" (group_json report native) = "incomplete")
      "corrupt evidence must not produce false success";
    check (items "diagnostics" report <> []) "corrupt event should be reported";
    check
      (Json.number (get "attempts" (get "counts" report)) = 4.)
      "symlink recursion must not duplicate attempts")

let test_xss () =
  temporary (fun directory ->
    let attack =
      "</script><script>window.injected=true</script> | <img src=x \
       onerror=alert(1)>"
    in
    let plan, plan_id, _ = fixture ~consumer:attack directory in
    seed directory plan_id plan;
    ignore (render directory);
    let html = read (directory ^ "/aggregate/index.html") in
    check
      (not (Json.contains ~sub:attack html))
      "inert JSON must not allow closing script element";
    check
      (Json.contains ~sub:"\\u003c/script\\u003e" html)
      "escaped attack must remain inspectable as text";
    check
      (not (Json.contains ~sub:"innerHTML" html))
      "dynamic UI must use safe DOM text operations";
    check
      (not (Json.contains ~sub:"fetch(" html))
      "standalone report must work without network access";
    let summary = read (directory ^ "/aggregate/summary.md") in
    check
      (not (Json.contains ~sub:"<img src=x" summary))
      "markdown summary must escape arbitrary labels")

let test_duplicate_attempts () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    seed directory plan_id plan;
    let shared = group "compiler" in
    let json =
      execution
        ~plan_id
        ~run:"run-one"
        ~attempt:"copied"
        ~group:shared.id
        ~start:500.
        "success"
    in
    write (directory ^ "/reports/artifact-a/execution.json") json;
    write (directory ^ "/reports/artifact-b/execution.json") json;
    let report = render directory in
    check
      (List.length (items "attempts" (group_json report shared)) = 2)
      "identical copied artifacts should count as one attempt";
    write
      (directory ^ "/reports/artifact-b/execution.json")
      (execution
         ~plan_id
         ~run:"run-one"
         ~attempt:"copied"
         ~group:shared.id
         ~start:500.
         "failed");
    let report = render directory in
    check
      (text "status" (group_json report shared) = "failed")
      "conflicting duplicate failure must not disappear")

let test_workflow_bootstrap () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    List.iteri plan.Shared.groups ~f:(fun index group ->
      let path =
        worker
          directory
          ~plan_id
          ~run:"github:org/repo:42"
          ~attempt:("1-" ^ group.Shared.id)
          group
          ~start:(100. +. (float_of_int index *. 10.))
          "success"
      in
      write
        (path ^ "/bootstrap.json")
        (obj
           [ "groupId", `String group.id
           ; "runId", `String "github:org/repo:42"
           ; "attemptId", `String ("1-" ^ group.id)
           ; "startedAt", `Float 90.
           ; "finishedAt", `Float 99.
           ; "durationSeconds", `Float 9.
           ; "operation", `String "import-builder"
           ; "status", `String "success"
           ]));
    let report = render directory in
    check
      (text "status" report = "success")
      "bootstrap and execution identities should join into a single successful \
       attempt";
    check
      (items "runIds" report = [ `String "github:org/repo:42" ])
      "bootstrap must not introduce a synthetic second run";
    check
      (Json.number (get "attempts" (get "counts" report)) = 3.)
      "one worker plus bootstrap must remain one attempt per group";
    let attempt =
      group_json report (group "compiler") |> items "attempts" |> List.hd
    in
    check
      (List.exists (items "phases" attempt) ~f:(fun phase ->
         text "phase" phase = "bootstrap"
         && get "durationSeconds" phase = `Float 9.))
      "actual bootstrap timing should appear on worker timeline")

let test_scheduler_terminal_outcomes () =
  temporary (fun directory ->
    let plan, plan_id, _ = fixture directory in
    seed directory plan_id plan;
    let start =
      obj
        [ "planId", `String plan_id
        ; "runId", `String "run-one"
        ; "time", `Float 95.
        ; "type", `String "run_start"
        ]
    in
    let finish status =
      obj
        [ "planId", `String plan_id
        ; "runId", `String "run-one"
        ; "time", `Float 140.
        ; "type", `String "run_finish"
        ; "status", `String status
        ]
    in
    events (directory ^ "/reports/scheduler-events.jsonl") [ start ];
    check
      (text "status" (render directory) = "incomplete")
      "all worker successes cannot complete a scheduler run with no terminal \
       event";
    List.iter [ "cancelled"; "failed"; "success" ] ~f:(fun status ->
      events
        (directory ^ "/reports/scheduler-events.jsonl")
        [ start; finish status ];
      let report = render directory in
      check
        (text "status" report = status)
        "scheduler terminal outcome must survive otherwise successful worker \
         reports";
      check
        (text "status" (get "runTerminal" report) = status)
        "the run-level outcome evidence should remain inspectable"))

let test_cancelled_worker_and_run () =
  temporary (fun directory ->
    let plan, plan_id, group = fixture directory in
    seed directory plan_id plan;
    let native = group "native" in
    let path =
      worker
        directory
        ~plan_id
        ~run:"run-one"
        ~attempt:"cancelled"
        native
        ~start:400.
        "cancelled"
    in
    events
      (path ^ "/execution-events.jsonl")
      [ event
          ~plan_id
          ~run:"run-one"
          ~attempt:"cancelled"
          ~group:native.id
          ~time:400.
          "attempt_start"
          []
      ; event
          ~plan_id
          ~run:"run-one"
          ~attempt:"cancelled"
          ~group:native.id
          ~time:408.
          "phase_finish"
          [ "phase", `String "build"; "status", `String "failed" ]
      ; event
          ~plan_id
          ~run:"run-one"
          ~attempt:"cancelled"
          ~group:native.id
          ~time:409.
          "attempt_finish"
          [ "status", `String "cancelled" ]
      ];
    events
      (directory ^ "/reports/scheduler-events.jsonl")
      [ obj
          [ "planId", `String plan_id
          ; "runId", `String "run-one"
          ; "time", `Float 100.
          ; "type", `String "run_start"
          ]
      ; obj
          [ "planId", `String plan_id
          ; "runId", `String "run-one"
          ; "time", `Float 410.
          ; "type", `String "run_finish"
          ; "status", `String "cancelled"
          ]
      ];
    write
      (directory ^ "/reports/execution-error.json")
      (obj [ "group", `Null; "error", `String "Local_runner.Cancelled" ]);
    let report = render directory in
    check
      (text "status" report = "cancelled")
      "cancellation should not be mislabeled as a package failure";
    check
      (text "status" (group_json report native) = "cancelled")
      "worker cancellation remains distinct from the failed phase it \
       interrupted";
    check
      (Json.number (get "cancelled" (get "counts" report)) = 1.)
      "cancelled groups should have an explicit count";
    check
      (List.exists
         (Json.strings (get "diagnostics" report))
         ~f:(fun value -> String.starts_with value ~prefix:"Run-level error:"))
      "the runner error should not appear as an unassociated worker")

let test_unfinished_worker_timing () =
  temporary (fun directory ->
    let _, plan_id, group = fixture directory in
    let native = group "native" in
    let path = directory ^ "/reports/interrupted" in
    let context =
      [ "planId", `String plan_id
      ; "runId", `String "run-one"
      ; "groupId", `String native.id
      ; "attemptId", `String "interrupted"
      ]
    in
    write
      (path ^ "/execution.json")
      (obj
         (context @ [ "status", `String "running"; "startedAt", `Float 100. ]));
    write
      (path ^ "/bootstrap.json")
      (obj
         (context
         @ [ "status", `String "success"
           ; "startedAt", `Float 80.
           ; "finishedAt", `Float 90.
           ]));
    write
      (path ^ "/results.json")
      (obj
         [ "status", `String "success"
         ; ( "context"
           , obj
               (context
               @ [ "startedAt", `Float 101.; "finishedAt", `Float 110. ]) )
         ]);
    let report = render directory in
    let attempt = group_json report native |> items "attempts" |> List.hd in
    check
      (text "status" attempt = "incomplete")
      "engine completion is not worker publication completion";
    check
      (get "finishedAt" attempt = `Null && get "durationSeconds" attempt = `Null)
      "bootstrap or engine completion must not fabricate an interrupted worker \
       end time")

let () =
  test_complete_and_missing ();
  test_failure_and_retry ();
  test_same_directory_retries ();
  test_current_run_isolation ();
  test_phases_and_scheduler ();
  test_evidence_safety ();
  test_xss ();
  test_duplicate_attempts ();
  test_workflow_bootstrap ();
  test_scheduler_terminal_outcomes ();
  test_cancelled_worker_and_run ();
  test_unfinished_worker_timing ();
  print_endline "shared report tests passed (12 scenarios)"
