(* This report intentionally consumes saved evidence only. It must remain useful
   after a runner disappears, and must not turn missing evidence into
   success. *)
let field = Json.member
let text key value = Json.string (field key value)
let items key value = Json.list (field key value)
let strings key value = Json.strings (field key value)
let unique values = List.sort_uniq values ~cmp:String.compare
let assoc fields = `Assoc fields

let number = function
  | `Float n when Float.is_finite n -> Some n
  | `Int n -> Some (float_of_int n)
  | _ -> None

let numeric key value = number (field key value)
let float value = Json.optional (fun n -> `Float n) value

let first values =
  List.find_opt values ~f:(fun value -> value <> "") |> Option.value ~default:""

let first_number values = List.find_map values ~f:Fun.id

let min_number values =
  match List.filter_map values ~f:Fun.id with
  | [] -> None
  | values -> Some (List.fold_left values ~init:infinity ~f:min)

let max_number values =
  match List.filter_map values ~f:Fun.id with
  | [] -> None
  | values -> Some (List.fold_left values ~init:neg_infinity ~f:max)

let duration start finish =
  match start, finish with
  | Some a, Some b when b >= a -> Some (b -. a)
  | _ -> None

let write_text path contents =
  let temporary = path ^ ".tmp" in
  let channel = open_out_bin temporary in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () ->
       output_string channel contents;
       flush channel);
  Unix.rename temporary path

let html_escape value =
  let buffer = Buffer.create (String.length value) in
  String.iter value ~f:(function
    | '&' -> Buffer.add_string buffer "&amp;"
    | '<' -> Buffer.add_string buffer "&lt;"
    | '>' -> Buffer.add_string buffer "&gt;"
    | '"' -> Buffer.add_string buffer "&quot;"
    | '\'' -> Buffer.add_string buffer "&#39;"
    | '|' -> Buffer.add_string buffer "&#124;"
    | '\n' | '\r' -> Buffer.add_char buffer ' '
    | c -> Buffer.add_char buffer c);
  Buffer.contents buffer

(* JSON embedded in a script element needs HTML-safe '<', even when the script
   has an inert MIME type. JSON escaping alone does not stop </script>. *)
let embedded_json json =
  let buffer = Buffer.create 4096 in
  String.iter (Yojson.Safe.to_string json) ~f:(function
    | '<' -> Buffer.add_string buffer "\\u003c"
    | '>' -> Buffer.add_string buffer "\\u003e"
    | '&' -> Buffer.add_string buffer "\\u0026"
    | c -> Buffer.add_char buffer c);
  Buffer.contents buffer

type reader =
  { mutable bytes : int
  ; mutable files : int
  ; mutable events : int
  ; mutable diagnostics : string list
  }

let warn reader message = reader.diagnostics <- message :: reader.diagnostics
let max_file = 32 * 1024 * 1024
let max_total = 192 * 1024 * 1024

let regular path =
  try (Unix.lstat path).st_kind = Unix.S_REG with Unix.Unix_error _ -> false

let read_file reader path =
  if not (regular path)
  then None
  else
    try
      let size = (Unix.stat path).st_size in
      if
        size > max_file
        || reader.bytes + size > max_total
        || reader.files >= 20000
      then (
        warn reader ("Report input limit reached; omitted " ^ path);
        None)
      else (
        reader.bytes <- reader.bytes + size;
        reader.files <- reader.files + 1;
        let channel = open_in_bin path in
        Some
          (Fun.protect
             ~finally:(fun () -> close_in_noerr channel)
             (fun () -> really_input_string channel (in_channel_length channel))))
    with
    | exn ->
      warn reader ("Cannot read " ^ path ^ ": " ^ Printexc.to_string exn);
      None

let read_json reader path =
  match read_file reader path with
  | None -> `Null
  | Some contents ->
    (try Yojson.Safe.from_string contents with
    | exn ->
      warn reader ("Invalid JSON in " ^ path ^ ": " ^ Printexc.to_string exn);
      `Null)

let read_events reader path =
  match read_file reader path with
  | None -> []
  | Some contents ->
    String.split_on_char ~sep:'\n' contents
    |> List.mapi ~f:(fun index line ->
      if String.trim line = ""
      then None
      else if reader.events >= 300000
      then (
        if reader.events = 300000
        then warn reader "Event limit reached; report is partial";
        reader.events <- reader.events + 1;
        None)
      else (
        reader.events <- reader.events + 1;
        try Some (Yojson.Safe.from_string line) with
        | _ ->
          warn reader (Printf.sprintf "Invalid event at %s:%d" path (index + 1));
          None))
    |> List.filter_map ~f:Fun.id

let report_names =
  [ "execution.json"
  ; "execution-error.json"
  ; "results.json"
  ; "execution-events.jsonl"
  ; "bootstrap.json"
  ]

let discover reader root =
  let visited = ref 0 in
  let rec walk depth relative =
    let path = if relative = "" then root else Filename.concat root relative in
    try
      if (Unix.lstat path).st_kind <> Unix.S_DIR
      then []
      else if depth > 12 || !visited >= 10000
      then (
        warn reader ("Directory discovery limit reached at " ^ path);
        [])
      else (
        incr visited;
        let names =
          Array.to_list (Sys.readdir path) |> List.sort ~cmp:String.compare
        in
        let current =
          if
            List.exists report_names ~f:(fun name ->
              regular (Filename.concat path name))
          then [ relative, path ]
          else []
        in
        current
        @ List.concat_map names ~f:(fun name ->
          if List.mem name ~set:[ ".git"; "logs"; "store"; "node_modules" ]
          then []
          else
            walk
              (depth + 1)
              (if relative = "" then name else Filename.concat relative name)))
    with
    | Unix.Unix_error (Unix.ENOENT, _, _) -> []
    | exn ->
      warn reader ("Cannot inspect " ^ path ^ ": " ^ Printexc.to_string exn);
      []
  in
  walk 0 ""

let identity key execution result events bootstrap =
  first
    ([ text key execution
     ; text key (field "context" execution)
     ; text key (field "context" result)
     ; text key bootstrap
     ]
    @ List.map events ~f:(text key))

