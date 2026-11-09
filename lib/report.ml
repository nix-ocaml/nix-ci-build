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
  | "upload" -> "Upload"
  | "build" -> "Build"
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
  add
    ("# Package build report\n\nStatus: "
    ^ code (nonempty "in progress" (text "status" snapshot))
    ^ "\n\n");
  add
    (Printf.sprintf
       "Evaluated **%d attributes**, **%d unique derivations**. Evaluation %s.\n\n"
       (max (count "attrs" evaluation) (List.length all_attrs))
       (List.length jobs)
       (if field "complete" evaluation = `Bool true
        then "complete"
        else "incomplete"));
  table
    [ "Built"
    ; "Local cache"
    ; "Remote cache"
    ; "Failed"
    ; "Blocked"
    ; "Cancelled"
    ; "Queued"
    ; "Submitted"
    ];
  row
    (List.map
       [ n "built"
       ; local
       ; remote
       ; n "failed"
       ; n "blocked"
       ; n "cancelled"
       ; n "queued"
       ; n "submitted"
       ]
       ~f:string_of_int);
  add
    (Printf.sprintf
       "\n\
        **%d root failures**, **%d evaluation errors**, **%d upload failures**.\n"
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
  if error <> "" then add ("\nRun error: " ^ code error ^ "\n");
  add
    (Printf.sprintf
       "\nNix lock waits: **%d active waits**.\n"
       (List.length waits));
  if waits <> []
  then (
    section "Nix lock waits";
    add
      "\n\
       These are request-level lock waits; the same request may also be \
       building other derivations.\n";
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
            Known compressed downloads: %.1f MiB; size unavailable for %d paths.\n"
           (bytes /. 1048576.)
           (List.length downloads - List.length known)));
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
      add (code (text "message" root) ^ "\n\n");
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
    table [ "Attribute"; "Error" ];
    List.iter (take 30 eval_errors) ~f:(fun error ->
      row [ code (text "attr" error); code (text "error" error) ]));
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
  then (
    section "Opportunistic dependency imports";
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
  then (
    section "Slowest package requests";
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
  let queue_waits = ranked "queueSeconds" jobs in
  if queue_waits <> []
  then (
    section "Longest queue waits";
    table [ "Package"; "Wait" ];
    List.iter queue_waits ~f:(fun job ->
      row [ code (job_name job); elapsed "queueSeconds" job ]));
  (* Reserve space for context and totals even when many failures are large. *)
  limit := 900_000;
  let warnings = strings (items "warnings" snapshot) in
  if warnings <> []
  then (
    section "Warnings";
    List.iter (take 20 warnings) ~f:(fun warning ->
      add ("\n- " ^ code warning ^ "\n")));
  section "Context";
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
              match text "system" job with "" -> None | system -> Some system)
            |> unique
          in
          if systems = []
          then `Null
          else `String (String.concat ~sep:", " systems)
        | _, value -> value
      in
      if value <> `Null then row [ code name; code (context_value name value) ]);
  let plan_diff = field "planDiff" snapshot in
  if plan_diff <> `Null
  then (
    section "Plan comparison";
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
  add
    (Printf.sprintf
       "\n\
        Uploads: %d complete, %d active, %d queued, %d failed, %d cancelled.\n"
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

let render_progress snapshot =
  let jobs = deduplicate_jobs (items "jobs" snapshot) in
  let n name =
    List.length (List.filter jobs ~f:(fun job -> state job = name))
  in
  let evaluation = field "evaluation" snapshot in
  let uploads = items "uploads" snapshot in
  let cache_reuse = items "cacheReuse" snapshot in
  let waits = items "waits" snapshot in
  let uploads_in name =
    List.length (List.filter uploads ~f:(fun upload -> state upload = name))
  in
  let head =
    Printf.sprintf
      "evaluated %d attrs / %d derivations%s | cached %d | built %d | requests \
       %d | queued %d | failed %d | blocked %d | Nix lock waits: %d | uploads \
       %d/%d (%d active, %d failed) | cache imports %d (%d active, %d \
       warnings)"
      (max
         (count "attrs" evaluation)
         (List.length (unique (List.concat_map jobs ~f:attrs))))
      (List.length jobs)
      (if field "complete" evaluation = `Bool true then "" else " (evaluating)")
      (n "cached")
      (n "built")
      (n "submitted")
      (n "queued")
      (n "failed")
      (n "blocked")
      (List.length waits)
      (uploads_in "uploaded")
      (List.length uploads)
      (uploads_in "uploading")
      (uploads_in "failed")
      (count_state "imported" cache_reuse)
      (count_state "importing" cache_reuse)
      (count_state "failed" cache_reuse)
  in
  let active =
    List.filter (items "derivations" snapshot) ~f:(fun drv ->
      List.mem (state drv) ~set:[ "waiting"; "downloading"; "building" ])
  in
  let lines =
    List.map (take 5 active) ~f:(fun drv ->
      let name = activity_name drv in
      let needed = strings (items "neededBy" drv) in
      Printf.sprintf
        "  %s %s%s%s%s"
        (state drv)
        (shorten ~limit:160 (clean_terminal name))
        (if text "phase" drv = ""
         then ""
         else " / " ^ shorten ~limit:80 (clean_terminal (text "phase" drv)))
        (if
           field "seconds" drv = `Null
           && field "buildSeconds" drv = `Null
           && field "downloadSeconds" drv = `Null
         then ""
         else " (" ^ duration (activity_seconds drv) ^ ")")
        (if needed = []
         then ""
         else
           " → "
           ^ shorten
               ~limit:200
               (clean_terminal (String.concat ~sep:", " (take 3 needed)))))
  in
  let more =
    if List.length active > 5
    then
      [ Printf.sprintf
          "  … %d more active dependency requests"
          (List.length active - 5)
      ]
    else []
  in
  let wait_lines =
    List.map (take 3 waits) ~f:(fun wait ->
      Printf.sprintf
        "  Nix lock wait: %s (%s), request %s"
        (shorten ~limit:240 (clean_terminal (wait_reason wait)))
        (elapsed "seconds" wait)
        (shorten ~limit:80 (clean_terminal (text "requestId" wait))))
  in
  let import_lines =
    List.filter cache_reuse ~f:(fun imported -> state imported = "importing")
    |> take 2
    |> List.map ~f:(fun imported ->
      let needed = strings (items "neededBy" imported) in
      Printf.sprintf
        "  cache import %s (%s)%s"
        (shorten ~limit:160 (clean_terminal (activity_name imported)))
        (elapsed "seconds" imported)
        (if needed = []
         then ""
         else
           " → "
           ^ shorten
               ~limit:200
               (clean_terminal (String.concat ~sep:", " (take 3 needed)))))
  in
  (head :: lines) @ more @ wait_lines @ import_lines

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

let render_failure_with_annotation ~github_actions ~annotation root =
  let name = activity_name root |> shorten ~limit:300 |> clean_terminal in
  let message = text "message" root |> shorten ~limit:2000 |> clean_terminal in
  let title = failure_kind (text "kind" root) ^ " failure: " ^ name in
  let logs = excerpt root |> clean_terminal in
  if github_actions
  then
    let annotation =
      if annotation
      then
        "::error title="
        ^ workflow_escape ~property:true title
        ^ "::"
        ^ workflow_escape ~property:false message
        ^ "\n"
      else ""
    in
    annotation
    ^ "::group::"
    ^ workflow_escape ~property:false title
    ^ "\n"
    ^ protected_log (message ^ if logs = "" then "" else "\n" ^ logs)
    ^ "::endgroup::\n"
  else title ^ "\n" ^ message ^ if logs = "" then "\n" else "\n" ^ logs ^ "\n"

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
  ; events : out_channel
  ; mutable closed : bool
  ; mutable reported : StringSet.t
  ; mutable annotations : int
  }

let create ~directory ~summary_output ~github_actions =
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

let emit_progress t snapshot =
  let value = String.concat ~sep:"\n" (render_progress snapshot) in
  (* Progress contains names from package metadata, so protect it as well. *)
  let value =
    if t.github_actions && contains value "::"
    then protected_log value
    else value ^ "\n"
  in
  output_string stdout value;
  flush stdout

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
         ~github_actions:t.github_actions
         ~annotation
         failure);
    flush stdout)

let finish t snapshot =
  write_snapshot t snapshot;
  List.iter (roots snapshot) ~f:(emit_failure t);
  let summary = render_summary snapshot in
  match t.summary_output with
  | Some path -> atomic_write path summary
  | None ->
    output_string
      stdout
      (if t.github_actions && contains summary "::"
       then protected_log summary
       else summary);
    flush stdout

let close t =
  if not t.closed
  then (
    t.closed <- true;
    close_out t.events)
