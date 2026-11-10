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

let capture_stdout f =
  with_directory (fun directory ->
    let path = Filename.concat directory "stdout" in
    flush stdout;
    let descriptor = Unix.descr_of_out_channel stdout in
    let saved = Unix.dup descriptor in
    let destination =
      Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600
    in
    Unix.dup2 destination descriptor;
    Unix.close destination;
    Fun.protect
      ~finally:(fun () ->
        flush stdout;
        Unix.dup2 saved descriptor;
        Unix.close saved)
      f;
    read path)

let with_report ?(color = false) ?(verbose = false) ~github_actions f =
  with_directory (fun directory ->
    let report =
      Report.create
        ~color
        ~verbose
        ~directory
        ~summary_output:(Some (Filename.concat directory "summary-output.md"))
        ~github_actions
        ()
    in
    Fun.protect ~finally:(fun () -> Report.close report) (fun () -> f report))

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

let snapshot
      ?(status = "failure")
      ?(roots = [])
      ?(errors = [])
      ?(cache_reuse = [])
      jobs
  =
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
    ; "cacheReuse", `List cache_reuse
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
    (contains summary "**4 attributes**, **3 unique root derivations**")
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
      ; "message", `String "404%\nerror: 404% ::error::injected"
      ; ( "excerpt"
        , `List [ `String "::add-mask::secret"; `String "::endgroup::" ] )
      ]
  in
  let rendered = Report.render_failure ~github_actions:true failure in
  check
    (contains rendered "bad%2C title%0A")
    "annotation properties must escape commas and line breaks";
  check
    (contains rendered "error: 404%25 ::error::injected")
    "concise annotation causes must escape percent without executing embedded \
     commands";
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
  let ordinary = Report.render_failure ~github_actions:true root in
  check
    (not (contains ordinary "::stop-commands::"))
    "ordinary failure details must not show stop/resume markers";
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
    (contains progress "requests 0 · queued 1")
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
    (contains progress "FETCH   git (1m05s total activity) → piaf")
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
    (contains progress "requests 1 · queued 0")
    "lock waits must not change the package request state";
  check
    (contains progress "Nix lock waits: 2")
    "heartbeat must count waits, including multiple waits for one request";
  check
    (contains progress "BUILD   piaf (12.0s total activity)")
    "one request can build and wait simultaneously";
  check
    (contains
       progress
       "WAIT    waiting for lock <held by another process> (1m05s) · request \
        batch-1")
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
    (contains progress "FETCH   runtime-library (2.5s total activity)")
    "active output downloads must appear in progress";
  check
    (not (contains progress "second-runtime-output"))
    "completed downloads should not be reported as active"

let cache_import ?(error = "") name state =
  `Assoc
    [ "drvPath", `String ("/nix/store/" ^ name ^ ".drv")
    ; "name", `String name
    ; ( "paths"
      , `List
          [ `String ("/nix/store/" ^ name ^ "-out")
          ; `String ("/nix/store/" ^ name ^ "-dev")
          ] )
    ; "source", `String "https://cache.example/<cache>|name"
    ; "state", `String state
    ; "seconds", `Float 65.
    ; "error", `String error
    ; "logPath", `String ("logs/cache-import-" ^ name ^ ".log")
    ; "neededBy", `List [ `String "piaf"; `String "caqti" ]
    ]

let test_cache_imports () =
  let report =
    snapshot
      ~status:"success"
      ~cache_reuse:
        [ cache_import "ocaml" "imported"
        ; cache_import "curl" "importing"
        ; cache_import
            ~error:"\027[31mHTTP <timeout> | retry\027[0m\n::error::untrusted"
            "libpq"
            "failed"
        ; cache_import "rustc" "cancelled"
        ]
      [ job "piaf" "/nix/store/piaf.drv" "built" ]
  in
  let summary = Report.render_summary report in
  check
    (contains
       summary
       "**1 imported**, **1 active**, **1 warnings**, **1 cancelled**")
    "dependency imports should count each state independently";
  check
    (not (contains summary "root failures**"))
    "successful summaries should avoid a redundant all-zero error paragraph";
  check
    (contains summary "Status: <code>success</code>")
    "import warnings must preserve the engine's successful build status";
  check
    (contains summary "warning (import failed)")
    "failed imports must be explicitly labelled warnings";
  check
    (contains
       summary
       "HTTP &lt;timeout&gt; &#124; retry&#10;::error::untrusted")
    "import errors must be escaped and terminal colors removed";
  check
    (contains summary "https://cache.example/&lt;cache&gt;&#124;name")
    "cache source metadata must be escaped";
  check
    (contains summary "/nix/store/ocaml-out"
    && contains summary "/nix/store/ocaml-dev")
    "multi-output imports must preserve their required output paths";
  check
    (contains
       summary
       "Log in report artifact: <code>logs/cache-import-libpq.log")
    "import failures must point to their captured logs";
  check
    (not (contains summary "nix build"))
    "opportunistic imports must not be presented as failed build reproductions";
  let progress = String.concat ~sep:"\n" (Report.render_progress report) in
  check
    (contains progress "cache imports 1 (1 active, 1 warnings)")
    "heartbeat must distinguish completed imports, active imports and warnings";
  check
    (contains progress "IMPORT  curl (1m05s) → caqti, piaf")
    "active imports should identify the dependency, elapsed time and consumers";
  check
    ((not (contains progress "IMPORT  ocaml"))
    && not (contains progress "IMPORT  rustc"))
    "completed and cancelled imports must not appear as active";
  let cancelled =
    snapshot
      ~status:"cancelled"
      ~cache_reuse:
        [ cache_import ~error:"Dependency is already active" "rustc" "cancelled"
        ]
      []
  in
  check
    (contains
       (Report.render_summary cancelled)
       "**0 imported**, **0 active**, **0 warnings**, **1 cancelled**")
    "partial cancelled snapshots must retain cancelled import counts";
  check
    (contains
       (Report.render_summary cancelled)
       "Note: <code>Dependency is already active</code>")
    "normal import cancellation reasons must not be labelled warnings";
  check
    (contains
       (String.concat ~sep:"\n" (Report.render_progress (`Assoc [])))
       "EVAL    0 attributes evaluated")
    "older snapshots without cacheReuse must remain readable"

