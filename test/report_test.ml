module Report = Nix_ci_build.Report

let fail message = failwith message
let check condition message = if not condition then fail message

let contains value part =
  let rec loop pos =
    pos + String.length part <= String.length value
    && (String.sub value ~pos ~len:(String.length part) = part || loop (pos + 1))
  in
  loop 0

let occurrences value part =
  let rec loop pos count =
    if pos + String.length part > String.length value
    then count
    else if String.sub value ~pos ~len:(String.length part) = part
    then loop (pos + String.length part) (count + 1)
    else loop (pos + 1) count
  in
  loop 0 0

let read path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in channel)
    (fun () -> really_input_string channel (in_channel_length channel))

let rec remove_directory path =
  if Sys.is_directory path
  then (
    Array.iter (Sys.readdir path) ~f:(fun name ->
      remove_directory (Filename.concat path name));
    Unix.rmdir path)
  else Sys.remove path

let with_directory f =
  let directory = Filename.temp_file "nix-ci-build-report-test-" "" in
  Sys.remove directory;
  Unix.mkdir directory 0o700;
  Fun.protect
    ~finally:(fun () -> remove_directory directory)
    (fun () -> f directory)

let root =
  `Assoc
    [ "drvPath", `String "/nix/store/root-tzdata.drv"
    ; "name", `String "tzdata"
    ; "kind", `String "build"
    ; "message", `String "clock <test> failed | today"
    ; "affected", `List [ `String "postgresql" ]
    ; "logPath", `String "logs/root-tzdata.log"
    ; "excerpt", `List [ `String "compiler: <script>alert('bad')</script>" ]
    ]