let phase_intervals events bootstrap =
  let starts = Hashtbl.create 8 in
  let completed = ref [] in
  let interval phase start finish =
    let started = numeric "time" start in
    let elapsed =
      duration (numeric "elapsed" start) (numeric "elapsed" finish)
    in
    let seconds =
      first_number
        [ numeric "durationSeconds" finish
        ; elapsed
        ; duration started (numeric "time" finish)
        ]
    in
    let finished =
      match started, seconds with
      | Some t, Some seconds when seconds >= 0. -> Some (t +. seconds)
      | _ -> numeric "time" finish
    in
    assoc
      [ "phase", `String phase
      ; "startedAt", float started
      ; "finishedAt", float finished
      ; "durationSeconds", float seconds
      ; "status", `String (first [ text "status" finish; "incomplete" ])
      ]
  in
  List.iter events ~f:(fun event ->
    let phase = text "phase" event in
    match text "type" event with
    | "phase_start" when phase <> "" ->
      (match Hashtbl.find_opt starts phase with
      | Some start -> completed := interval phase start `Null :: !completed
      | None -> ());
      Hashtbl.replace starts phase event
    | "phase_finish" when phase <> "" ->
      let start = Option.value (Hashtbl.find_opt starts phase) ~default:`Null in
      Hashtbl.remove starts phase;
      completed := interval phase start event :: !completed
    | _ -> ());
  Hashtbl.iter
    (fun phase start -> completed := interval phase start `Null :: !completed)
    starts;
  (if bootstrap <> `Null
   then
     let started = numeric "startedAt" bootstrap in
     let finished = numeric "finishedAt" bootstrap in
     if started <> None || finished <> None
     then
       completed :=
         assoc
           [ "phase", `String "bootstrap"
           ; "startedAt", float started
           ; "finishedAt", float finished
           ; ( "durationSeconds"
             , float
                 (first_number
                    [ numeric "durationSeconds" bootstrap
                    ; duration started finished
                    ]) )
           ; "status", `String (first [ text "status" bootstrap; "unknown" ])
           ]
         :: !completed);
  List.sort !completed ~cmp:(fun a b ->
    Stdlib.compare (numeric "startedAt" a) (numeric "startedAt" b))

let failed status =
  List.mem status ~set:[ "failed"; "failure"; "cancelled"; "blocked" ]

let attempt
      ~bad_evidence
      ~relative
      execution
      result
      error
      bootstrap
      events
      engine_events
  =
  let context = field "context" result in
  let identities = events @ engine_events in
  let group_id =
    first
      [ identity "groupId" execution result identities bootstrap
      ; text "group" execution
      ; (let flake = text "flake" context in
         let prefix = "execution-plan#" in
         if String.starts_with flake ~prefix
         then
           String.sub
             flake
             ~pos:(String.length prefix)
             ~len:(String.length flake - String.length prefix)
         else "")
      ]
  in
  let attempt_id =
    first
      [ identity "attemptId" execution result identities bootstrap
      ; "legacy:" ^ relative
      ]
  in
  let run_id =
    first [ identity "runId" execution result identities bootstrap; "legacy" ]
  in
  let terminal =
    List.filter events ~f:(fun event -> text "type" event = "attempt_finish")
  in
  let terminal_statuses = List.map terminal ~f:(text "status") in
  let explicit_statuses =
    text "status" execution :: text "status" bootstrap :: terminal_statuses
  in
  let status =
    if
      error <> `Null
      || List.exists explicit_statuses ~f:failed
      || failed (text "status" result)
      || List.exists events ~f:(fun event ->
        text "type" event = "phase_finish" && failed (text "status" event))
      || List.exists (items "jobs" result) ~f:(fun job ->
        failed (text "state" job))
    then "failed"
    else if bad_evidence
    then "incomplete"
    else if
      text "status" execution = "success"
      || List.mem "success" ~set:terminal_statuses
    then "success"
    else "incomplete"
  in
  let attempt_start =
    List.find_opt events ~f:(fun event -> text "type" event = "attempt_start")
  in
  let started =
    first_number
      [ numeric "startedAt" execution
      ; Option.bind attempt_start (numeric "time")
      ; numeric "startedAt" context
      ; numeric "startedAt" bootstrap
      ]
  in
  let finished =
    first_number
      [ numeric "finishedAt" execution
      ; max_number (List.map terminal ~f:(numeric "time"))
      ; numeric "finishedAt" context
      ; numeric "finishedAt" bootstrap
      ]
  in
  let phases = phase_intervals events bootstrap in
  let built =
    items "derivations" result
    |> List.filter ~f:(fun drv -> text "state" drv = "built")
    |> List.map ~f:(text "drvPath")
    |> List.filter ~f:(( <> ) "")
    |> unique
  in
  let cached =
    items "jobs" result
    |> List.filter ~f:(fun job -> text "state" job = "cached")
    |> List.map ~f:(text "drvPath")
    |> List.filter ~f:(( <> ) "")
    |> unique
  in
  let errors =
    [ text "error" execution
    ; text "error" error
    ; text "message" error
    ; text "error" result
    ; text "error" bootstrap
    ]
    @ List.map terminal ~f:(text "error")
    @ List.map (items "rootFailures" result) ~f:(fun failure ->
      text "message" failure)
    |> List.filter ~f:(( <> ) "")
    |> unique
  in
  let metrics =
    [ ( "builtDerivations"
      , if result = `Null then `Null else `Int (List.length built) )
    ; ( "cachedRootDerivations"
      , if result = `Null then `Null else `Int (List.length cached) )
    ; ( "importedOutputs"
      , if field "imported" execution = `Null
        then `Null
        else `Int (List.length (strings "imported" execution)) )
    ; ( "publishedOutputs"
      , if field "published" execution = `Null
        then `Null
        else `Int (List.length (strings "published" execution)) )
    ]
  in
  assoc
    [ "groupId", `String group_id
    ; "runId", `String run_id
    ; "attemptId", `String attempt_id
    ; ( "planId"
      , `String (identity "planId" execution result identities bootstrap) )
    ; "status", `String status
    ; "source", `String relative
    ; "sources", Json.strs [ relative ]
    ; "errors", Json.strs errors
    ; "startedAt", float started
    ; "finishedAt", float finished
    ; ( "durationSeconds"
      , float
          (first_number
             [ numeric "durationSeconds" execution
             ; max_number (List.map terminal ~f:(numeric "elapsed"))
             ; duration started finished
             ]) )
    ; "phases", `List phases
    ; "metrics", assoc metrics
    ; ( "actual"
      , assoc
          [ "builtDerivations", Json.strs built
          ; "cachedRootDerivations", Json.strs cached
          ; "imported", field "imported" execution
          ; "published", field "published" execution
          ; "plannedPrerequisites", field "plannedPrerequisites" execution
          ; "requiredPrerequisites", field "requiredPrerequisites" execution
          ; "cachedRoots", field "cachedRoots" execution
          ; "refreshedBuilds", field "refreshedBuilds" execution
          ; "jobs", field "jobs" result
          ; "derivations", field "derivations" result
          ; "cacheReuse", field "cacheReuse" result
          ; "uploads", field "uploads" result
          ; "waits", field "waits" result
          ] )
    ; "executionEvents", `List events
    ; "engineEvents", `List engine_events
    ]

let read_attempts reader (relative, path) =
  let before = List.length reader.diagnostics in
  let execution = read_json reader (Filename.concat path "execution.json") in
  let result = read_json reader (Filename.concat path "results.json") in
  let error = read_json reader (Filename.concat path "execution-error.json") in
  let bootstrap = read_json reader (Filename.concat path "bootstrap.json") in
  let events =
    read_events reader (Filename.concat path "execution-events.jsonl")
  in
  let engine_events =
    read_events reader (Filename.concat path "events.jsonl")
  in
  let key json =
    let context = field "context" json in
    ( first [ text "runId" json; text "runId" context; "legacy" ]
    , first [ text "attemptId" json; text "attemptId" context ] )
  in
  let keys =
    List.map
      ((execution :: result :: bootstrap :: events) @ engine_events)
      ~f:key
    |> List.filter ~f:(fun (_, id) -> id <> "")
    |> List.sort_uniq ~cmp:Stdlib.compare
  in
  let keys = if keys = [] then [ "legacy", "" ] else keys in
  let single = List.length keys = 1 in
  let select expected json =
    let actual = key json in
    if actual = expected || (single && snd actual = "") then json else `Null
  in
  List.map keys ~f:(fun expected ->
    let select = select expected in
    let execution = select execution in
    (* Old pre-trace error files have no attempt identity. Do not attach one to
       a later recorded success when a report directory has been reused. *)
    let error =
      if
        snd (key error) = ""
        && ((not single) || text "status" execution = "success")
      then `Null
      else select error
    in
    attempt
      ~bad_evidence:(List.length reader.diagnostics > before)
      ~relative
      execution
      (select result)
      error
      (select bootstrap)
      (List.filter events ~f:(fun event -> select event <> `Null))
      (List.filter engine_events ~f:(fun event -> select event <> `Null)))