let test_cache_import_limits () =
  let imports =
    List.init ~len:80 ~f:(fun index ->
      `Assoc
        [ "drvPath", `String (Printf.sprintf "/nix/store/import-%03d.drv" index)
        ; "state", `String "importing"
        ; "source", `String (String.make 10000 '<')
        ; "error", `String (String.make 10000 '|')
        ; ( "paths"
          , `List
              (List.init ~len:100 ~f:(fun n ->
                 `String (Printf.sprintf "/nix/store/output-%03d" n))) )
        ; ( "neededBy"
          , `List
              (List.init ~len:100 ~f:(fun n ->
                 `String (Printf.sprintf "package-%03d" n))) )
        ])
  in
  let report =
    snapshot
      ~cache_reuse:
        (imports
        @ [ cache_import ~error:"timeout" "late-import-warning" "failed" ])
      []
  in
  let summary = Report.render_summary report in
  check
    (String.length summary < 1024 * 1024)
    "large import histories must remain below GitHub's summary limit";
  check
    (contains
       summary
       "Additional dependency imports are recorded in results.json")
    "bounded import tables must point to complete machine-readable results";
  check
    (contains summary "import-000.drv"
    && not (contains summary "import-079.drv"))
    "unnamed imports should use their derivation paths within the table limit";
  check
    (contains summary "late-import-warning")
    "import warnings should remain visible ahead of ordinary bounded details";
  check
    (contains summary "95 more" && not (contains summary "package-099"))
    "large consumer and output lists should be bounded within each import";
  let progress = String.concat ~sep:"\n" (Report.render_progress report) in
  check
    (contains progress "cache imports 0 (80 active, 1 warnings)")
    "heartbeat aggregate counts must include imports omitted from detail lines";
  check
    (occurrences progress "IMPORT  " = 2)
    "heartbeat import detail lines must stay bounded"

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
             ()
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

let test_event_feed () =
  let event kind state =
    `Assoc
      [ "type", `String kind
      ; "state", `String state
      ; ( "drvPath"
        , `String "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-libpq-17.5.drv" )
      ]
  in
  List.iter
    [ "job", "cached"
    ; "job", "queued"
    ; "activity-start", "downloading"
    ; "activity-stop", "waiting"
    ; "upload-queued", "queued"
    ; "upload", "uploaded"
    ]
    ~f:(fun (kind, state) ->
      check
        (Report.render_event (event kind state) = None)
        "routine cache/download/sync transitions must not flood the log";
      check
        (Report.render_event ~verbose:true (event kind state) <> None)
        "verbose mode must keep quiet lifecycle details available");
  let built =
    Option.get (Report.render_event (event "activity-start" "building"))
  in
  check
    (built = "BUILD   libpq-17.5")
    "human events should omit store hashes and .drv suffixes";
  check
    (not (contains built "\027"))
    "plain renderer must be free of color codes";
  let colored =
    Option.get
      (Report.render_event ~color:true (event "activity-start" "building"))
  in
  check
    (contains colored "\027[1;35mBUILD  \027[0m libpq-17.5")
    "only the aligned badge should be colored, then reset";
  List.iter
    [ "package\n::error::forged\027[31m"; "package ##[error]forged" ]
    ~f:(fun name ->
      let malicious =
        `Assoc
          [ "type", `String "job"
          ; "state", `String "submitted"
          ; "name", `String name
          ]
      in
      let plain = Option.get (Report.render_event malicious) in
      check
        (not (contains plain "\n"))
        "untrusted package names must remain a single line";
      with_report ~github_actions:true ~color:false (fun report ->
        let output =
          capture_stdout (fun () -> Report.emit_event report malicious)
        in
        check
          (String.starts_with ~prefix:"::stop-commands::" output
          && contains output ("\n" ^ plain ^ "\n::nix-ci-build-"))
          "modern and legacy workflow commands must stay inside a protected \
           block";
        check
          (not (contains output "\027"))
          "explicitly disabled color must also apply in Actions"))

let consumer_activity
      ?(drv = "/nix/store/compiler.drv")
      ?(name = "compiler")
      needed
  =
  `Assoc
    [ "type", `String "activity-start"
    ; "drvPath", `String drv
    ; "name", `String name
    ; "state", `String "building"
    ; "active", `Int 1
    ; "seconds", `Float 12.
    ; "neededBy", `List (List.map needed ~f:(fun name -> `String name))
    ]

let consumer_snapshot activity =
  `Assoc
    [ "status", `String "building"
    ; "evaluation", `Assoc [ "complete", `Bool true ]
    ; "derivations", `List [ activity ]
    ]

let test_consumer_groups () =
  let needed = List.init ~len:12 ~f:(Printf.sprintf "package-%02d") in
  let activity = consumer_activity needed in
  with_report ~github_actions:true (fun report ->
    let first = capture_stdout (fun () -> Report.emit_event report activity) in
    check
      (contains first "BUILD   compiler → package-00, package-01 (+10 more)")
      "consumer groups must leave the ordinary activity line compact";
    check
      (contains first "::group::Consumers of compiler (12 attributes)\n")
      "the collapsed group should identify the activity and full attribute \
       count";
    List.iter needed ~f:(fun name ->
      check
        (contains first ("  " ^ name ^ "\n"))
        "the group must include every consumer, including omitted names");
    check
      (occurrences first "::group::" = 1
      && occurrences first "::endgroup::" = 1
      && not (contains first "::stop-commands::"))
      "ordinary consumer groups must close without unnecessary runner markers";
    let repeated =
      capture_stdout (fun () ->
        Report.emit_event
          report
          (consumer_activity ("package-00" :: List.rev needed));
        Report.emit_progress report (consumer_snapshot activity))
    in
    check
      (not (contains repeated "::group::"))
      "events and heartbeats must share deduplication despite reordered \
       duplicate consumers";
    let changed = consumer_activity ("package-new" :: needed) in
    let updated =
      capture_stdout (fun () ->
        Report.emit_progress report (consumer_snapshot changed))
    in
    check
      (contains updated "::group::Consumers of compiler (13 attributes)\n"
      && contains updated "  package-new\n")
      "a changed consumer list must expose its newly added attributes";
    let other =
      capture_stdout (fun () ->
        Report.emit_event
          report
          (consumer_activity ~drv:"/nix/store/other-compiler.drv" needed))
    in
    check
      (contains other "::group::Consumers of compiler (12 attributes)")
      "distinct derivations with the same display name need independent groups");
  with_report ~github_actions:false (fun report ->
    let plain =
      capture_stdout (fun () ->
        Report.emit_event report activity;
        Report.emit_progress report (consumer_snapshot activity))
    in
    check
      (contains plain "(+10 more)"
      && (not (contains plain "::group::"))
      && not (contains plain "package-11"))
      "plain progress must stay compact without Actions workflow commands");
  with_report ~github_actions:true (fun report ->
    let progress =
      capture_stdout (fun () ->
        Report.emit_progress report (consumer_snapshot activity))
    in
    check
      (contains progress "::group::Consumers of compiler (12 attributes)")
      "a heartbeat must expose consumers even without a previously rendered \
       start event")

let test_consumer_group_workflow_safety () =
  let long_name = "long-" ^ String.make 500 'x' in
  let needed =
    [ "ordinary"
    ; "::endgroup::\n::error::forged"
    ; "legacy ##[error]forged"
    ; long_name
    ]
  in
  let activity =
    consumer_activity ~name:"compiler\n::group::forged\027[31m" needed
  in
  with_report ~github_actions:true (fun report ->
    let output = capture_stdout (fun () -> Report.emit_event report activity) in
    check
      (contains output ("  " ^ long_name ^ "\n"))
      "expanded consumer lists must not truncate long attribute names";
    check
      (not (contains output "\027"))
      "consumer names and group titles must strip terminal control sequences";
    let protected = ref None
    and groups = ref 0
    and closed = ref 0 in
    List.iter (String.split_on_char ~sep:'\n' output) ~f:(fun line ->
      match !protected with
      | Some token -> if line = "::" ^ token ^ "::" then protected := None
      | None ->
        let prefix = "::stop-commands::" in
        if String.starts_with ~prefix line
        then
          protected :=
            Some
              (String.sub
                 line
                 ~pos:(String.length prefix)
                 ~len:(String.length line - String.length prefix))
        else if String.starts_with ~prefix:"::group::Consumers of " line
        then incr groups
        else if line = "::endgroup::"
        then incr closed
        else
          check
            ((not (contains line "::error::"))
            && (not (contains line "##[error]"))
            && not (contains line "::group::forged"))
            "consumer and activity names must not become executable workflow \
             commands");
    check
      (!groups = 1 && !closed = 1 && !protected = None)
      "untrusted consumers must stay inside a protected, complete group")

let test_ranked_progress () =
  let activity ?(active = 1) ?(finished = `Null) name state seconds =
    `Assoc
      [ "name", `String name
      ; "state", `String state
      ; "active", `Int active
      ; "finishedAt", finished
      ; "seconds", `Float seconds
      ; "phase", `String "buildPhase"
      ; ( "neededBy"
        , `List
            (List.map [ "app"; "cli"; "tests"; "daemon" ] ~f:(fun s ->
               `String s)) )
      ]
  in
  let report =
    `Assoc
      [ "evaluation", `Assoc [ "complete", `Bool true ]
      ; "jobs", `List [ job "app" "/nix/store/app.drv" "submitted" ]
      ; ( "derivations"
        , `List
            [ activity "short-build" "building" 5.
            ; activity
                ~active:0
                ~finished:(`Float 1.)
                "stale-waiting"
                "waiting"
                2000.
            ; activity "large-download" "downloading" 500.
            ; activity "long-build" "building" 120.
            ; `Assoc
                [ "name", `String "legacy-finished"
                ; "state", `String "waiting"
                ; "finishedAt", `Float 1.
                ]
            ] )
      ]
  in
  let lines = Report.render_progress report in
  check
    (contains
       (List.nth lines 1)
       "long-build (2m00s total activity) / phase buildPhase")
    "longest active build should lead the detail lines";
  check
    (contains (List.nth lines 2) "short-build")
    "active builds should precede even longer downloads";
  let output = String.concat ~sep:"\n" lines in
  check
    ((not (contains output "stale-waiting"))
    && not (contains output "legacy-finished"))
    "completed activity must not be counted as a live dependency request";
  check
    (contains output "→ app, cli (+2 more)")
    "consumer names must be useful and bounded";
  check
    (List.length lines = 4)
    "quiet progress should avoid empty cache and error counters"