let job ?(cache_status = "notBuilt") ?failure ?(queue = 0.) attr drv state =
  `Assoc
    ([ "attrs", `List [ `String attr ]
     ; "drvPath", `String drv
     ; "name", `String attr
     ; "state", `String state
     ; "cacheStatus", `String cache_status
     ; "queueSeconds", `Float queue
     ; "activeSeconds", `Float 2.5
     ]
    @ match failure with None -> [] | Some value -> [ "failure", value ])

let snapshot ?(status = "failure") ?(roots = []) ?(errors = []) jobs =
  `Assoc
    [ "schemaVersion", `Int 1
    ; "status", `String status
    ; ( "context"
      , `Assoc
          [ "flake", `String ".#packages"; "system", `String "aarch64-linux" ] )
    ; ( "evaluation"
      , `Assoc
          [ "attrs", `Int (List.length jobs)
          ; "complete", `Bool (status <> "cancelled")
          ; "errors", `List errors
          ] )
    ; "jobs", `List jobs
    ; "rootFailures", `List roots
    ; "derivations", `List []
    ; "uploads", `List []
    ; "futureField", `Assoc [ "ignored", `Bool true ]
    ]

let test_grouping () =
  let failure =
    `Assoc
      [ "kind", `String "build"
      ; "rootDrv", `String "/nix/store/root-tzdata.drv"
      ; "message", `String "dependency failed"
      ; ( "dependencyPath"
        , `List [ `String "caqti"; `String "postgresql"; `String "tzdata" ] )
      ]
  in
  let jobs =
    [ job ~failure "postgresql" "/nix/store/postgresql.drv" "failed"
    ; job ~failure "caqti" "/nix/store/caqti.drv" "blocked"
    ; job ~cache_status:"cached" "alias" "/nix/store/alias.drv" "cached"
    ; job ~cache_status:"cached" "alias-two" "/nix/store/alias.drv" "cached"
    ]
  in
  let summary = Report.render_summary (snapshot ~roots:[ root ] jobs) in
  check
    (contains summary "**4 attributes**, **3 unique derivations**")
    "attributes and unique derivations must differ";
  check
    (occurrences summary "### <code>tzdata</code>" = 1)
    "one root failure must group its affected packages";
  check
    (contains summary "Affects **2 attributes**")
    "affected attributes must be merged and deduplicated";
  check
    (contains summary "caqti → postgresql → tzdata")
    "blocked packages should explain their dependency path";
  check
    (contains summary "nix build --no-link -L")
    "root failure should have a reproduction command";
  check
    (contains summary "logs/root-tzdata.log")
    "root failure should identify the saved log";
  check (not (contains summary "<script>")) "log HTML must be escaped";
  check
    (contains summary "&lt;script&gt;")
    "escaped log text should remain readable";
  check (contains summary "&#124;") "table delimiters should be escaped"

let test_workflow_commands () =
  let failure =
    `Assoc
      [ "name", `String "bad, title\n::warning::injected"
      ; "kind", `String "download"
      ; "message", `String "404%\n::error::injected"
      ; ( "excerpt"
        , `List [ `String "::add-mask::secret"; `String "::endgroup::" ] )
      ]
  in
  let rendered = Report.render_failure ~github_actions:true failure in
  check
    (contains rendered "bad%2C title%0A")
    "annotation properties must escape commas and line breaks";
  check
    (contains rendered "404%25%0A::error::injected")
    "annotation messages must escape percent and line breaks";
  check
    (contains rendered "::stop-commands::nix-ci-build-")
    "arbitrary log lines must disable runner command processing";
  let stop_index = ref (-1)
  and log_index = ref (-1) in
  List.iteri (String.split_on_char ~sep:'\n' rendered) ~f:(fun i line ->
    if String.starts_with ~prefix:"::stop-commands::" line then stop_index := i;
    if line = "::add-mask::secret" then log_index := i);
  check
    (!stop_index >= 0 && !log_index > !stop_index)
    "log commands must occur only within the protected block";
  let plain = Report.render_failure ~github_actions:false root in
  check
    (not (contains plain "::group::"))
    "plain output should not contain runner commands"

let test_limit () =
  let roots =
    List.init ~len:180 ~f:(fun i ->
      `Assoc
        [ "drvPath", `String (Printf.sprintf "/nix/store/failure-%d.drv" i)
        ; "name", `String (String.make 4000 'n')
        ; "kind", `String "build"
        ; "message", `String (String.make 10000 '<')
        ; ( "affected"
          , `List
              (List.init ~len:60 ~f:(fun n ->
                 `String (Printf.sprintf "%d-%s" n (String.make 2000 'a')))) )
        ; ( "excerpt"
          , `List
              (List.init ~len:100 ~f:(fun _ -> `String (String.make 1000 '<')))
          )
        ])
  in
  let rendered = Report.render_summary (snapshot ~roots []) in
  check
    (String.length rendered < 1024 * 1024)
    "summary must remain below the GitHub 1 MiB limit";
  check
    (contains rendered "Full details are in results.json")
    "bounded summary should point to full results";
  check
    (contains rendered "Context")
    "later compact sections should survive omitted oversized details"

let test_partial () =
  let report =
    snapshot
      ~status:"cancelled"
      [ job ~queue:3600. "queued-package" "/nix/store/queued.drv" "queued"
      ; job "cancelled-package" "/nix/store/cancelled.drv" "cancelled"
      ]
  in
  let rendered = Report.render_summary report in
  check
    (contains rendered "Evaluation incomplete")
    "interrupted evaluation must be marked incomplete";
  check
    (contains rendered "Unfinished and cancelled packages")
    "interrupted packages must remain visible";
  check (contains rendered "queued-package") "queued package should be recorded";
  check
    (contains rendered "1h00m")
    "queue waits should be reported independently";
  let progress = String.concat ~sep:"\n" (Report.render_progress report) in
  check
    (contains progress "requests 0 | queued 1")
    "queued work must not be described as building";
  ignore (Report.render_summary (`Assoc []))

let test_activity () =
  let report =
    `Assoc
      [ "evaluation", `Assoc [ "attrs", `Int 1; "complete", `Bool true ]
      ; "jobs", `List [ job "piaf" "/nix/store/piaf.drv" "submitted" ]
      ; ( "derivations"
        , `List
            [ `Assoc
                [ "name", `String "git"
                ; "state", `String "downloading"
                ; "seconds", `Float 65.
                ; "neededBy", `List [ `String "piaf" ]
                ]
            ] )
      ]
  in
  let progress = String.concat ~sep:"\n" (Report.render_progress report) in
  check
    (contains progress "requests 1")
    "request counters should reflect submitted work";
  check
    (contains progress "downloading git (1m05s) → piaf")
    "progress should expose actual dependency activity"

let test_lock_waits () =
  let waits =
    List.init ~len:2 ~f:(fun id ->
      `Assoc
        [ "id", `Int id
        ; "requestId", `String "batch-1"
        ; ( "drvs"
          , `List
              [ `String "/nix/store/piaf.drv"; `String "/nix/store/git.drv" ] )
        ; "reason", `String "waiting for lock <held by another process>"
        ; "seconds", `Float 65.
        ])
  in
  let report =
    `Assoc
      [ "status", `String "building"
      ; "jobs", `List [ job "piaf" "/nix/store/piaf.drv" "submitted" ]
      ; ( "derivations"
        , `List
            [ `Assoc
                [ "name", `String "piaf"
                ; "state", `String "building"
                ; "buildSeconds", `Float 12.
                ]
            ] )
      ; "waits", `List waits
      ]
  in
  let progress = String.concat ~sep:"\n" (Report.render_progress report) in
  check
    (contains progress "requests 1 | queued 0")
    "lock waits must not change the package request state";
  check
    (contains progress "Nix lock waits: 2")
    "heartbeat must count waits, including multiple waits for one request";
  check
    (contains progress "building piaf (12.0s)")
    "one request can build and wait simultaneously";
  check
    (contains
       progress
       "Nix lock wait: waiting for lock <held by another process> (1m05s), \
        request batch-1")
    "lock progress should explain reason and elapsed time";
  let summary = Report.render_summary report in
  check
    (contains summary "Nix lock waits: **2 active waits**")
    "summary must count active waits separately";
  check
    (contains summary "waiting for lock &lt;held by another process&gt;")
    "lock reasons must be escaped in the summary";
  check
    (contains summary "Build time")
    "actual root build time should be labelled distinctly from request time";
  let cancelled =
    `Assoc [ "status", `String "cancelled"; "waits", `List waits ]
  in
  check
    (contains
       (Report.render_summary cancelled)
       "Nix lock waits: **2 active waits**")
    "partial cancellation snapshots must preserve unresolved waits";
  check
    (contains
       (Report.render_summary (`Assoc [ "waits", `List [] ]))
       "Nix lock waits: **0 active waits**")
    "completed snapshots must not invent historical active waits"

