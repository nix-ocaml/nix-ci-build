module StringSet = Set.Make (String)

let field name = function
  | `Assoc fields -> (try List.assoc name fields with Not_found -> `Null)
  | _ -> `Null

let string = function `String s -> s | _ -> ""
let text name json = string (field name json)
let list = function `List items -> items | _ -> []
let items name json = list (field name json)

let number = function
  | `Int n -> float_of_int n
  | `Intlit n ->
    (match float_of_string_opt n with
    | Some n when Float.is_finite n -> n
    | _ -> 0.)
  | `Float n when Float.is_finite n -> n
  | _ -> 0.

let count name json = int_of_float (number (field name json))
let state json = text "state" json

let count_state name records =
  List.length (List.filter records ~f:(fun record -> state record = name))

let strings values =
  List.filter_map ~f:(function `String s -> Some s | _ -> None) values

let unique values = StringSet.elements (StringSet.of_list values)
let attrs job = strings (items "attrs" job)

let take n values =
  let rec loop n acc = function
    | _ when n <= 0 -> List.rev acc
    | [] -> List.rev acc
    | x :: xs -> loop (n - 1) (x :: acc) xs
  in
  loop n [] values

let utf8_prefix value limit =
  if String.length value <= limit
  then value
  else
    let rec boundary n =
      if n > 0 && Char.code value.[n] land 0xc0 = 0x80
      then boundary (n - 1)
      else n
    in
    String.sub value ~pos:0 ~len:(boundary (max 0 limit))

let shorten ?(limit = 2048) value =
  if String.length value <= limit then value else utf8_prefix value limit ^ "…"

let clean_terminal value =
  let output = Buffer.create (String.length value) in
  let rec loop i =
    if i < String.length value
    then
      let c = value.[i] in
      if c = '\027'
      then
        if i + 1 < String.length value && value.[i + 1] = '['
        then
          let rec skip j =
            if j >= String.length value
            then j
            else if value.[j] >= '@' && value.[j] <= '~'
            then j + 1
            else skip (j + 1)
          in
          loop (skip (i + 2))
        else loop (i + 1)
      else (
        if c = '\n' || c = '\t' || Char.code c >= 32
        then Buffer.add_char output c;
        loop (i + 1))
  in
  loop 0;
  Buffer.contents output

let html value =
  let output = Buffer.create (String.length value) in
  String.iter value ~f:(function
    | '&' -> Buffer.add_string output "&amp;"
    | '<' -> Buffer.add_string output "&lt;"
    | '>' -> Buffer.add_string output "&gt;"
    | '"' -> Buffer.add_string output "&quot;"
    | '\'' -> Buffer.add_string output "&#39;"
    | '|' -> Buffer.add_string output "&#124;"
    | '\n' | '\r' -> Buffer.add_string output "&#10;"
    | c -> Buffer.add_char output c);
  Buffer.contents output

let code value = "<code>" ^ html (shorten (clean_terminal value)) ^ "</code>"

let pre value =
  let escaped = html (clean_terminal value) in
  "<pre>" ^ escaped ^ "</pre>\n"

let shell_quote value =
  "'" ^ String.concat ~sep:"'\\''" (String.split_on_char ~sep:'\'' value) ^ "'"

let nonempty fallback value = if value = "" then fallback else value

let duration seconds =
  let seconds = max 0. seconds in
  if seconds < 60.
  then Printf.sprintf "%.1fs" seconds
  else if seconds < 3600.
  then
    Printf.sprintf
      "%dm%02ds"
      (int_of_float seconds / 60)
      (int_of_float seconds mod 60)
  else
    Printf.sprintf
      "%dh%02dm"
      (int_of_float seconds / 3600)
      (int_of_float seconds / 60 mod 60)

let elapsed name json =
  match field name json with `Null -> "—" | value -> duration (number value)

let activity_path activity =
  nonempty (text "path" activity) (text "drvPath" activity)

let activity_name activity =
  nonempty (activity_path activity) (text "name" activity)

let activity_seconds activity =
  max
    (number (field "seconds" activity))
    (number (field "buildSeconds" activity)
    +. number (field "downloadSeconds" activity))

let single_line ?(limit = 240) value =
  clean_terminal value
  |> String.map ~f:(function '\n' | '\r' | '\t' -> ' ' | c -> c)
  |> shorten ~limit

let diagnostic_message ?(limit = 2000) value =
  let value = clean_terminal value in
  if String.length value <= limit
  then value
  else
    let head = utf8_prefix value (min 400 (limit / 4)) in
    let separator = "\n…\n" in
    let tail_length =
      max 0 (limit - String.length head - String.length separator)
    in
    let rec boundary i =
      if i < String.length value && Char.code value.[i] land 0xc0 = 0x80
      then boundary (i + 1)
      else i
    in
    let start = boundary (String.length value - tail_length) in
    head
    ^ separator
    ^ String.sub value ~pos:start ~len:(String.length value - start)

let error_cause value =
  let lines =
    clean_terminal value
    |> String.split_on_char ~sep:'\n'
    |> List.map ~f:String.trim
    |> List.filter ~f:(fun line -> line <> "")
    |> List.rev
  in
  let cause =
    match
      List.find_opt lines ~f:(fun line ->
        String.starts_with ~prefix:"error:" (String.lowercase_ascii line))
    with
    | Some cause -> cause
    | None -> (match lines with last :: _ -> last | [] -> value)
  in
  single_line ~limit:300 (diagnostic_message ~limit:280 cause)

let short_path path =
  if String.starts_with ~prefix:"/nix/store/" path
  then
    let name = Filename.basename path in
    let name =
      if String.length name > 33 && name.[32] = '-'
      then String.sub name ~pos:33 ~len:(String.length name - 33)
      else name
    in
    if String.ends_with ~suffix:".drv" name
    then String.sub name ~pos:0 ~len:(String.length name - 4)
    else name
  else path

let display_name item =
  let fallback =
    match attrs item with
    | name :: _ -> name
    | [] -> short_path (activity_path item)
  in
  single_line ~limit:140 (nonempty fallback (text "name" item))

let status_line ?(color = false) label message =
  let badge = Printf.sprintf "%-7s" label in
  let badge =
    if not color
    then badge
    else
      let code =
        match label with
        | "FAIL" | "ERROR" -> "1;31"
        | "WARN" | "RETRY" | "WAIT" | "CANCEL" -> "1;33"
        | "DONE" | "BUILT" | "REUSED" -> "1;32"
        | "BUILD" | "REQUEST" -> "1;35"
        | "DEBUG" -> "2"
        | _ -> "1;36"
      in
      "\027[" ^ code ^ "m" ^ badge ^ "\027[0m"
  in
  badge ^ " " ^ message

let consumers item =
  let needed = unique (strings (items "neededBy" item)) in
  match needed with
  | [] -> ""
  | _ ->
    " → "
    ^ single_line ~limit:120 (String.concat ~sep:", " (take 2 needed))
    ^
    if List.length needed > 2
    then Printf.sprintf " (+%d more)" (List.length needed - 2)
    else ""

let run_seconds snapshot =
  let context = field "context" snapshot in
  if field "elapsedSeconds" context <> `Null
  then Some (number (field "elapsedSeconds" context))
  else if
    field "startedAt" context <> `Null && field "finishedAt" context <> `Null
  then
    Some
      (number (field "finishedAt" context) -. number (field "startedAt" context))
  else None

let activity_kind activity =
  if
    text "kind" activity = "download"
    || state activity = "downloading"
    || (number (field "downloadSeconds" activity) > 0.
       && number (field "buildSeconds" activity) = 0.)
  then "download"
  else if
    number (field "buildSeconds" activity) > 0.
    || state activity = "building"
    || state activity = "built"
  then "build"
  else "derivation"

let failure_key failure =
  nonempty
    (text "kind" failure
    ^ ":"
    ^ activity_name failure
    ^ ":"
    ^ text "message" failure)
    (activity_path failure)

let wait_reason wait =
  nonempty "waiting for another Nix process" (text "reason" wait)

let context_value name value =
  match name, value with
  | ("evaluationSeconds" | "planningSeconds"), (`Int _ | `Intlit _ | `Float _)
    ->
    duration (number value)
  | ("startedAt" | "finishedAt"), (`Int _ | `Intlit _ | `Float _) ->
    (try
       let date = Unix.gmtime (number value) in
       Printf.sprintf
         "%04d-%02d-%02d %02d:%02d:%02d UTC"
         (date.Unix.tm_year + 1900)
         (date.Unix.tm_mon + 1)
         date.Unix.tm_mday
         date.Unix.tm_hour
         date.Unix.tm_min
         date.Unix.tm_sec
     with
    | Unix.Unix_error _ | Invalid_argument _ -> Yojson.Safe.to_string value)
  | _, `String s -> s
  | _ -> Yojson.Safe.to_string value

let job_name job =
  match attrs job with
  | name :: _ -> name
  | [] -> nonempty (text "drvPath" job) (text "name" job)

let deduplicate_jobs jobs =
  let table = Hashtbl.create 128 in
  let order = ref [] in
  List.iter jobs ~f:(fun job ->
    let key = nonempty (job_name job) (text "drvPath" job) in
    match Hashtbl.find_opt table key with
    | None ->
      Hashtbl.add table key job;
      order := key :: !order
    | Some previous ->
      let merged =
        `List
          (List.map
             ~f:(fun s -> `String s)
             (unique (attrs previous @ attrs job)))
      in
      let fields = match job with `Assoc fields -> fields | _ -> [] in
      Hashtbl.replace
        table
        key
        (`Assoc (("attrs", merged) :: List.remove_assoc "attrs" fields)));
  List.map (List.rev !order) ~f:(Hashtbl.find table)