let test_partial_evaluation_progress () =
  let report status =
    `Assoc
      [ "status", `String status
      ; "evaluation", `Assoc [ "attrs", `Int 1; "complete", `Bool false ]
      ; ( "jobs"
        , `List
            [ job ~cache_status:"cached" "first" "/nix/store/first.drv" "cached"
            ] )
      ]
  in
  let progress =
    String.concat ~sep:"\n" (Report.render_progress (report "evaluating"))
  in
  check
    (String.starts_with ~prefix:"EVAL    " progress
    && contains progress "1 cached")
    "partial cache evaluation must keep the evaluating phase visible";
  check
    (not (contains progress "1/1 complete"))
    "a provisional evaluation denominator must not imply that the whole run is \
     complete";
  let planning =
    String.concat ~sep:"\n" (Report.render_progress (report "planning"))
  in
  check
    (String.starts_with ~prefix:"PLAN    " planning)
    "dependency cache planning must have a distinct visible phase";
  let building =
    String.concat ~sep:"\n" (Report.render_progress (report "building"))
  in
  check
    (String.starts_with ~prefix:"STATUS  " building)
    "an evaluator error must not leave later build progress labelled as \
     evaluation"

let test_complete_groups_and_evaluation_errors () =
  with_report ~github_actions:true (fun report ->
    let errors =
      List.init ~len:11 ~f:(fun i ->
        `Assoc
          [ "attr", `String (Printf.sprintf "package-%d" i)
          ; ( "error"
            , `String
                ("while evaluating package\n"
                ^ String.make 5000 'x'
                ^ "\nerror: missing ocaml_pcre") )
          ])
    in
    let base = snapshot ~errors [] in
    let final =
      match base with
      | `Assoc fields ->
        `Assoc (("error", `String "evaluation process failed") :: fields)
      | _ -> assert false
    in
    let output =
      capture_stdout (fun () ->
        Report.emit_plan report final;
        Report.finish report final)
    in
    check
      (contains output "WARN    plan:" && contains output "11 evaluation errors")
      "zero-job plans must prominently report evaluation errors";
    check
      (occurrences output "::error title=Evaluation failure%3A" = 5)
      "evaluation annotations must be bounded and not repeated at finish";
    check
      (contains output "::error title=Run failure%3A")
      "fatal errors must get actionable console diagnostics";
    check
      (contains output "6 more evaluation errors")
      "omitted evaluation errors must remain discoverable";
    check
      (contains output "error: missing ocaml_pcre")
      "long traces must retain the actionable final cause";
    let open_group = ref false in
    List.iter (String.split_on_char ~sep:'\n' output) ~f:(fun line ->
      if String.starts_with ~prefix:"::group::" line
      then (
        check (not !open_group) "completed diagnostic groups must not overlap";
        open_group := true)
      else if line = "::endgroup::"
      then (
        check !open_group "group end must have a matching start";
        open_group := false)
      else if String.starts_with ~prefix:"FAIL    " line
      then
        check
          (not !open_group)
          "final status must appear outside diagnostic groups");
    check (not !open_group) "each diagnostic block must close before returning";
    let summary = Report.render_summary final in
    check
      (contains summary "error: missing ocaml_pcre")
      "summary must preserve long-trace causes too")