let test_unknown_producer_downloads () =
  let first =
    `Assoc
      [ "drvPath", `Null
      ; "path", `String "/nix/store/first-runtime-output"
      ; "name", `String "runtime-library"
      ; "kind", `String "download"
      ; "state", `String "downloading"
      ; "downloadSeconds", `Float 2.5
      ; "message", `String "HTTP timeout"
      ]
  and second =
    `Assoc
      [ "drvPath", `Null
      ; "path", `String "/nix/store/second-runtime-output"
      ; "kind", `String "download"
      ; "state", `String "cached"
      ; "downloadSeconds", `Float 7.5
      ; "message", `String "HTTP timeout"
      ]
  in
  let report =
    `Assoc
      [ "derivations", `List [ first; second ]
      ; "rootFailures", `List [ first; second ]
      ]
  in
  let summary = Report.render_summary report in
  check
    (contains summary "**2 root failures**")
    "null producer derivations must use distinct output path identities";
  check
    (contains summary "runtime-library")
    "downloads with unknown producers should retain their names";
  check
    (contains summary "/nix/store/second-runtime-output")
    "unnamed downloads should fall back to their output paths";
  check
    (contains summary "7.5s")
    "downloadSeconds should appear in the slow activity table";
  check
    (not (contains summary "nix build"))
    "unknown producer outputs must not invent derivation build commands";
  let progress = String.concat ~sep:"\n" (Report.render_progress report) in
  check
    (contains progress "downloading runtime-library (2.5s)")
    "active output downloads must appear in progress";
  check
    (not (contains progress "second-runtime-output"))
    "completed downloads should not be reported as active"