let roots snapshot =
  let table = Hashtbl.create 16 in
  let order = ref [] in
  let add root =
    let key = failure_key root in
    match Hashtbl.find_opt table key with
    | None ->
      Hashtbl.add table key root;
      order := key :: !order
    | Some previous ->
      let affected =
        unique
          (strings (items "affected" previous) @ strings (items "affected" root))
      in
      let fields = match previous with `Assoc fields -> fields | _ -> [] in
      Hashtbl.replace
        table
        key
        (`Assoc
            (("affected", `List (List.map affected ~f:(fun s -> `String s)))
            :: List.remove_assoc "affected" fields))
  in
  List.iter (items "rootFailures" snapshot) ~f:add;
  List.iter (items "jobs" snapshot) ~f:(fun job ->
    let failure = field "failure" job in
    if failure <> `Null
    then
      let drv = nonempty (text "drvPath" job) (text "rootDrv" failure) in
      add
        (`Assoc
            [ "drvPath", `String drv
            ; ( "name"
              , `String
                  (if drv = text "drvPath" job
                   then nonempty drv (text "name" job)
                   else drv) )
            ; "kind", `String (nonempty "unknown" (text "kind" failure))
            ; "message", `String (text "message" failure)
            ; "affected", `List (List.map (attrs job) ~f:(fun s -> `String s))
            ; "logPath", field "logPath" job
            ; "excerpt", `List []
            ]));
  List.map (List.rev !order) ~f:(Hashtbl.find table)

let excerpt root =
  strings (items "excerpt" root)
  |> List.concat_map ~f:(String.split_on_char ~sep:'\n')
  |> take 50
  |> String.concat ~sep:"\n"
  |> shorten ~limit:8192

let has_prefix prefix value = String.starts_with ~prefix value

let url value =
  let output = Buffer.create (String.length value) in
  String.iter value ~f:(fun c ->
    match c with
    | '<' | '>' | '"' | '\'' | '\n' | '\r' | ' ' | '(' | ')' | '\\' ->
      Buffer.add_string output (Printf.sprintf "%%%02X" (Char.code c))
    | _ -> Buffer.add_char output c);
  Buffer.contents output

let log_reference context path =
  if path = ""
  then ""
  else if has_prefix "https://" path || has_prefix "http://" path
  then "[Build log](<" ^ url path ^ ">)"
  else
    let artifact = text "artifactUrl" context in
    if has_prefix "https://" artifact
    then "[Report artifact](<" ^ url artifact ^ ">): " ^ code path
    else "Log in report artifact: " ^ code path

let failure_kind kind =
  match kind with
  | "evaluation" | "eval" -> "Evaluation"
  | "download" | "fetch" | "substitution" -> "Download"
  | "upload" -> "Cache sync"
  | "build" -> "Build"
  | "run" -> "Run"
  | "cancelled" -> "Cancelled"
  | _ -> nonempty "Unknown" kind

let render_summary snapshot =
  (* Leave headroom below GitHub's 1 MiB limit, including UTF-8 byte lengths. *)
  let limit = ref 800_000 in
  let output = Buffer.create 4096 in
  let truncated = ref false in
  let add value =
    if Buffer.length output + String.length value <= !limit
    then Buffer.add_string output value
    else truncated := true
  in
  let table headers =
    add
      ("\n| "
      ^ String.concat ~sep:" | " headers
      ^ " |\n| "
      ^ String.concat ~sep:" | " (List.map headers ~f:(fun _ -> "---"))
      ^ " |\n")
  in
  let row cells = add ("| " ^ String.concat ~sep:" | " cells ^ " |\n") in
  let section title = add ("\n## " ^ title ^ "\n") in
  let details title render =
    let opening = "\n<details><summary>" ^ html title ^ "</summary>\n\n" in
    let closing = "\n</details>\n" in
    if
      Buffer.length output + String.length opening + String.length closing
      <= !limit
    then (
      add opening;
      let previous_limit = !limit in
      limit := !limit - String.length closing;
      render ();
      limit := previous_limit;
      add closing)
    else truncated := true
  in
  let context = field "context" snapshot in
  let evaluation = field "evaluation" snapshot in
  let jobs = deduplicate_jobs (items "jobs" snapshot) in
  let all_attrs = unique (List.concat_map jobs ~f:attrs) in
  let n state_name =
    List.length (List.filter jobs ~f:(fun job -> state job = state_name))
  in
  let local =
    List.length
      (List.filter jobs ~f:(fun job -> text "cacheStatus" job = "local"))
  in
  let remote =
    List.length
      (List.filter jobs ~f:(fun job -> text "cacheStatus" job = "cached"))
  in
  let failures = roots snapshot in
  let eval_errors = items "errors" evaluation in
  let uploads = items "uploads" snapshot in
  let cache_reuse = items "cacheReuse" snapshot in
  let failed_uploads =
    List.filter uploads ~f:(fun item -> state item = "failed")
  in
  let waits = items "waits" snapshot in
  let outcome =
    match text "status" snapshot with
    | "success" -> "Build succeeded"
    | "failure" | "failed" -> "Build failed"
    | "cancelled" -> "Build cancelled"
    | "planned" | "dry-run" -> "Build plan"
    | _ -> "Build in progress"
  in
  add
    ("# "
    ^ outcome
    ^ "\n\nStatus: "
    ^ code (nonempty "in progress" (text "status" snapshot))
    ^ "\n\n");
  let artifact = text "artifactUrl" context in
  if has_prefix "https://" artifact
  then add ("[Download full report and logs](<" ^ url artifact ^ ">)\n\n");
  add
    (Printf.sprintf
       "Evaluated **%d attributes**, **%d unique derivations**. Evaluation %s.\n\n"
       (max (count "attrs" evaluation) (List.length all_attrs))
       (List.length jobs)
       (if field "complete" evaluation = `Bool true
        then "complete"
        else "incomplete"));
  table
    [ "Built"; "Cached"; "Failed"; "Blocked"; "Evaluation errors"; "Elapsed" ];
  row
    [ string_of_int (n "built")
    ; string_of_int (n "cached")
    ; string_of_int (n "failed")
    ; string_of_int (n "blocked")
    ; string_of_int (List.length eval_errors)
    ; Option.fold ~none:"—" ~some:duration (run_seconds snapshot)
    ];
  if local + remote > 0
  then add (Printf.sprintf "\nCache hits: %d local, %d remote.\n" local remote);
  if failures <> [] || eval_errors <> [] || failed_uploads <> []
  then
    add
      (Printf.sprintf
         "\n\
          **%d root failures**, **%d evaluation errors**, **%d upload \
          failures**.\n"
         (List.length failures)
         (List.length eval_errors)
         (List.length failed_uploads));
  if cache_reuse <> []
  then
    add
      (Printf.sprintf
         "\n\
          Dependency cache imports: **%d imported**, **%d active**, **%d \
          warnings**, **%d cancelled**.\n"
         (count_state "imported" cache_reuse)
         (count_state "importing" cache_reuse)
         (count_state "failed" cache_reuse)
         (count_state "cancelled" cache_reuse));
  let error = text "error" snapshot in
  if error <> ""
  then (
    add ("\nRun error: " ^ code (error_cause error) ^ "\n");
    details "Run error details" (fun () ->
      add (pre (diagnostic_message ~limit:8192 error))));
  if failures <> []
  then (
    section "Root failures";
    List.iter (take 100 failures) ~f:(fun root ->
      let drv = text "drvPath" root in
      let affected = unique (strings (items "affected" root)) in
      let name = activity_name root in
      add
        ("\n### "
        ^ code name
        ^ " — "
        ^ code (failure_kind (text "kind" root))
        ^ "\n\n");
      add
        (Printf.sprintf
           "Affects **%d attributes**: %s%s\n\n"
           (List.length affected)
           (String.concat ~sep:", " (List.map (take 50 affected) ~f:code))
           (if List.length affected > 50
            then ", … (complete list in results.json)"
            else ""));
      add (code (diagnostic_message (text "message" root)) ^ "\n\n");
      if drv <> ""
      then (
        add
          ("Reproduce: "
          ^ code ("nix build --no-link -L " ^ shell_quote (drv ^ "^*"))
          ^ "\n\n");
        add ("Stored log: " ^ code ("nix log " ^ shell_quote drv) ^ "\n\n"));
      let log = log_reference context (text "logPath" root) in
      if log <> "" then add (log ^ "\n\n");
      let logs = excerpt root in
      if logs <> ""
      then
        add
          ("<details><summary>Bounded error excerpt</summary>\n\n"
          ^ pre logs
          ^ "\n</details>\n"));
    if List.length failures > 100
    then add "\nAdditional root failures are recorded in results.json.\n");
  if eval_errors <> []
  then (
    section "Evaluation errors";
    table [ "Attribute"; "Cause" ];
    List.iter (take 30 eval_errors) ~f:(fun error ->
      row [ code (text "attr" error); code (error_cause (text "error" error)) ]);
    details "Evaluation traces" (fun () ->
      List.iter (take 30 eval_errors) ~f:(fun error ->
        add ("\n### " ^ code (text "attr" error) ^ "\n\n");
        add (pre (diagnostic_message ~limit:8192 (text "error" error)))));
    if List.length eval_errors > 30
    then add "\nAdditional evaluation errors are recorded in results.json.\n");
  if failed_uploads <> []
  then (
    section "Upload failures";
    table [ "Output path"; "Time"; "Error" ];
    List.iter (take 30 failed_uploads) ~f:(fun upload ->
      row
        [ code (text "path" upload)
        ; elapsed "seconds" upload
        ; code (text "error" upload)
        ]));
  if cache_reuse <> []
  then
    details "Opportunistic dependency imports" (fun () ->
      add
        "\n\
         Import failures are warnings; normal builds continue. Counts and \
         timings describe cache imports, not measured build savings.\n";
      table [ "Dependency"; "State"; "Time"; "Needed by"; "Details" ];
      let priority imported =
        match state imported with
        | "failed" -> 0
        | "importing" -> 1
        | "imported" -> 2
        | _ -> 3
      in
      let visible =
        List.stable_sort cache_reuse ~cmp:(fun a b ->
          Int.compare (priority a) (priority b))
        |> take 30
      in
      List.iter visible ~f:(fun imported ->
        let paths = strings (items "paths" imported) in
        let needed = unique (strings (items "neededBy" imported)) in
        let compact values =
          String.concat ~sep:", " (List.map (take 5 values) ~f:code)
          ^
          if List.length values > 5
          then Printf.sprintf ", … (%d more)" (List.length values - 5)
          else ""
        in
        let details =
          [ (if text "source" imported = ""
             then ""
             else "Source: " ^ code (text "source" imported))
          ; (if paths = [] then "" else "Import paths: " ^ compact paths)
          ; (if text "error" imported = ""
             then ""
             else
               (if state imported = "failed" then "Warning: " else "Note: ")
               ^ code (text "error" imported))
          ; log_reference context (text "logPath" imported)
          ]
          |> List.filter ~f:(fun detail -> detail <> "")
          |> String.concat ~sep:"<br>"
        in
        row
          [ code (activity_name imported)
          ; code
              (if state imported = "failed"
               then "warning (import failed)"
               else state imported)
          ; elapsed "seconds" imported
          ; compact needed
          ; details
          ]);
      if List.length cache_reuse > 30
      then add "\nAdditional dependency imports are recorded in results.json.\n");
  let blocked = List.filter jobs ~f:(fun job -> state job = "blocked") in
  if blocked <> []
  then (
    section "Blocked packages";
    table [ "Package"; "Dependency path" ];
    List.iter (take 50 blocked) ~f:(fun job ->
      let path = strings (items "dependencyPath" (field "failure" job)) in
      row [ code (job_name job); code (String.concat ~sep:" → " path) ]));
  let unfinished =
    List.filter jobs ~f:(fun job ->
      List.mem (state job) ~set:[ "queued"; "submitted"; "cancelled" ])
  in
  if unfinished <> []
  then (
    section "Unfinished and cancelled packages";
    table [ "Package"; "State"; "Queue wait"; "Request time" ];
    List.iter (take 30 unfinished) ~f:(fun job ->
      row
        [ code (job_name job)
        ; code (state job)
        ; elapsed "queueSeconds" job
        ; elapsed "activeSeconds" job
        ]);
    if List.length unfinished > 30
    then add "\nAdditional unfinished packages are recorded in results.json.\n");
  let ranked_by seconds records =
    List.filter records ~f:(fun item -> seconds item > 0.)
    |> List.sort ~cmp:(fun a b -> Float.compare (seconds b) (seconds a))
    |> take 10
  in
  let ranked field_name =
    ranked_by (fun item -> number (field field_name item))
  in
  let slow = ranked_by activity_seconds (items "derivations" snapshot) in
  if slow <> []
  then (
    section "Slowest observed builds and downloads";
    add
      "\n\
       Observed Nix activity time, including any downloads; package request \
       time is reported separately.\n";
    table [ "Derivation or output"; "Kind"; "State"; "Phase"; "Time" ];
    List.iter slow ~f:(fun drv ->
      row
        [ code (activity_name drv)
        ; code (activity_kind drv)
        ; code (state drv)
        ; code (text "phase" drv)
        ; duration (activity_seconds drv)
        ]));
  let slow_requests = ranked "activeSeconds" jobs in
  if slow_requests <> []
  then
    details "Slowest package requests" (fun () ->
      add
        "\n\
         Request time can include Nix scheduling, dependency builds, and \
         downloads; it is not compilation time.\n";
      table
        [ "Package"; "Queue wait"; "Request time"; "Build time"; "Upload time" ];
      List.iter slow_requests ~f:(fun job ->
        row
          [ code (job_name job)
          ; elapsed "queueSeconds" job
          ; elapsed "activeSeconds" job
          ; elapsed "buildSeconds" job
          ; elapsed "uploadSeconds" job
          ]));
  let queue_waits =
    ranked
      "queueSeconds"
      (List.filter jobs ~f:(fun job ->
         state job <> "cached" && number (field "queueSeconds" job) >= 0.05))
  in
  if queue_waits <> []
  then
    details "Longest queue waits" (fun () ->
      table [ "Package"; "Wait" ];
      List.iter queue_waits ~f:(fun job ->
        row [ code (job_name job); elapsed "queueSeconds" job ]));
  details "Plan and cache activity" (fun () ->
    add
      (Printf.sprintf
         "\nNix lock waits: **%d active waits**.\n"
         (List.length waits));
    if waits <> []
    then (
      add
        "\n\
         These are request-level lock waits; a request may also be building \
         other derivations.\n";
      table [ "Request"; "Reason"; "Elapsed"; "Requested derivations" ];
      List.iter (take 20 waits) ~f:(fun wait ->
        row
          [ code (text "requestId" wait)
          ; code (wait_reason wait)
          ; elapsed "seconds" wait
          ; code (String.concat ~sep:", " (strings (items "drvs" wait)))
          ]));
    let plan = field "plan" snapshot in
    if plan <> `Null
    then (
      let downloads = items "downloads" plan in
      let known =
        List.filter downloads ~f:(fun download ->
          field "downloadSize" download <> `Null)
      in
      let bytes =
        List.fold_left known ~init:0. ~f:(fun total download ->
          total +. number (field "downloadSize" download))
      in
      add
        (Printf.sprintf
           "\n\
            Initial plan: **%d derivations to build**, **%d downloads**, **%d \
            unresolved outputs**.\n"
           (List.length (items "builds" plan))
           (List.length downloads)
           (List.length (items "unknown" plan)));
      if downloads <> []
      then
        add
          (Printf.sprintf
             "\n\
              Known compressed downloads: %.1f MiB; size unavailable for %d \
              paths.\n"
             (bytes /. 1048576.)
             (List.length downloads - List.length known))));
  (* Reserve space for context and totals even when many failures are large. *)
  limit := 900_000;
  let warnings = strings (items "warnings" snapshot) in
  if warnings <> []
  then (
    section "Warnings";
    List.iter (take 20 warnings) ~f:(fun warning ->
      add ("\n- " ^ code warning ^ "\n")));
  details "Context" (fun () ->
    table [ "Field"; "Value" ];
    List.iter
      [ "flake"
      ; "gitSha"
      ; "system"
      ; "startedAt"
      ; "finishedAt"
      ; "evaluationSeconds"
      ; "planningSeconds"
      ; "nixVersion"
      ; "nixEvalJobsVersion"
      ; "runUrl"
      ; "runAttempt"
      ; "jobs"
      ]
      ~f:(fun name ->
        let value =
          match name, field name context with
          | "system", `Null ->
            let systems =
              List.filter_map jobs ~f:(fun job ->
                match text "system" job with
                | "" -> None
                | system -> Some system)
              |> unique
            in
            if systems = []
            then `Null
            else `String (String.concat ~sep:", " systems)
          | _, value -> value
        in
        if value <> `Null && value <> `String ""
        then row [ code name; code (context_value name value) ]));
  let plan_diff = field "planDiff" snapshot in
  if plan_diff <> `Null
  then
    details "Plan comparison" (fun () ->
      add (pre (shorten ~limit:8192 (Yojson.Safe.pretty_to_string plan_diff))));
  let uploaded =
    List.length (List.filter uploads ~f:(fun item -> state item = "uploaded"))
  in
  let uploading =
    List.length (List.filter uploads ~f:(fun item -> state item = "uploading"))
  in
  let queued_uploads =
    List.length (List.filter uploads ~f:(fun item -> state item = "queued"))
  in
  let cancelled_uploads =
    List.length (List.filter uploads ~f:(fun item -> state item = "cancelled"))
  in
  if uploads <> []
  then
    add
      (Printf.sprintf
         "\n\
          Cache sync: %d complete, %d active, %d queued, %d failed, %d \
          cancelled. Completed syncs may already exist in the destination \
          cache.\n"
         uploaded
         uploading
         queued_uploads
         (List.length failed_uploads)
         cancelled_uploads);
  add
    "\n\
     Complete machine-readable results, chronological events, and logs are in \
     the report artifact. Reproduction commands require the derivation to \
     remain available in the Nix store.\n";
  if !truncated
  then
    Buffer.add_string
      output
      "\n\
       Report shortened to stay below GitHub's summary limit. Full details are \
       in results.json and the report logs.\n";
  Buffer.contents output

let is_active activity =
  let has_counts =
    List.exists [ "active"; "activeBuilds"; "activeDownloads" ] ~f:(fun name ->
      field name activity <> `Null)
  in
  if has_counts
  then
    List.exists [ "active"; "activeBuilds"; "activeDownloads" ] ~f:(fun name ->
      count name activity > 0)
  else
    field "finishedAt" activity = `Null
    && List.mem (state activity) ~set:[ "waiting"; "downloading"; "building" ]

let active_phase activity =
  if count "activeBuilds" activity > 0
  then "BUILD"
  else if count "activeDownloads" activity > 0
  then "FETCH"
  else
    match state activity with
    | "building" -> "BUILD"
    | "downloading" -> "FETCH"
    | _ -> "WAIT"

let render_progress snapshot =
  let jobs = deduplicate_jobs (items "jobs" snapshot) in
  let n name = count_state name jobs in
  let evaluation = field "evaluation" snapshot in
  let uploads = items "uploads" snapshot in
  let cache_reuse = items "cacheReuse" snapshot in
  let waits = items "waits" snapshot in
  let errors = List.length (items "errors" evaluation) in
  let completed =
    n "built" + n "cached" + n "failed" + n "blocked" + n "cancelled"
  in
  let head =
    if
      text "status" snapshot = "evaluating"
      || (text "status" snapshot = ""
         && field "complete" evaluation <> `Bool true)
    then
      status_line
        "EVAL"
        (Printf.sprintf
           "%d attributes evaluated · %d cached · %d derivations discovered%s"
           (count "attrs" evaluation)
           (n "cached")
           (List.length jobs)
           (if errors = 0
            then ""
            else Printf.sprintf " · %d evaluation errors" errors))
    else if text "status" snapshot = "planning"
    then
      status_line
        "PLAN"
        (Printf.sprintf
           "checking remaining dependencies · %d attributes · %d cached%s"
           (count "attrs" evaluation)
           (n "cached")
           (if errors = 0
            then ""
            else Printf.sprintf " · %d evaluation errors" errors))
    else
      status_line
        "STATUS"
        (Printf.sprintf
           "%d/%d complete · cached %d · built %d · requests %d · queued \
            %d%s%s%s"
           completed
           (List.length jobs)
           (n "cached")
           (n "built")
           (n "submitted")
           (n "queued")
           (if n "failed" + n "blocked" = 0
            then ""
            else
              Printf.sprintf
                " · failed %d · blocked %d"
                (n "failed")
                (n "blocked"))
           (if errors = 0
            then ""
            else Printf.sprintf " · %d evaluation errors" errors)
           (Option.fold
              ~none:""
              ~some:(fun seconds -> " · " ^ duration seconds ^ " elapsed")
              (run_seconds snapshot)))
  in
  let active =
    List.filter (items "derivations" snapshot) ~f:is_active
    |> List.stable_sort ~cmp:(fun a b ->
      let priority item =
        match active_phase item with "BUILD" -> 0 | "FETCH" -> 1 | _ -> 2
      in
      let order = Int.compare (priority a) (priority b) in
      if order <> 0
      then order
      else Float.compare (activity_seconds b) (activity_seconds a))
  in
  let lines =
    List.map (take 4 active) ~f:(fun activity ->
      status_line
        (active_phase activity)
        (display_name activity
        ^ (if text "phase" activity = ""
           then ""
           else " / " ^ single_line ~limit:60 (text "phase" activity))
        ^ " ("
        ^ duration (activity_seconds activity)
        ^ ")"
        ^ consumers activity))
  in
  let more =
    if List.length active > 4
    then
      [ status_line
          "ACTIVE"
          (Printf.sprintf
             "%d more builds/downloads/waits"
             (List.length active - 4))
      ]
    else []
  in
  let wait_lines =
    List.map (take 2 waits) ~f:(fun wait ->
      status_line
        "WAIT"
        (single_line ~limit:160 (wait_reason wait)
        ^ " ("
        ^ elapsed "seconds" wait
        ^ ") · request "
        ^ single_line ~limit:60 (text "requestId" wait)))
  in
  let import_lines =
    List.filter cache_reuse ~f:(fun imported -> state imported = "importing")
    |> List.stable_sort ~cmp:(fun a b ->
      Float.compare (number (field "seconds" b)) (number (field "seconds" a)))
    |> take 2
    |> List.map ~f:(fun imported ->
      status_line
        "IMPORT"
        (display_name imported
        ^ " ("
        ^ elapsed "seconds" imported
        ^ ")"
        ^ consumers imported))
  in
  let background =
    let parts =
      [ (if uploads = []
         then ""
         else
           Printf.sprintf
             "cache sync %d/%d (%d active, %d failed)"
             (count_state "uploaded" uploads)
             (List.length uploads)
             (count_state "uploading" uploads)
             (count_state "failed" uploads))
      ; (if cache_reuse = []
         then ""
         else
           Printf.sprintf
             "cache imports %d (%d active, %d warnings)"
             (count_state "imported" cache_reuse)
             (count_state "importing" cache_reuse)
             (count_state "failed" cache_reuse))
      ; (if waits = []
         then ""
         else Printf.sprintf "Nix lock waits: %d" (List.length waits))
      ]
      |> List.filter ~f:(fun value -> value <> "")
    in
    if parts = []
    then []
    else [ status_line "CACHE" (String.concat ~sep:" · " parts) ]
  in
  [ head ] @ lines @ more @ wait_lines @ import_lines @ background

let workflow_escape ~property value =
  let output = Buffer.create (String.length value) in
  String.iter value ~f:(function
    | '%' -> Buffer.add_string output "%25"
    | '\r' -> Buffer.add_string output "%0D"
    | '\n' -> Buffer.add_string output "%0A"
    | ':' when property -> Buffer.add_string output "%3A"
    | ',' when property -> Buffer.add_string output "%2C"
    | c -> Buffer.add_char output c);
  Buffer.contents output

let contains value part =
  let rec loop pos =
    pos + String.length part <= String.length value
    && (String.sub value ~pos ~len:(String.length part) = part || loop (pos + 1))
  in
  loop 0

let protected_log value =
  let rec token n =
    let candidate =
      "nix-ci-build-" ^ Digest.to_hex (Digest.string (string_of_int n ^ value))
    in
    if contains value candidate then token (n + 1) else candidate
  in
  let token = token 0 in
  "::stop-commands::" ^ token ^ "\n" ^ value ^ "\n::" ^ token ^ "::\n"

let render_event ?(verbose = false) ?(color = false) event =
  let kind = nonempty (text "kind" event) (text "type" event) in
  let name = nonempty "Nix request" (display_name event) in
  let raw_message = nonempty (text "error" event) (text "message" event) in
  let message = single_line ~limit:300 raw_message in
  let timing =
    if field "seconds" event = `Null
    then ""
    else " (" ^ elapsed "seconds" event ^ ")"
  in
  let detail = if message = "" then "" else ": " ^ message in
  let line label value = Some (status_line ~color label value) in
  match kind, state event with
  | "job", "submitted" -> line "REQUEST" name
  | "job", "built" -> line "DONE" (name ^ timing)
  | "job", "failed" -> line "FAIL" (name ^ detail)
  | "job", "blocked" -> line "BLOCKED" (name ^ detail)
  | "job", "cancelled" -> line "CANCEL" name
  | "activity-start", "building" -> line "BUILD" (name ^ consumers event)
  | "retry", _ ->
    let names =
      strings (items "drvs" event) |> take 3 |> List.map ~f:short_path
    in
    line
      "RETRY"
      ((if names = [] then name else single_line (String.concat ~sep:", " names))
      ^ detail)
  | "upload-retry", _ -> line "RETRY" ("cache sync " ^ name ^ detail)
  | "upload", "failed" -> line "WARN" ("cache sync " ^ name ^ detail)
  | "cache-import-start", _ -> line "IMPORT" (name ^ consumers event)
  | "cache-import-finished", "imported" -> line "REUSED" (name ^ timing)
  | "cache-import-finished", "failed" ->
    line "WARN" ("cache import " ^ name ^ detail ^ "; normal build continues")
  | "warning", _ -> line "WARN" message
  | ("evaluation-error" | "eval-error"), _ ->
    line
      "FAIL"
      ("evaluation "
      ^ nonempty name (single_line (text "attr" event))
      ^ if raw_message = "" then "" else ": " ^ error_cause raw_message)
  | _ when verbose ->
    line "DEBUG" (single_line ~limit:1800 (Yojson.Safe.to_string event))
  | _ -> None

let render_failure_with_annotation
      ?(color = false)
      ~github_actions
      ~annotation
      root
  =
  let name = activity_name root |> shorten ~limit:300 |> clean_terminal in
  let message = diagnostic_message (text "message" root) in
  let title = failure_kind (text "kind" root) ^ " failure: " ^ name in
  let logs =
    excerpt root
    |> clean_terminal
    |> String.split_on_char ~sep:'\n'
    |> take 20
    |> String.concat ~sep:"\n"
    |> shorten ~limit:4096
  in
  let affected = unique (strings (items "affected" root)) in
  let details =
    message
    ^ (if affected = []
       then ""
       else
         "\nAffects "
         ^ string_of_int (List.length affected)
         ^ " attributes: "
         ^ String.concat ~sep:", " (take 8 affected)
         ^ if List.length affected > 8 then ", …" else "")
    ^ (if text "drvPath" root = ""
       then ""
       else
         "\nReproduce: nix build --no-link -L "
         ^ shell_quote (text "drvPath" root ^ "^*"))
    ^ (if text "logPath" root = "" then "" else "\nLog: " ^ text "logPath" root)
    ^ if logs = "" then "" else "\n\n" ^ logs
  in
  if github_actions
  then
    let annotation =
      if annotation
      then
        "::error title="
        ^ workflow_escape ~property:true title
        ^ "::"
        ^ workflow_escape ~property:false (error_cause (text "message" root))
        ^ "\n"
      else ""
    in
    annotation
    ^ "::group::"
    ^ workflow_escape ~property:false title
    ^ "\n"
    ^ protected_log details
    ^ "::endgroup::\n"
  else status_line ~color "FAIL" (single_line title) ^ "\n" ^ details ^ "\n"

let render_failure ~github_actions root =
  render_failure_with_annotation ~github_actions ~annotation:true root

let rec ensure_directory path =
  if path <> "" && path <> "." && not (Sys.file_exists path)
  then (
    ensure_directory (Filename.dirname path);
    Unix.mkdir path 0o700)
  else if Sys.file_exists path && not (Sys.is_directory path)
  then invalid_arg (path ^ " is not a directory")

let atomic_write path contents =
  let directory = Filename.dirname path in
  ensure_directory directory;
  let temporary, channel =
    Filename.open_temp_file ~temp_dir:directory ".nix-ci-build-" ".tmp"
  in
  try
    output_string channel contents;
    flush channel;
    close_out channel;
    Unix.rename temporary path
  with
  | exn ->
    close_out_noerr channel;
    (try Sys.remove temporary with Sys_error _ -> ());
    raise exn

type t =
  { directory : string
  ; summary_output : string option
  ; github_actions : bool
  ; color : bool
  ; verbose : bool
  ; events : out_channel
  ; mutable closed : bool
  ; mutable reported : StringSet.t
  ; mutable annotations : int
  }

let create
      ?(verbose = false)
      ?color
      ~directory
      ~summary_output
      ~github_actions
      ()
  =
  ensure_directory directory;
  let events =
    open_out_gen
      [ Open_wronly; Open_creat; Open_append; Open_binary ]
      0o600
      (Filename.concat directory "events.jsonl")
  in
  { directory
  ; summary_output
  ; github_actions
  ; color = Option.value color ~default:github_actions
  ; verbose
  ; events
  ; closed = false
  ; reported = StringSet.empty
  ; annotations = 0
  }

let directory t = t.directory

let append_event t event =
  if t.closed then invalid_arg "Report.append_event: report is closed";
  output_string t.events (Yojson.Safe.to_string event);
  output_char t.events '\n';
  flush t.events

let write_snapshot t snapshot =
  atomic_write
    (Filename.concat t.directory "results.json")
    (Yojson.Safe.pretty_to_string snapshot ^ "\n");
  atomic_write
    (Filename.concat t.directory "summary.md")
    (render_summary snapshot)

let console t value =
  output_string
    stdout
    (if t.github_actions && contains value "::"
     then protected_log value
     else value ^ "\n");
  flush stdout

let emit_event t event =
  Option.iter (console t) (render_event ~verbose:t.verbose ~color:t.color event)

let emit_progress t snapshot =
  render_progress snapshot
  |> List.map ~f:(fun line ->
    if t.color && String.length line >= 8
    then
      status_line
        ~color:true
        (String.trim (String.sub line ~pos:0 ~len:7))
        (String.sub line ~pos:8 ~len:(String.length line - 8))
    else line)
  |> String.concat ~sep:"\n"
  |> console t

let emit_failure t failure =
  let key = failure_key failure in
  if not (StringSet.mem key t.reported)
  then (
    t.reported <- StringSet.add key t.reported;
    let annotation = t.annotations < 10 in
    if annotation then t.annotations <- t.annotations + 1;
    output_string
      stdout
      (render_failure_with_annotation
         ~color:t.color
         ~github_actions:t.github_actions
         ~annotation
         failure);
    flush stdout)

let emit_evaluation_errors t snapshot =
  let errors = items "errors" (field "evaluation" snapshot) in
  List.iter (take 5 errors) ~f:(fun error ->
    emit_failure
      t
      (`Assoc
          [ "kind", `String "evaluation"
          ; "name", `String (nonempty "flake evaluation" (text "attr" error))
          ; "message", `String (text "error" error)
          ]));
  let key = "evaluation-errors-omitted" in
  if List.length errors > 5 && not (StringSet.mem key t.reported)
  then (
    t.reported <- StringSet.add key t.reported;
    console
      t
      (status_line
         ~color:t.color
         "ERROR"
         (Printf.sprintf
            "%d more evaluation errors; see summary.md and results.json"
            (List.length errors - 5))))

let emit_plan t snapshot =
  let jobs = deduplicate_jobs (items "jobs" snapshot) in
  let plan = field "plan" snapshot in
  let builds = items "builds" plan in
  let downloads = items "downloads" plan in
  let errors = List.length (items "errors" (field "evaluation" snapshot)) in
  console
    t
    (status_line
       ~color:t.color
       (if errors > 0 then "WARN" else "PLAN")
       (Printf.sprintf
          "%s%d attributes · %d cached · %d queued · %d builds · %d \
           downloads%s%s"
          (if errors > 0 then "plan: " else "")
          (count "attrs" (field "evaluation" snapshot))
          (count_state "cached" jobs)
          (count_state "queued" jobs)
          (List.length builds)
          (List.length downloads)
          (if items "unknown" plan = []
           then ""
           else
             Printf.sprintf
               " · %d unresolved outputs"
               (List.length (items "unknown" plan)))
          (if errors = 0
           then ""
           else Printf.sprintf " · %d evaluation errors" errors)));
  (if builds <> [] || downloads <> []
   then
     let known =
       List.filter downloads ~f:(fun item -> field "downloadSize" item <> `Null)
     in
     let bytes =
       List.fold_left known ~init:0. ~f:(fun n item ->
         n +. number (field "downloadSize" item))
     in
     let body =
       (List.map (take 12 builds) ~f:(fun item -> "Build  " ^ display_name item)
       @ (if List.length builds > 12
          then
            [ Printf.sprintf
                "… %d more derivations in plan.json"
                (List.length builds - 12)
            ]
          else [])
       @
       if downloads = []
       then []
       else
         [ Printf.sprintf
             "Fetch  %d paths · %.1f MiB known compressed size · %d unknown \
              sizes"
             (List.length downloads)
             (bytes /. 1048576.)
             (List.length downloads - List.length known)
         ])
       |> String.concat ~sep:"\n"
     in
     if t.github_actions
     then (
       (* A whole group is one write: parallel build streams cannot leave it
          open. *)
       output_string
         stdout
         ("::group::Build plan details\n"
         ^ protected_log body
         ^ "::endgroup::\n");
       flush stdout)
     else if t.verbose
     then console t body);
  emit_evaluation_errors t snapshot

let finish t snapshot =
  write_snapshot t snapshot;
  List.iter (roots snapshot) ~f:(emit_failure t);
  emit_evaluation_errors t snapshot;
  if text "error" snapshot <> ""
  then
    emit_failure
      t
      (`Assoc
          [ "kind", `String "run"
          ; "name", `String "nix-ci-build"
          ; "message", `String (text "error" snapshot)
          ]);
  let failed_uploads =
    List.filter (items "uploads" snapshot) ~f:(fun upload ->
      state upload = "failed")
  in
  List.iter (take 5 failed_uploads) ~f:(fun upload ->
    emit_failure
      t
      (`Assoc
          [ "kind", `String "upload"
          ; "name", `String (short_path (text "path" upload))
          ; "message", `String (text "error" upload)
          ; "logPath", field "logPath" upload
          ]));
  let jobs = deduplicate_jobs (items "jobs" snapshot) in
  let label =
    match text "status" snapshot with
    | "failure" | "failed" -> "FAIL"
    | "cancelled" -> "CANCEL"
    | "planned" | "dry-run" -> "PLAN"
    | "success" -> "DONE"
    | _ -> "STATUS"
  in
  console
    t
    (status_line
       ~color:t.color
       label
       (Printf.sprintf
          "%d built · %d cached · %d failed · %d blocked%s%s%s%s%s%s"
          (count_state "built" jobs)
          (count_state "cached" jobs)
          (count_state "failed" jobs)
          (count_state "blocked" jobs)
          (let count =
             List.length (items "errors" (field "evaluation" snapshot))
           in
           if count = 0
           then ""
           else Printf.sprintf " · %d evaluation errors" count)
          (if failed_uploads = []
           then ""
           else
             Printf.sprintf
               " · %d cache sync failures"
               (List.length failed_uploads))
          (let count = count_state "cancelled" jobs in
           if count = 0 then "" else Printf.sprintf " · %d cancelled" count)
          (let count = count_state "queued" jobs in
           if count = 0 then "" else Printf.sprintf " · %d queued" count)
          (let count = count_state "submitted" jobs in
           if count = 0
           then ""
           else Printf.sprintf " · %d active requests" count)
          (Option.fold
             ~none:""
             ~some:(fun seconds -> " · " ^ duration seconds ^ " elapsed")
             (run_seconds snapshot))));
  let summary = render_summary snapshot in
  match t.summary_output with
  | Some path -> atomic_write path summary
  | None ->
    console
      t
      (status_line
         ~color:t.color
         "REPORT"
         (single_line ~limit:240 (Filename.concat t.directory "summary.md")))

let close t =
  if not t.closed
  then (
    t.closed <- true;
    close_out t.events)