let test_plan_and_summary_presentation () =
  let builds =
    List.init ~len:20 ~f:(fun i ->
      `Assoc [ "name", `String (Printf.sprintf "dependency-%d" i) ])
  in
  let report =
    `Assoc
      [ "status", `String "success"
      ; ( "context"
        , `Assoc
            [ ( "artifactUrl"
              , `String "https://github.com/org/repo/actions/artifacts/42" )
            ; "startedAt", `Float 100.
            ; "finishedAt", `Float 165.
            ] )
      ; "evaluation", `Assoc [ "attrs", `Int 1; "complete", `Bool true ]
      ; "jobs", `List [ job "app" "/nix/store/app.drv" "built" ]
      ; "plan", `Assoc [ "builds", `List builds; "downloads", `List [] ]
      ]
  in
  with_report ~github_actions:true (fun renderer ->
    let output = capture_stdout (fun () -> Report.emit_plan renderer report) in
    check
      (occurrences output "::group::Build plan details" = 1
      && occurrences output "::endgroup::" = 1)
      "a plan should be one complete collapsible block";
    check
      (contains output "::group::Build plan details\nBuild  dependency-0\n"
      && not (contains output "::stop-commands::"))
      "ordinary plan details must not show stop/resume markers";
    check
      (occurrences output "Build  dependency-" = 12
      && contains output "8 more derivations")
      "large plans should keep the console bounded");
  let summary = Report.render_summary report in
  check
    (String.starts_with ~prefix:"# Build succeeded" summary)
    "the summary should lead with the outcome";
  check
    (contains
       (String.sub summary ~pos:0 ~len:(min 500 (String.length summary)))
       "Download full report and logs")
    "the full artifact should be directly accessible near the top";
  check
    (contains
       summary
       "| Built | Cached | Failed | Blocked | Evaluation errors | Elapsed |")
    "top-level metrics should remain compact and comparable";
  check (contains summary "1m05s") "overall elapsed time should be visible";
  check
    (contains summary "<details><summary>Context</summary>")
    "supporting metadata should remain available without overwhelming the \
     outcome";
  check
    (occurrences summary "<details>" = occurrences summary "</details>")
    "summary disclosure blocks must remain balanced"

let test_count_units_and_activity_time () =
  let report =
    `Assoc
      [ "status", `String "building"
      ; ( "evaluation"
        , `Assoc
            [ "attrs", `Int 5
            ; "complete", `Bool true
            ; ( "errors"
              , `List
                  [ `Assoc
                      [ "attr", `String "invalid-one"
                      ; "error", `String "missing input"
                      ]
                  ; `Assoc
                      [ "attr", `String "invalid-two"
                      ; "error", `String "missing input"
                      ]
                  ] )
            ] )
      ; ( "jobs"
        , `List
            [ job
                ~cache_status:"cached"
                "shared"
                "/nix/store/shared.drv"
                "cached"
            ; job
                ~cache_status:"cached"
                "shared-alias"
                "/nix/store/shared.drv"
                "cached"
            ; job "compiler" "/nix/store/compiler.drv" "submitted"
            ] )
      ; ( "derivations"
        , `List
            [ `Assoc
                [ "name", `String "compiler"
                ; "state", `String "building"
                ; "active", `Int 1
                ; "seconds", `Float 52.1
                ; "phase", `String "checkPhase"
                ]
            ] )
      ]
  in
  with_report ~github_actions:false (fun renderer ->
    let plan = capture_stdout (fun () -> Report.emit_plan renderer report) in
    check
      (contains
         plan
         "5 attributes evaluated · 2 unique root derivations (1 alias)")
      "plans must distinguish attributes, unique roots and aliases without \
       counting evaluation errors as aliases");
  let progress = String.concat ~sep:"\n" (Report.render_progress report) in
  check
    (contains progress "1/2 root derivations complete")
    "progress denominators must explicitly count deduplicated root derivations";
  check
    (contains progress "compiler (52.1s total activity) / phase checkPhase")
    "activity duration must not appear to be the time spent in the current \
     phase";
  let summary = Report.render_summary report in
  check
    (contains
       summary
       "**5 attributes**, **2 unique root derivations** (**1 alias**)")
    "summary counts and aliases must agree with the plan despite evaluation \
     errors";
  check
    (contains summary "| Last phase | Total activity time |")
    "summary phase metadata must be separate from total activity time";
  check
    (contains summary "| Package | Queue wait | Request time | Build time |"
    && not (contains summary "Upload time"))
    "request timings must omit the unpopulated upload-time column"

let () =
  test_grouping ();
  test_workflow_commands ();
  test_limit ();
  test_partial ();
  test_activity ();
  test_lock_waits ();
  test_unknown_producer_downloads ();
  test_cache_imports ();
  test_cache_import_limits ();
  test_files ();
  test_event_feed ();
  test_consumer_groups ();
  test_consumer_group_workflow_safety ();
  test_ranked_progress ();
  test_partial_evaluation_progress ();
  test_complete_groups_and_evaluation_errors ();
  test_plan_and_summary_presentation ();
  test_count_units_and_activity_time ();
  print_endline "report tests passed"