let replace key value json =
  assoc ((key, value) :: List.remove_assoc key (Json.assoc json))

let deduplicate reader attempts =
  let table = Hashtbl.create (List.length attempts) in
  List.iter attempts ~f:(fun attempt ->
    let key =
      text "runId" attempt, text "groupId" attempt, text "attemptId" attempt
    in
    match Hashtbl.find_opt table key with
    | None -> Hashtbl.add table key attempt
    | Some previous ->
      let ignore_sources json =
        json |> replace "source" `Null |> replace "sources" `Null
      in
      if ignore_sources previous <> ignore_sources attempt
      then
        warn reader ("Conflicting copies of attempt " ^ text "attemptId" attempt);
      let status =
        if text "status" previous = "failed" || text "status" attempt = "failed"
        then "failed"
        else if ignore_sources previous = ignore_sources attempt
        then text "status" previous
        else "incomplete"
      in
      Hashtbl.replace
        table
        key
        (previous
        |> replace "status" (`String status)
        |> replace
             "sources"
             (Json.strs
                (unique
                   (strings "sources" previous @ strings "sources" attempt)))));
  Hashtbl.to_seq_values table |> List.of_seq

let ordered_attempts attempts =
  List.sort attempts ~cmp:(fun a b ->
    let order =
      Stdlib.compare (numeric "startedAt" a) (numeric "startedAt" b)
    in
    if order <> 0
    then order
    else String.compare (text "attemptId" a) (text "attemptId" b))

let latest attempts =
  match List.rev (ordered_attempts attempts) with
  | [] -> `Null
  | attempt :: _ -> attempt

let group_summary
      ~active_run
      ~attempts
      ~scheduler
      graph
      (group : Shared_plan.group)
  =
  let all =
    List.filter attempts ~f:(fun attempt -> text "groupId" attempt = group.id)
    |> ordered_attempts
  in
  let current =
    List.filter all ~f:(fun attempt -> text "runId" attempt = active_run)
  in
  let last = latest current in
  let events =
    List.filter scheduler ~f:(fun event ->
      text "groupId" event = group.id && text "runId" event = active_run)
  in
  let terminal =
    List.filter events ~f:(fun event ->
      List.mem (text "type" event) ~set:[ "completed"; "blocked" ])
    |> List.rev
  in
  let applies event =
    if last = `Null
    then true
    else if text "attemptId" event <> ""
    then text "attemptId" event = text "attemptId" last
    else
      match numeric "time" event, numeric "startedAt" last with
      | Some time, Some started -> time >= started
      | _ -> true
  in
  let scheduled =
    Option.value (List.find_opt terminal ~f:applies) ~default:`Null
  in
  let queued =
    min_number
      (List.filter_map events ~f:(fun event ->
         if text "type" event = "queued"
         then Some (numeric "time" event)
         else None))
  in
  let dispatched =
    min_number
      (List.filter_map events ~f:(fun event ->
         if text "type" event = "dispatched"
         then Some (numeric "time" event)
         else None))
  in
  let ambiguous =
    List.length current > 1
    && (List.exists current ~f:(fun attempt ->
          numeric "startedAt" attempt = None)
       ||
       match List.rev current with
       | a :: b :: _ -> numeric "startedAt" a = numeric "startedAt" b
       | _ -> false)
  in
  let status =
    if text "type" scheduled = "blocked"
    then "blocked"
    else if failed (text "status" scheduled)
    then "failed"
    else if ambiguous
    then "incomplete"
    else if last = `Null
    then "missing"
    else text "status" last
  in
  let members =
    List.map group.members ~f:(fun drv ->
      let name =
        match Plan.find graph drv with
        | Some node -> node.name
        | None -> Filename.basename drv
      in
      assoc [ "drvPath", `String drv; "name", `String name ])
  in
  assoc
    [ "id", `String group.id
    ; "kind", `String (if group.kind = `Shared then "shared" else "package")
    ; "system", `String group.system
    ; "consumers", Json.strs group.consumers
    ; "needs", Json.strs group.needs
    ; "members", `List members
    ; ( "roots"
      , `List
          (List.map group.roots ~f:(fun (edge : Plan.edge) ->
             assoc
               [ "drvPath", `String edge.Plan.drv_path
               ; "outputs", Json.strs edge.outputs
               ])) )
    ; "plannedPrerequisites", Json.strs group.required_paths
    ; "status", `String status
    ; "ambiguousAttemptOrder", `Bool ambiguous
    ; "latestAttemptId", field "attemptId" last
    ; "attempts", `List all
    ; ( "scheduled"
      , assoc
          [ "queuedAt", float queued
          ; "dispatchedAt", float dispatched
          ; "finishedAt", field "time" scheduled
          ; "queueSeconds", float (duration queued dispatched)
          ; "status", field "status" scheduled
          ; "blockedBy", field "blockedBy" scheduled
          ] )
    ]

let summary report =
  let counts = field "counts" report in
  let count key = Json.number (field key counts) |> int_of_float in
  let status = text "status" report in
  let buffer = Buffer.create 4096 in
  Printf.bprintf buffer "# Shared build report: %s\n\n" (html_escape status);
  Printf.bprintf
    buffer
    "**%d groups** · **%d succeeded** · **%d failed** · **%d blocked** · **%d \
     missing/incomplete**\n\n"
    (count "groups")
    (count "success")
    (count "failed")
    (count "blocked")
    (count "missing" + count "incomplete");
  Buffer.add_string
    buffer
    "Open `index.html` for the interactive timeline, dependency links, and \
     attempt details. `aggregate.json` contains the evidence used by this \
     report.\n\n";
  Printf.bprintf
    buffer
    "Run: <code>%s</code> · %d recorded attempts across all runs\n\n"
    (html_escape (text "activeRunId" report))
    (count "attempts");
  Buffer.add_string
    buffer
    "| Group | Consumers | Status | Attempts in this run |\n\
     | --- | --- | --- | ---: |\n";
  List.iter (items "groups" report) ~f:(fun group ->
    let attempts =
      items "attempts" group
      |> List.filter ~f:(fun attempt ->
        text "runId" attempt = text "activeRunId" report)
    in
    Printf.bprintf
      buffer
      "| <code>%s</code> | %s | %s | %d |\n"
      (html_escape (text "id" group))
      (html_escape (String.concat ~sep:", " (strings "consumers" group)))
      (html_escape (text "status" group))
      (List.length attempts));
  let diagnostics = strings "diagnostics" report in
  if diagnostics <> []
  then (
    Buffer.add_string
      buffer
      "\n<details><summary>Evidence warnings</summary>\n\n";
    List.iter diagnostics ~f:(fun message ->
      Printf.bprintf buffer "- %s\n" (html_escape message));
    Buffer.add_string buffer "\n</details>\n");
  Buffer.contents buffer

let page report =
  {|<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nix build execution</title>
<style>
:root{color-scheme:light;--ink:#252333;--muted:#716d80;--line:#e7e4ed;--purple:#7749bb;--teal:#358f9a;--bad:#be435d;--surface:#faf9fc;--label:270px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--surface)}button,input,select{font:inherit}button,select{background:white;border:1px solid #d7d2e1;border-radius:5px;padding:6px 10px;color:var(--ink)}button{cursor:pointer}button:hover{border-color:var(--purple);background:#f8f4ff}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #9b77d3;outline-offset:2px}button:disabled{opacity:.45;cursor:default}a{color:var(--purple)}header{background:white;border-bottom:1px solid var(--line);padding:22px 30px 18px}.eyebrow{font-size:11px;font-weight:700;color:var(--purple);letter-spacing:1.2px;text-transform:uppercase}.heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:23px;letter-spacing:-.4px;margin:6px 0}h2{font-size:15px;margin:0}h3{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:24px 0 10px}p{margin:8px 0}.muted{color:var(--muted)}.small{font-size:12px}.mono,code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;overflow-wrap:anywhere}.badge{font-size:11px;border-radius:4px;padding:3px 7px;display:inline-block;text-transform:capitalize;background:#efedf4;color:#656070;white-space:nowrap}.badge.success{color:#1d7166;background:#e4f4ee}.badge.failed{color:#ac354d;background:#fdeaf0}.badge.blocked{color:#956316;background:#fff1d7}.badge.running{color:#7040ad;background:#eee4fb}.badge.incomplete,.badge.missing{color:#686273;background:#eeeaf3}.metrics{display:flex;gap:32px;margin-top:18px;flex-wrap:wrap}.metric .value{font-size:24px;letter-spacing:-.5px;font-weight:650}.metric .caption{font-size:12px;color:var(--muted)}main{padding:22px 30px}.notice{border:1px solid #e6d5a8;background:#fffaf0;padding:10px 14px;border-radius:6px;margin-bottom:16px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.toolbar input[type=search]{min-width:260px;flex:1;max-width:460px;padding:8px 10px;border:1px solid #d7d2e1;border-radius:5px;background:white}.toolbar label{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:5px}.workspace{display:grid;grid-template-columns:minmax(500px,1fr) 360px;gap:16px;align-items:start}.panel{background:white;border:1px solid var(--line);border-radius:7px;overflow:hidden;box-shadow:0 1px 2px #24203605}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);gap:12px;flex-wrap:wrap}.timeline-controls{padding:14px 16px;background:#fff;border-bottom:1px solid var(--line)}.control-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.control-row .spacer{flex:1}.control-row button{font-size:12px;padding:4px 8px}.overview{position:relative;height:44px;margin:12px 0 6px;overflow:hidden;background:#f8f6fb;border:1px solid var(--line);border-radius:4px;touch-action:none}.overview-bar{position:absolute;height:3px;border-radius:1px;background:#b092d6;pointer-events:none}.overview-window{position:absolute;top:0;bottom:0;background:#7749bb12;border:1px solid var(--purple);pointer-events:none}.ranges{height:16px;position:relative;margin-top:-2px}.ranges:before{content:"";position:absolute;left:0;right:0;top:6px;background:#e9e4f0;border-radius:4px;height:4px}.ranges input{appearance:none;-webkit-appearance:none;position:absolute;width:100%;margin:0;background:transparent;pointer-events:none;height:16px;top:0}.ranges input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;background:white;border:2px solid var(--purple);width:12px;height:19px;border-radius:3px;pointer-events:auto;cursor:ew-resize}.ranges input::-moz-range-thumb{background:white;border:2px solid var(--purple);width:9px;height:16px;border-radius:3px;pointer-events:auto;cursor:ew-resize}.ranges input::-moz-range-track{background:transparent}.bounds{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin:4px 0 12px}.replay{accent-color:var(--purple);flex:1;min-width:100px}.legend{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin-top:12px}.legend span{display:flex;align-items:center;gap:5px}.swatch{width:8px;height:8px;border-radius:2px}.axis{margin-left:var(--label);position:relative;height:30px;background:#fdfcfe;border-bottom:1px solid var(--line);font-size:10px;color:var(--muted)}.tick{position:absolute;top:7px;transform:translateX(-50%)}.rows{max-height:660px;overflow:auto}.row{display:grid;grid-template-columns:var(--label) minmax(160px,1fr);min-height:48px;border-bottom:1px solid #eeebf2;cursor:pointer}.row:last-child{border-bottom:0}.row:hover,.row.selected{background:#f6f1fc}.row.related{box-shadow:inset 3px 0 #b7a2d4}.row-label{padding:8px 12px;border-right:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px;min-width:0}.row-label strong{display:block;font-size:12px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-label small{display:block;font-size:10px;color:var(--muted)}.row.old .row-label{padding-left:25px}.row.old{background:#fcfbfe}.lane{position:relative;overflow:hidden;min-height:48px;background-image:linear-gradient(to right,transparent calc(100% - 1px),#efecf4 1px);background-size:25% 100%}.segment{position:absolute;height:18px;top:15px;min-width:2px;border-radius:3px;opacity:.9;box-shadow:inset 0 0 0 1px #00000008;cursor:pointer}.segment.open{background:repeating-linear-gradient(45deg,#bda6d8,#bda6d8 4px,#e9dff7 4px,#e9dff7 8px)!important}.segment.failed{box-shadow:inset 0 0 0 2px #be435d}.lane .cursor{position:absolute;top:0;bottom:0;width:1px;background:#342044;pointer-events:none;z-index:2}.lane-note{position:absolute;left:8px;top:16px;color:var(--muted);font-size:11px}.details{padding:18px;max-height:1020px;overflow:auto}.detail-title{font-size:17px;font-weight:600;overflow-wrap:anywhere}.detail-meta{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:11px;padding:4px 7px;text-align:left}.chip.failed{color:var(--bad)}table{border-collapse:collapse;width:100%;font-size:12px}th{text-align:left;color:var(--muted);font-size:10px;font-weight:500}td,th{padding:7px 0;border-bottom:1px solid #eeebf2}td:last-child,th:last-child{text-align:right}td.num{font-variant-numeric:tabular-nums}.phase-list{margin:10px 0}.phase-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 0}.phase-row .name{flex:1}.error{color:#a6354a;background:#fff0f4;border-left:3px solid #cf7283;padding:9px 10px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}.evidence{font-size:11px;background:#f7f5fa;border:1px solid var(--line);border-radius:4px;padding:8px;overflow:auto;max-height:220px;white-space:pre-wrap;overflow-wrap:anywhere}details{margin-top:13px}summary{cursor:pointer;font-size:12px;font-weight:500}footer{padding:12px 16px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;justify-content:space-between;gap:15px}.empty{padding:36px;text-align:center;color:var(--muted);font-size:13px}.tooltip{position:fixed;z-index:9;max-width:400px;pointer-events:none;background:#282032;color:white;padding:9px 12px;border-radius:5px;font-size:12px;box-shadow:0 4px 16px #23153133;white-space:pre-line}.hidden{display:none!important}.run-id{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.key{font-size:10px;background:#f0edf5;border-radius:3px;padding:2px 4px}@media(max-width:1100px){:root{--label:230px}.workspace{grid-template-columns:minmax(450px,1fr) 300px}main,header{padding-left:18px;padding-right:18px}}@media(max-width:850px){.workspace{grid-template-columns:1fr}.details{max-height:none}.metrics{gap:22px}:root{--label:200px}main,header{padding-left:12px;padding-right:12px}}
</style></head><body>
<header><div class="eyebrow">Nix CI Build / Execution explorer</div><div class="heading"><h1>Shared dependency execution</h1><span id="outcome" class="badge"></span></div><p class="muted small">Follow the work from prerequisites to packages. Every outcome is backed by a recorded worker attempt.</p><div class="metrics" id="metrics"></div></header>
<main><div id="warnings" class="notice hidden"></div><div class="toolbar"><input id="search" type="search" placeholder="Find a package, dependency, group, or derivation" aria-label="Filter groups"><select id="status" aria-label="Filter status"><option value="all">All outcomes</option><option value="success">Succeeded</option><option value="failed">Failed</option><option value="blocked">Blocked</option><option value="missing">Missing evidence</option><option value="incomplete">Incomplete</option></select><select id="run" aria-label="Select execution run"></select><label><input type="checkbox" id="retries" checked> Earlier attempts</label></div>
<div class="workspace"><section class="panel"><div class="panel-head"><h2>Execution timeline</h2><span class="muted small" id="timeline-note"></span></div><div class="timeline-controls"><div class="control-row"><span class="small muted">Visible window</span><div class="spacer"></div><button id="zoom-in" title="Zoom into the current window">Zoom in</button><button id="zoom-out" title="Zoom out">Zoom out</button><button id="reset">Full timeline</button></div><div class="overview" id="overview" title="Drag to select a time window. Double-click to reset."></div><div class="ranges"><input id="left" type="range" min="0" max="1000" value="0" aria-label="Visible window start"><input id="right" type="range" min="0" max="1000" value="1000" aria-label="Visible window end"></div><div class="bounds"><span id="from"></span><span id="to"></span></div><div class="control-row"><button id="play" aria-label="Play execution replay">Play</button><input id="replay" class="replay" type="range" min="0" max="1000" value="1000" aria-label="Replay position"><span id="position" class="small mono"></span><select id="speed" aria-label="Replay speed"><option value="8">8×</option><option value="32" selected>32×</option><option value="128">128×</option></select></div><div class="legend" id="legend"></div></div><div class="axis" id="axis"></div><div id="rows" class="rows" aria-label="Worker execution timeline"></div><footer><span>Double-click a phase to focus. Double-click empty timeline space to reset.</span><span id="row-count"></span></footer></section><aside class="panel"><div class="panel-head"><h2>Group details</h2><span class="small muted" id="detail-attempt"></span></div><div id="details" class="details"></div></aside></div>
<p class="small muted">Phase durations use worker measurements. Position across runners uses their wall clocks; unrecorded CI queue time is unknown. This saved report works offline.</p></main><div id="tooltip" class="tooltip hidden"></div>
<script type="application/json" id="report-data">|}
  ^ embedded_json report
  ^ {|</script><script>
'use strict';
const data=JSON.parse(document.getElementById('report-data').textContent);
const $=id=>document.getElementById(id), el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e};
const phaseInfo={bootstrap:['Runner bootstrap','#8793a7'],queue:['Scheduler queue','#c2bccc'],import_plan:['Import plan','#a6a0c5'],refresh_cache:['Refresh cache','#af82d1'],import_prerequisites:['Import prerequisites','#358f9a'],build:['Build and cache sync','#7749bb'],publish:['Verify publication','#d69c41'],engine:['Engine activity','#9580ae']};
const safeStatus=s=>['success','failed','blocked','missing','incomplete','running','waiting'].includes(s)?s:'incomplete';
const badge=s=>el('span','badge '+safeStatus(s),s==='success'?'succeeded':s);
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const fmt=n=>!finite(n)?'—':n<1?n.toFixed(2)+'s':n<60?n.toFixed(1)+'s':n<3600?Math.floor(n/60)+'m '+Math.floor(n%60)+'s':Math.floor(n/3600)+'h '+Math.floor(n%3600/60)+'m';
const short=p=>String(p).split('/').pop().replace(/^[a-z0-9]{32}-/,'').replace(/\.drv$/,'');
const groups=new Map(data.groups.map(g=>[g.id,g]));
let run=data.activeRunId,selected=data.groups[0]?.id,selectedAttempt=null,start=0,end=1,left=0,right=1,cursor=1,observedSpan=null,playing=false,animation=null,lastFrame=0;
const attempts=g=>g.attempts.filter(a=>a.runId===run).sort((a,b)=>(a.startedAt??-Infinity)-(b.startedAt??-Infinity)||a.attemptId.localeCompare(b.attemptId));
const lastAttempt=g=>attempts(g).at(-1);
const schedule=g=>data.schedulerEvents.filter(e=>e.runId===run&&e.groupId===g.id);
function groupStatus(g){const aa=attempts(g),a=aa.at(-1),terminal=schedule(g).filter(e=>['completed','blocked'].includes(e.type)&&(!a||(e.attemptId?e.attemptId===a.attemptId:!finite(e.time)||!finite(a.startedAt)||e.time>=a.startedAt))).at(-1);if(terminal?.type==='blocked')return 'blocked';if(['failed','failure','cancelled'].includes(terminal?.status))return 'failed';if(aa.length>1&&(aa.some(x=>!finite(x.startedAt))||aa.at(-1).startedAt===aa.at(-2).startedAt))return 'incomplete';return a?.status||'missing'}
function stateAt(g,a){if(cursor>=end)return groupStatus(g);if(!a||!finite(a.startedAt))return 'missing';if(cursor<a.startedAt)return 'waiting';if(!finite(a.finishedAt)||cursor<a.finishedAt)return 'running';return a.status}
function phases(g,a){if(!a)return[];const result=[...a.phases];if(a===lastAttempt(g)){const q=schedule(g).find(e=>e.type==='queued'),d=schedule(g).find(e=>e.type==='dispatched');if(finite(q?.time)&&finite(d?.time)&&d.time>=q.time)result.unshift({phase:'queue',startedAt:q.time,finishedAt:d.time,durationSeconds:d.time-q.time,status:'success'})}if(!result.length&&finite(a.startedAt))result.push({phase:'engine',startedAt:a.startedAt,finishedAt:a.finishedAt,durationSeconds:a.durationSeconds,status:a.status});return result}
function extent(){let values=[];for(const g of data.groups)for(const a of attempts(g)){for(const p of phases(g,a))values.push(p.startedAt,p.finishedAt);values.push(a.startedAt,a.finishedAt)}for(const e of data.schedulerEvents)if(e.runId===run)values.push(e.time);values=values.filter(finite);start=values.length?Math.min(...values):0;end=values.length?Math.max(...values):1;observedSpan=values.length?end-start:null;if(end<=start)end=start+1;left=start;right=end;cursor=end}
function setWindow(a,b){const minimum=Math.max((end-start)/1000,.001);left=Math.max(start,Math.min(a,end-minimum));right=Math.min(end,Math.max(b,left+minimum));$('left').value=Math.round((left-start)/(end-start)*1000);$('right').value=Math.round((right-start)/(end-start)*1000);$('from').textContent=fmt(left-start);$('to').textContent=fmt(right-start);drawOverview();drawRows()}
function reset(){setWindow(start,end)}
function showTip(event,text){const t=$('tooltip');t.textContent=text;t.classList.remove('hidden');t.style.left=Math.min(event.clientX+12,window.innerWidth-330)+'px';t.style.top=Math.min(event.clientY+14,window.innerHeight-110)+'px'}
function hideTip(){$('tooltip').classList.add('hidden')}
function select(id,attempt=null){selected=id;selectedAttempt=attempt;drawRows();drawDetails()}
function groupName(g){return g.consumers.join(', ')||g.id}
function dependencyIds(id){const visited=new Set;function walk(x){for(const n of groups.get(x)?.needs||[])if(!visited.has(n)){visited.add(n);walk(n)}}walk(id);for(const g of data.groups)if(g.needs.includes(id))visited.add(g.id);return visited}
function drawMetrics(){const current=data.groups.map(groupStatus),success=current.filter(s=>s==='success').length,failed=current.filter(s=>s==='failed').length,missing=current.filter(s=>['missing','incomplete'].includes(s)).length;const computed=failed?'failed':current.includes('blocked')?'blocked':missing?'incomplete':'success';const outcome=run===data.activeRunId?data.status:computed;$('outcome').replaceWith(Object.assign(badge(outcome),{id:'outcome'}));const aa=data.groups.flatMap(attempts),builds=aa.reduce((n,a)=>n+(a.metrics.builtDerivations||0),0);$('metrics').replaceChildren();for(const [value,label]of [[`${success} / ${data.groups.length}`,'groups succeeded'],[aa.length,'recorded attempts'],[builds,'observed derivations built'],[fmt(observedSpan),'observed time span'],...(finite(data.planBootstrap?.durationSeconds)?[[fmt(data.planBootstrap.durationSeconds),'planner preparation']]:[])]){const m=el('div','metric');m.append(el('div','value',value),el('div','caption',label));$('metrics').append(m)}$('timeline-note').textContent=finite(aa[0]?.startedAt)?new Date(start*1000).toLocaleString():'Waiting for worker evidence'}
function drawOverview(){const o=$('overview');o.replaceChildren();const aa=data.groups.flatMap(g=>attempts(g).map(a=>[g,a]));aa.forEach(([g,a],i)=>{for(const p of phases(g,a)){if(!finite(p.startedAt))continue;const bar=el('div','overview-bar');bar.style.left=((p.startedAt-start)/(end-start)*100)+'%';bar.style.width=Math.max(.2,((p.finishedAt??p.startedAt)-p.startedAt)/(end-start)*100)+'%';bar.style.top=(4+(i%10)*3.5)+'px';bar.style.background=(phaseInfo[p.phase]||phaseInfo.engine)[1];o.append(bar)}});const w=el('div','overview-window');w.style.left=((left-start)/(end-start)*100)+'%';w.style.width=((right-left)/(end-start)*100)+'%';o.append(w)}
function row(g,a,old,related){const r=el('div','row'+(selected===g.id&&!old?' selected':'')+(related?' related':'')+(old?' old':''));r.tabIndex=0;r.setAttribute('role','button');r.setAttribute('aria-label',groupName(g)+' '+(a?.status||'missing'));r.dataset.groupId=g.id;r.onclick=()=>{selected=g.id;selectedAttempt=a?.attemptId;const ids=dependencyIds(g.id);document.querySelectorAll('.row').forEach(e=>{e.classList.remove('selected');e.classList.toggle('related',ids.has(e.dataset.groupId))});r.classList.add('selected');drawDetails()};r.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(g.id,a?.attemptId)}};const label=el('div','row-label'),name=el('div');name.style.minWidth='0';name.append(el('strong','',old?'Earlier attempt · '+a.attemptId:groupName(g)),el('small','',old?'Previous '+a.status:g.kind+' · '+g.members.length+' derivations · '+g.system));label.append(name,badge(old?a.status:stateAt(g,a)));const lane=el('div','lane');lane.ondblclick=e=>{if(e.target===lane)reset()};let shown=false;for(const p of phases(g,a)){if(!finite(p.startedAt))continue;const finish=finite(p.finishedAt)?p.finishedAt:Math.max(p.startedAt,cursor);if(finish<left||p.startedAt>right)continue;shown=true;const phase=el('div','segment'+(!finite(p.finishedAt)?' open':'')+(p.status==='failed'?' failed':''));phase.style.left=((Math.max(left,p.startedAt)-left)/(right-left)*100)+'%';phase.style.width=Math.max(.15,(Math.min(right,finish)-Math.max(left,p.startedAt))/(right-left)*100)+'%';phase.style.background=(phaseInfo[p.phase]||phaseInfo.engine)[1];if(p.startedAt>cursor)phase.style.opacity='.22';phase.onpointermove=e=>showTip(e,`${(phaseInfo[p.phase]||[p.phase])[0]} · ${fmt(p.durationSeconds)}\n${groupName(g)}\n${p.status} · +${fmt(p.startedAt-start)}`);phase.onpointerleave=hideTip;phase.ondblclick=e=>{e.stopPropagation();hideTip();const pad=Math.max((finish-p.startedAt)*.08,(end-start)/1000);setWindow(p.startedAt-pad,finish+pad)};lane.append(phase)}if(!shown&&!a)lane.append(el('span','lane-note',groupStatus(g)==='blocked'?'Blocked by prerequisite failure':'Worker report not received'));else if(!shown&&a&&!a.phases.length)lane.append(el('span','lane-note','Timing evidence unavailable'));if(cursor>=left&&cursor<=right){const c=el('div','cursor');c.style.left=((cursor-left)/(right-left)*100)+'%';lane.append(c)}r.append(label,lane);return r}
function drawRows(){const query=$('search').value.toLowerCase(),status=$('status').value,related=dependencyIds(selected);$('axis').replaceChildren();for(let i=0;i<=4;i++){const t=el('span','tick',fmt(left-start+(right-left)*i/4));t.style.left=(i*25)+'%';if(i===0)t.style.transform='none';if(i===4)t.style.transform='translateX(-100%)';$('axis').append(t)}$('rows').replaceChildren();let count=0;for(const g of data.groups){if(status!=='all'&&groupStatus(g)!==status)continue;if(query&&!JSON.stringify([g.id,g.consumers,g.members]).toLowerCase().includes(query))continue;count++;const aa=attempts(g),a=aa.at(-1);$('rows').append(row(g,a,false,related.has(g.id)));if($('retries').checked)for(const old of aa.slice(0,-1))$('rows').append(row(g,old,true,false))}if(!count)$('rows').append(el('div','empty','No groups match these filters.'));$('row-count').textContent=count+' groups';$('position').textContent=fmt(cursor-start);$('replay').value=Math.round((cursor-start)/(end-start)*1000)}
function disclosure(container,title,values){if(values===null||values===undefined)return;const d=el('details'),s=el('summary','',title+(Array.isArray(values)?' ('+values.length+')':'')),p=el('pre','evidence',Array.isArray(values)&&values.every(v=>typeof v==='string')?values.join('\n')||'None recorded':JSON.stringify(values,null,2));d.append(s,p);container.append(d)}
function linkGroups(container,ids){if(!ids.length){container.append(el('p','small muted','None'));return}const chips=el('div','chips');for(const id of ids){const g=groups.get(id),b=el('button','chip '+(g?groupStatus(g):'missing'),g?groupName(g):id);b.onclick=()=>{select(id);$('search').value='';$('status').value='all';drawRows()};b.title=id+(g?' · '+groupStatus(g):'');chips.append(b)}container.append(chips)}
function drawDetails(){const out=$('details');out.replaceChildren();const g=groups.get(selected);if(!g){out.append(el('p','muted','Select a group to inspect its work.'));return}const aa=attempts(g);let a=aa.find(a=>a.attemptId===selectedAttempt)||aa.at(-1);out.append(el('div','detail-title',groupName(g)));const meta=el('div','detail-meta');meta.append(badge(a?.status||groupStatus(g)),el('span','badge',g.kind),el('span','badge',g.system));out.append(meta,el('div','mono muted',g.id));$('detail-attempt').textContent=aa.length?aa.length+' attempt'+(aa.length===1?'':'s'):'No worker evidence';if(aa.length>1){const selectAttempt=el('select');selectAttempt.style.width='100%';selectAttempt.style.marginTop='12px';selectAttempt.setAttribute('aria-label','Select group attempt');for(const x of aa){const o=el('option','',x.attemptId+' · '+x.status);o.value=x.attemptId;o.selected=x===a;selectAttempt.append(o)}selectAttempt.onchange=()=>{selectedAttempt=selectAttempt.value;drawDetails()};out.append(selectAttempt)}if(a){for(const error of a.errors)out.append(el('div','error',error));if(a.status==='incomplete')out.append(el('p','small muted','The saved evidence does not establish a completed, published worker result.'));out.append(el('p','small muted',fmt(a.durationSeconds)+' worker time'))}else out.append(el('p','small muted','No worker result for this group in the selected run. A successful prerequisite does not establish that this job ran.'));out.append(el('h3','','Requires'));linkGroups(out,g.needs);const blocked=g.needs.filter(id=>groups.has(id)&&groupStatus(groups.get(id))!=='success');if(blocked.length&&groupStatus(g)!=='success')out.append(el('p','small muted','Unresolved prerequisite outcomes: '+blocked.map(id=>groupName(groups.get(id))).join(', ')));out.append(el('h3','','Required by'));linkGroups(out,data.groups.filter(x=>x.needs.includes(g.id)).map(x=>x.id));out.append(el('h3','','Planned and observed work'));const table=el('table'),head=el('tr');for(const label of ['Work','Planned','Observed'])head.append(el('th','',label));table.append(head);const rows=[['Derivations built',g.members.length,a?.metrics.builtDerivations],['Prerequisite outputs imported',g.plannedPrerequisites.length,a?.metrics.importedOutputs],['Root derivations cached','—',a?.metrics.cachedRootDerivations],['Outputs published and verified','—',a?.metrics.publishedOutputs]];for(const [name,p,v]of rows){const r=el('tr');r.append(el('td','',name),el('td','num',p),el('td','num',v??'—'));table.append(r)}out.append(table);if(a?.actual.requiredPrerequisites)out.append(el('p','small muted',a.actual.requiredPrerequisites.length+' prerequisite outputs still needed after refreshing cache availability.'));if(a){out.append(el('h3','','Recorded phases'));for(const p of phases(g,a)){const r=el('div','phase-row'),sw=el('span','swatch');sw.style.background=(phaseInfo[p.phase]||phaseInfo.engine)[1];r.append(sw,el('span','name',(phaseInfo[p.phase]||[p.phase])[0]),el('span','mono',fmt(p.durationSeconds)));out.append(r)}disclosure(out,'Built derivations',a.actual.builtDerivations);disclosure(out,'Imported outputs',a.actual.imported);disclosure(out,'Prerequisites after cache refresh',a.actual.requiredPrerequisites);disclosure(out,'Builds after cache refresh',a.actual.refreshedBuilds);disclosure(out,'Published outputs',a.actual.published);disclosure(out,'Cached root derivations',a.actual.cachedRootDerivations);disclosure(out,'Derivation activity',a.actual.derivations);disclosure(out,'Nix waits',a.actual.waits);disclosure(out,'Root requests',a.actual.jobs);disclosure(out,'Orchestration events',a.executionEvents);disclosure(out,'Engine events',a.engineEvents)}disclosure(out,'Owned derivations',g.members);disclosure(out,'Planned prerequisite outputs',g.plannedPrerequisites);disclosure(out,'Attempt evidence',a?{runId:a.runId,attemptId:a.attemptId,planId:a.planId,sources:a.sources}:null)}
function stop(){playing=false;$('play').textContent='Play';cancelAnimationFrame(animation);lastFrame=0}
function frame(time){if(!playing)return;if(lastFrame)cursor=Math.min(end,cursor+(time-lastFrame)/1000*Number($('speed').value));lastFrame=time;drawRows();if(cursor>=end)stop();else animation=requestAnimationFrame(frame)}
for(const [key,[name,color]]of Object.entries(phaseInfo)){if(key==='engine')continue;const s=el('span'),sw=el('i','swatch');sw.style.background=color;s.append(sw,document.createTextNode(name));$('legend').append(s)}
for(const id of data.runIds){const starts=data.groups.flatMap(g=>g.attempts.filter(a=>a.runId===id).map(a=>a.startedAt)).filter(finite);const when=starts.length?new Date(Math.min(...starts)*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';const label=id==='legacy'?'Legacy reports':(id===data.activeRunId?'Latest run':'Previous run')+(when?' · '+when:'');const o=el('option','',label);o.value=id;o.title=id;o.selected=id===run;$('run').append(o)}$('run').onchange=()=>{stop();run=$('run').value;selectedAttempt=null;extent();drawMetrics();setWindow(start,end);drawDetails()};
$('search').oninput=drawRows;$('status').onchange=drawRows;$('retries').onchange=drawRows;$('reset').onclick=reset;$('axis').ondblclick=reset;
$('left').oninput=()=>setWindow(start+Number($('left').value)/1000*(end-start),right);$('right').oninput=()=>setWindow(left,start+Number($('right').value)/1000*(end-start));
function zoom(factor){const span=Math.min(end-start,(right-left)*factor),middle=(left+right)/2,from=Math.max(start,Math.min(middle-span/2,end-span));setWindow(from,from+span)}$('zoom-in').onclick=()=>zoom(.5);$('zoom-out').onclick=()=>zoom(2);
$('replay').oninput=()=>{stop();cursor=start+Number($('replay').value)/1000*(end-start);drawRows()};$('play').onclick=()=>{if(playing){stop();return}if(cursor>=end)cursor=start;playing=true;$('play').textContent='Pause';animation=requestAnimationFrame(frame)};
let dragStart=null;$('overview').onpointerdown=e=>{dragStart=e.clientX;$('overview').setPointerCapture(e.pointerId)};$('overview').onpointerup=e=>{if(dragStart===null)return;const b=$('overview').getBoundingClientRect(),a=Math.min(dragStart,e.clientX),z=Math.max(dragStart,e.clientX);dragStart=null;if(z-a>3)setWindow(start+(a-b.left)/b.width*(end-start),start+(z-b.left)/b.width*(end-start))};$('overview').ondblclick=reset;
if(data.diagnostics.length){const box=$('warnings');box.classList.remove('hidden');const d=el('details'),s=el('summary','',data.diagnostics.length+' evidence warning'+(data.diagnostics.length===1?'':'s')+' — some observations may be incomplete');d.append(s);for(const warning of data.diagnostics)d.append(el('p','small',warning));box.append(d)}
extent();drawMetrics();setWindow(start,end);drawDetails();
</script></body></html>|}

let render ~directory ~reports ~output =
  let manifest_path = Filename.concat directory "execution-plan.json" in
  let manifest = Json.read manifest_path in
  if field "version" manifest <> `Int 1
  then failwith "Unsupported execution plan version";
  let unwrap = function
    | Ok value -> value
    | Error message -> failwith message
  in
  let plan = unwrap (Shared_plan.of_yojson (field "plan" manifest)) in
  let graph = unwrap (Plan.of_yojson (field "graph" manifest)) in
  let reader = { bytes = 0; files = 0; events = 0; diagnostics = [] } in
  let plan_id = Shared_trace.plan_id manifest in
  let scheduler =
    read_events reader (Filename.concat reports "scheduler-events.jsonl")
  in
  let scheduler =
    List.filter scheduler ~f:(fun event ->
      let id = text "planId" event in
      if id <> "" && plan_id <> "" && id <> plan_id
      then (
        warn reader ("Ignored scheduler event from another plan: " ^ id);
        false)
      else true)
  in
  let attempts =
    discover reader reports |> List.concat_map ~f:(read_attempts reader)
  in
  let attempts =
    List.filter attempts ~f:(fun attempt ->
      let id = text "groupId" attempt in
      if
        not
          (List.exists plan.groups ~f:(fun group -> group.Shared_plan.id = id))
      then (
        warn reader ("Unassociated worker report: " ^ text "source" attempt);
        false)
      else if
        plan_id <> ""
        && text "planId" attempt <> ""
        && text "planId" attempt <> plan_id
      then (
        warn
          reader
          ("Ignored worker report from another plan: " ^ text "source" attempt);
        false)
      else true)
    |> deduplicate reader
  in
  let run_times = Hashtbl.create 8 in
  let add_run id time =
    if id <> ""
    then
      let existing =
        Option.value (Hashtbl.find_opt run_times id) ~default:None
      in
      Hashtbl.replace run_times id (min_number [ existing; time ])
  in
  List.iter attempts ~f:(fun attempt ->
    add_run (text "runId" attempt) (numeric "startedAt" attempt));
  List.iter scheduler ~f:(fun event ->
    add_run (text "runId" event) (numeric "time" event));
  List.iter scheduler ~f:(fun event ->
    if text "type" event = "run_start" && text "runId" event <> ""
    then Hashtbl.replace run_times (text "runId" event) (numeric "time" event));
  if Hashtbl.length run_times = 0 then Hashtbl.add run_times "legacy" None;
  let runs =
    Hashtbl.to_seq run_times
    |> List.of_seq
    |> List.sort ~cmp:(fun (a, ta) (b, tb) ->
      let compare = Stdlib.compare tb ta in
      if compare <> 0 then compare else String.compare a b)
  in
  let active_run = fst (List.hd runs) in
  let groups =
    List.map
      plan.groups
      ~f:(group_summary ~active_run ~attempts ~scheduler graph)
  in
  let states =
    List.map groups ~f:(fun group -> text "id" group, text "status" group)
  in
  let groups =
    List.map groups ~f:(fun group ->
      let blocked =
        strings "needs" group
        |> List.filter ~f:(fun id -> List.assoc_opt id states <> Some "success")
      in
      replace "unresolvedPrerequisites" (Json.strs blocked) group)
  in
  let current =
    List.filter attempts ~f:(fun attempt -> text "runId" attempt = active_run)
  in
  let events =
    List.filter scheduler ~f:(fun event -> text "runId" event = active_run)
  in
  let times =
    List.concat_map current ~f:(fun attempt ->
      [ numeric "startedAt" attempt; numeric "finishedAt" attempt ]
      @ List.concat_map (items "phases" attempt) ~f:(fun phase ->
        [ numeric "startedAt" phase; numeric "finishedAt" phase ]))
    @ List.map events ~f:(numeric "time")
  in
  let started = min_number times
  and finished = max_number times in
  let count status =
    List.length
      (List.filter groups ~f:(fun group -> text "status" group = status))
  in
  let bootstrap =
    read_json reader (Filename.concat directory "bootstrap.json")
  in
  let status =
    if count "failed" > 0
    then "failed"
    else if count "blocked" > 0
    then "blocked"
    else if count "missing" + count "incomplete" > 0
    then "incomplete"
    else if reader.diagnostics <> []
    then "incomplete"
    else "success"
  in
  let report =
    assoc
      [ "schemaVersion", `Int 1
      ; "planId", `String plan_id
      ; "activeRunId", `String active_run
      ; "runIds", Json.strs (List.map runs ~f:fst)
      ; "status", `String status
      ; "planBootstrap", bootstrap
      ; ( "timing"
        , assoc
            [ "startedAt", float started
            ; "finishedAt", float finished
            ; "observedSeconds", float (duration started finished)
            ] )
      ; ( "counts"
        , assoc
            ([ "groups", `Int (List.length groups)
             ; "attempts", `Int (List.length attempts)
             ; "currentAttempts", `Int (List.length current)
             ; ( "shared"
               , `Int
                   (List.length
                      (List.filter plan.groups ~f:(fun group ->
                         group.Shared_plan.kind = `Shared))) )
             ; ( "package"
               , `Int
                   (List.length
                      (List.filter plan.groups ~f:(fun group ->
                         group.Shared_plan.kind = `Package))) )
             ]
            @ List.map
                [ "success"; "failed"; "blocked"; "missing"; "incomplete" ]
                ~f:(fun state -> state, `Int (count state))) )
      ; "groups", `List groups
      ; "schedulerEvents", `List scheduler
      ; "diagnostics", Json.strs (unique reader.diagnostics)
      ]
  in
  Json.mkdir output;
  Json.atomic_write (Filename.concat output "aggregate.json") report;
  write_text (Filename.concat output "index.html") (page report);
  write_text (Filename.concat output "summary.md") (summary report)