let test_files () =
  with_directory (fun directory ->
    let report_directory = Filename.concat directory "nested/report" in
    let explicit_output = Filename.concat directory "requested-summary.md" in
    let ignored_env = Filename.concat directory "github-summary.md" in
    let previous_env = Sys.getenv_opt "GITHUB_STEP_SUMMARY" in
    Unix.putenv "GITHUB_STEP_SUMMARY" ignored_env;
    Fun.protect
      ~finally:(fun () ->
        Unix.putenv
          "GITHUB_STEP_SUMMARY"
          (Option.value previous_env ~default:""))
      (fun () ->
         let report =
           Report.create
             ~directory:report_directory
             ~summary_output:(Some explicit_output)
             ~github_actions:false
         in
         Fun.protect
           ~finally:(fun () -> Report.close report)
           (fun () ->
              let event =
                `Assoc
                  [ "kind", `String "queued"; "message", `String "one\ntwo" ]
              in
              Report.append_event report event;
              let events_path =
                Filename.concat report_directory "events.jsonl"
              in
              check
                (Yojson.Safe.from_string (read events_path) = event)
                "event must be on disk before close";
              Report.append_event report (`Assoc [ "kind", `String "built" ]);
              let lines =
                String.split_on_char ~sep:'\n' (read events_path)
                |> List.filter ~f:(fun line -> line <> "")
              in
              check
                (List.length lines = 2)
                "events must remain separate JSON lines";
              List.iter lines ~f:(fun line ->
                ignore (Yojson.Safe.from_string line));
              let initial =
                snapshot
                  ~status:"cancelled"
                  [ job "pending" "/nix/store/pending.drv" "queued" ]
              in
              Report.write_snapshot report initial;
              let results_path =
                Filename.concat report_directory "results.json"
              in
              let old_channel = open_in results_path in
              Fun.protect
                ~finally:(fun () -> close_in old_channel)
                (fun () ->
                   let final =
                     snapshot
                       ~status:"success"
                       [ job "pending" "/nix/store/pending.drv" "built" ]
                   in
                   Report.finish report final;
                   check
                     (Yojson.Safe.from_string (read results_path) = final)
                     "latest snapshot must replace old results";
                   let old_contents =
                     really_input_string
                       old_channel
                       (in_channel_length old_channel)
                   in
                   check
                     (Yojson.Safe.from_string old_contents = initial)
                     "atomic replacement must preserve existing readers' old \
                      complete snapshot";
                   check
                     (read explicit_output = Report.render_summary final)
                     "explicit summary output must be honored";
                   check
                     (not (Sys.file_exists ignored_env))
                     "report must not silently choose GITHUB_STEP_SUMMARY";
                   check
                     (read (Filename.concat report_directory "summary.md")
                     = read explicit_output)
                     "artifact summary and explicit output should agree"));
         check
           (Array.for_all (Sys.readdir report_directory) ~f:(fun name ->
              not (String.starts_with ~prefix:".nix-ci-build-" name)))
           "temporary atomic files should be cleaned up"))

let () =
  test_grouping ();
  test_workflow_commands ();
  test_limit ();
  test_partial ();
  test_activity ();
  test_lock_waits ();
  test_unknown_producer_downloads ();
  test_files ();
  print_endline "report tests passed"
