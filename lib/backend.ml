type result =
  { status : Eio.Process.exit_status
  ; stdout : string
  ; tail : string list
  }

let successful r = r.status = `Exited 0

let readable_lines lines =
  List.filter_map lines ~f:(fun line ->
    match Activity.parse line with
    | Activity.Message { message; _ } -> Some (Activity.strip_ansi message)
    | Activity.Raw line ->
      if String.trim line = "" then None else Some (Activity.strip_ansi line)
    | Activity.Start _ | Activity.Stop _ | Activity.Result _ -> None)

let error r =
  match readable_lines r.tail with
  | [] ->
    (match r.status with
    | `Exited status -> Printf.sprintf "Command exited with status %d" status
    | `Signaled signal ->
      Printf.sprintf "Command terminated by signal %d" signal)
  | lines -> String.concat ~sep:"\n" lines

(* Every child belongs to a switch: cancellation closes its pipes, terminates
   it, and waits for it. Only small diagnostic tails are retained for build
   commands. *)
let run
      process_mgr
      ?(input = "")
      ?log_path
      ?(append = false)
      ?(capture = true)
      ?(on_stdout = fun _ -> ())
      ?(on_stderr = fun _ -> ())
      args
  =
  let log =
    Option.map
      (fun path ->
         open_out_gen
           [ Open_wronly
           ; Open_creat
           ; Open_binary
           ; (if append then Open_append else Open_trunc)
           ]
           0o600
           path)
      log_path
  in
  Fun.protect
    ~finally:(fun () -> Option.iter close_out_noerr log)
    (fun () ->
       Eio.Switch.run (fun sw ->
         let out_r, out_w = Eio.Process.pipe process_mgr ~sw in
         let err_r, err_w = Eio.Process.pipe process_mgr ~sw in
         let child =
           Eio.Process.spawn
             process_mgr
             ~sw
             ~stdin:(Eio.Flow.string_source input)
             ~stdout:out_w
             ~stderr:err_w
             args
         in
         Eio.Flow.close out_w;
         Eio.Flow.close err_w;
         let stdout = Buffer.create 256
         and tail = Queue.create () in
         let consume flow callback is_stdout =
           (* Derivation graphs are one compact JSON line and routinely exceed
              the human-log record limit. Captured stdout already has an
              explicit caller that needs the whole JSON document. *)
           let max_size =
             if is_stdout && capture then max_int else 16 * 1024 * 1024
           in
           let reader = Eio.Buf_read.of_flow flow ~max_size in
           let rec loop () =
             match Eio.Buf_read.line reader with
             | line ->
               Option.iter
                 (fun ch ->
                    output_string ch line;
                    output_char ch '\n';
                    flush ch)
                 log;
               if is_stdout && capture
               then (
                 Buffer.add_string stdout line;
                 Buffer.add_char stdout '\n');
               if not is_stdout
               then (
                 Queue.add (Json.clip 4096 line) tail;
                 if Queue.length tail > 50 then ignore (Queue.take tail));
               callback line;
               loop ()
             | exception End_of_file -> ()
           in
           loop ()
         in
         Eio.Fiber.both
           (fun () -> consume out_r on_stdout true)
           (fun () -> consume err_r on_stderr false);
         let status = Eio.Process.await child in
         { status
         ; stdout = Buffer.contents stdout
         ; tail = List.of_seq (Queue.to_seq tail)
         }))

let nix args =
  [ "nix"; "--extra-experimental-features"; "nix-command flakes" ] @ args

let query_json process_mgr ?input args =
  let result = run process_mgr ?input (nix args) in
  match Yojson.Safe.from_string result.stdout with
  | json -> json, result
  | exception Yojson.Json_error _ -> `Null, result

let version process_mgr program =
  let result = run process_mgr [ program; "--version" ] in
  let reported = String.trim result.stdout in
  if successful result && reported <> ""
  then reported
  else if program = "nix-eval-jobs"
  then
    (* Some nix-eval-jobs releases have no version flag. The Nix wrapper knows
       the version of the package it puts on PATH; distinguish that metadata
       from a version reported by the executable itself. *)
    match Sys.getenv_opt "NIX_CI_BUILD_NIX_EVAL_JOBS_VERSION" with
    | Some version when String.trim version <> "" ->
      "nix-eval-jobs " ^ String.trim version ^ " (Nix package)"
    | _ -> "unknown"
  else "unknown"

let substituters process_mgr =
  (* Query one setting only. The full config can contain access tokens. *)
  let r = run process_mgr (nix [ "config"; "show"; "substituters" ]) in
  if not (successful r) then failwith ("Cannot read substituters: " ^ error r);
  String.split_on_char ~sep:' ' (String.trim r.stdout)
  |> List.filter ~f:(fun s -> s <> "")

let store_prefix () =
  Filename.concat
    (Option.value (Sys.getenv_opt "NIX_STORE_DIR") ~default:"/nix/store")
    ""

let normalize_path path =
  if String.starts_with ~prefix:"/" path then path else store_prefix () ^ path

let path_info_fields = function
  | `List xs -> List.map xs ~f:(fun j -> Json.string (Json.member "path" j), j)
  | `Assoc xs ->
    (match List.assoc_opt "info" xs with Some (`Assoc xs) -> xs | _ -> xs)
  | _ -> []

let path_infos json =
  List.filter_map (path_info_fields json) ~f:(fun (path, info) ->
    if path = "" || not (match info with `Assoc _ -> true | _ -> false)
    then None
    else
      Some
        ( normalize_path path
        , { Plan.download_size = Json.int64 (Json.member "downloadSize" info)
          ; nar_size = Json.int64 (Json.member "narSize" info)
          ; references =
              List.map
                (Json.strings (Json.member "references" info))
                ~f:normalize_path
          } ))

let missing_diagnostic line =
  String.starts_with ~prefix:("error: path '" ^ store_prefix ()) line
  && String.ends_with ~suffix:"' is not valid" line

let query_noise line =
  line = ""
  || String.starts_with
       ~prefix:"warning: '--json' without '--json-format' is deprecated"
       line
  || line = "don't know how to build these paths:"
  || String.starts_with ~prefix:(store_prefix ()) line
  || missing_diagnostic line
  || ((String.starts_with ~prefix:"this " line
      || String.starts_with ~prefix:"these " line)
     && String.ends_with ~suffix:":" line
     && (Json.contains ~sub:" will be fetched (" line
        || Json.contains ~sub:" will be built:" line))

(* Keep significant diagnostics as they arrive: a long planner path list can
   otherwise evict the actual HTTP/authentication error from the stderr tail.
   Internal-JSON messages may contain several physical lines. *)
let run_cache_query process_mgr args paths =
  let messages = ref []
  and missing = ref false in
  let on_stderr line =
    readable_lines [ line ]
    |> List.concat_map ~f:(String.split_on_char ~sep:'\n')
    |> List.iter ~f:(fun line ->
      let line = String.trim line in
      if missing_diagnostic line then missing := true;
      if (not (query_noise line)) && List.length !messages < 20
      then messages := Json.clip 4096 line :: !messages)
  in
  let result =
    run
      process_mgr
      ~input:(String.concat ~sep:"\n" paths ^ "\n")
      ~on_stderr
      args
  in
  result, List.rev !messages, !missing

let query_options store fresh =
  (match store with
    | None -> [ "--option"; "substituters"; "" ]
    | Some s -> [ "--store"; s ])
  @ if fresh then [ "--option"; "narinfo-cache-negative-ttl"; "0" ] else []

let query_warning ?log_dir ~store ~args ~paths result messages reason =
  let status =
    match result.status with
    | `Exited code -> Printf.sprintf "exit %d" code
    | `Signaled signal -> Printf.sprintf "signal %d" signal
  in
  let details =
    match log_dir with
    | None -> ""
    | Some dir ->
      let diagnostic =
        `Assoc
          [ "command", Json.strs args
          ; "paths", Json.strs paths
          ; "status", `String status
          ; "reason", `String reason
          ; "stdout", `String result.stdout
          ; "stderrTail", Json.strs result.tail
          ; "diagnostics", Json.strs messages
          ]
      in
      (* Repeated identical outages must keep the same warning text, so the
         engine can deduplicate them and polling does not create endless
         logs. *)
      let id =
        Digest.to_hex (Digest.string (Yojson.Safe.to_string diagnostic))
      in
      let path = Filename.concat dir ("cache-query-" ^ id ^ ".json") in
      if not (Sys.file_exists path) then Json.atomic_write path diagnostic;
      " (details: "
      ^ Filename.concat (Filename.basename dir) (Filename.basename path)
      ^ ")"
  in
  let diagnostic =
    match messages with
    | [] -> reason
    | _ -> reason ^ ": " ^ Json.clip 2048 (String.concat ~sep:"\n" messages)
  in
  Some
    (Printf.sprintf
       "Cache query against %s (%d paths, %s): %s%s"
       (Option.value store ~default:"local store")
       (List.length paths)
       status
       diagnostic
       details)

let valid_paths process_mgr ?log_dir ?store ?(fresh = false) paths =
  if paths = []
  then [], None
  else
    let args =
      [ "nix-store"; "--check-validity"; "--print-invalid"; "--stdin" ]
      @ query_options store fresh
    in
    let result, messages, _ = run_cache_query process_mgr args paths in
    let invalid =
      String.split_on_char ~sep:'\n' result.stdout
      |> List.map ~f:String.trim
      |> List.filter ~f:(fun s -> s <> "")
    in
    let requested = Hashtbl.create (List.length paths) in
    List.iter paths ~f:(fun path -> Hashtbl.replace requested path ());
    if successful result && List.for_all invalid ~f:(Hashtbl.mem requested)
    then (
      let missing = Hashtbl.create (List.length invalid) in
      List.iter invalid ~f:(fun path -> Hashtbl.replace missing path ());
      ( List.filter paths ~f:(fun path -> not (Hashtbl.mem missing path))
      , if messages = []
        then None
        else
          query_warning
            ?log_dir
            ~store
            ~args
            ~paths
            result
            messages
            "Validity query diagnostics" ))
    else
      ( []
      , query_warning
          ?log_dir
          ~store
          ~args
          ~paths
          result
          messages
          "Cannot determine valid paths" )

let path_info process_mgr ?log_dir ?store ?(fresh = false) paths =
  if paths = []
  then [], None
  else
    let args =
      nix ([ "path-info"; "--json"; "--stdin" ] @ query_options store fresh)
    in
    let query paths =
      let result, messages, missing = run_cache_query process_mgr args paths in
      let json =
        try Yojson.Safe.from_string result.stdout with
        | Yojson.Json_error _ -> `Null
      in
      let valid_json =
        match json with `Assoc _ | `List _ -> true | _ -> false
      in
      let fields = path_info_fields json in
      let accounted = Hashtbl.create (List.length fields) in
      List.iter fields ~f:(fun (path, info) ->
        match info with
        | `Assoc _ | `Null -> Hashtbl.replace accounted (normalize_path path) ()
        | _ -> ());
      let omitted =
        List.filter paths ~f:(fun p -> not (Hashtbl.mem accounted p))
      in
      let warning =
        let reason =
          if messages <> []
          then Some "Metadata query diagnostics"
          else if
            not (successful result || (result.status = `Exited 1 && missing))
          then Some "Metadata query failed"
          else if
            (not valid_json) && not (String.trim result.stdout = "" && missing)
          then Some "Metadata query returned invalid JSON"
          else None
        in
        Option.bind
          reason
          (query_warning ?log_dir ~store ~args ~paths result messages)
      in
      path_infos json, omitted, warning, result
    in
    let infos, omitted, warning, _ = query paths in
    if warning <> None || omitted = []
    then infos, warning
    else
      (* Some Nix queries abort on a missing path before emitting all JSON.
         Recover in two bounded batches, never one subprocess per miss. A
         validity check bypasses installable resolution and its planner. *)
      let valid, warning =
        valid_paths process_mgr ?log_dir ?store ~fresh omitted
      in
      if warning <> None
      then infos, warning
      else if valid = []
      then infos, None
      else
        let recovered, omitted, warning, retry = query valid in
        let warning =
          if warning <> None || omitted = []
          then warning
          else
            query_warning
              ?log_dir
              ~store
              ~args
              ~paths:valid
              retry
              []
              "Metadata query remained incomplete after validity check"
        in
        infos @ recovered, warning

let graph process_mgr ?(recursive = true) drvs =
  let json, result =
    query_json
      process_mgr
      ~input:(String.concat ~sep:"\n" drvs ^ "\n")
      ([ "derivation"; "show"; "--stdin" ]
      @ if recursive then [ "--recursive" ] else [])
  in
  if not (successful result)
  then failwith ("Cannot read derivation graph: " ^ error result);
  match Plan.of_yojson json with Ok graph -> graph | Error e -> failwith e

let edge_installable (edge : Plan.edge) =
  let edge =
    { Plan.drv_path = Plan.normalize_drv_path edge.drv_path
    ; outputs = List.sort_uniq ~cmp:String.compare edge.outputs
    }
  in
  if edge.outputs = []
  then invalid_arg "A build request must select at least one output";
  edge.drv_path
  ^ "^"
  ^
  if List.mem "*" ~set:edge.outputs
  then "*"
  else String.concat ~sep:"," edge.outputs

let build_edges process_mgr ?substituters ~log_path ~on_stderr edges =
  let cache_options =
    match substituters with
    | None -> []
    | Some stores ->
      [ "--option"; "substituters"; String.concat ~sep:" " stores ]
  in
  run
    process_mgr
    ~capture:false
    ~log_path
    ~on_stderr
    (nix
       ([ "build"
        ; "--keep-going"
        ; "--no-link"
        ; "--log-format"
        ; "internal-json"
        ; "-L"
        ]
       @ cache_options
       @ List.map edges ~f:edge_installable))

let build process_mgr ~log_path ~on_stderr drvs =
  build_edges
    process_mgr
    ~log_path
    ~on_stderr
    (List.map drvs ~f:(fun drv_path -> { Plan.drv_path; outputs = [ "*" ] }))

let copy process_mgr ?(append = false) ~log_path ~destination path =
  run
    process_mgr
    ~append
    ~capture:false
    ~log_path
    (nix [ "copy"; "--log-format"; "raw"; "--to"; destination; path ])

let copy_from process_mgr ~log_path ~source paths =
  (* Bare output paths cannot start a builder. A fresh lookup also avoids a
     previous negative narinfo result hiding outputs published by another CI
     runner since evaluation. Signature verification remains Nix's default. *)
  run
    process_mgr
    ~input:(String.concat ~sep:"\n" paths ^ "\n")
    ~capture:false
    ~log_path
    (nix
       [ "copy"
       ; "--log-format"
       ; "raw"
       ; "--from"
       ; source
       ; "--stdin"
       ; "--option"
       ; "narinfo-cache-negative-ttl"
       ; "0"
       ])

let pin process_mgr ~root path =
  let is_derivation = String.ends_with ~suffix:".drv" path in
  let args =
    if is_derivation
    then
      (* A bare store-path installable denotes the derivation file itself.
         nix-store --realise would instead build its outputs, outside the
         scheduler and before shared-plan ownership checks could protect
         them. *)
      nix [ "build"; "--out-link"; root; path ]
    else [ "nix-store"; "--add-root"; root; "--indirect"; "--realise"; path ]
  in
  let r = run process_mgr args in
  if not (successful r)
  then
    failwith
      ("Cannot protect "
      ^ (if is_derivation then "derivation" else "cache output")
      ^ " from GC: "
      ^ error r)

let pin_derivations process_mgr ~root drvs =
  let rec take remaining taken = function
    | rest when remaining = 0 -> List.rev taken, rest
    | [] -> List.rev taken, []
    | path :: rest -> take (remaining - 1) (path :: taken) rest
  in
  let rec loop index = function
    | [] -> ()
    | paths ->
      let batch, rest = take 128 [] paths in
      let root = root ^ "-batch-" ^ string_of_int index in
      (* Nix creates one indirect root per raw derivation installable. Batching
         keeps a large package set from launching a subprocess for every
         root. *)
      let result =
        run process_mgr (nix ([ "build"; "--out-link"; root ] @ batch))
      in
      if not (successful result)
      then failwith ("Cannot protect derivations from GC: " ^ error result);
      loop (index + 1) rest
  in
  loop 0 (List.sort_uniq ~cmp:String.compare drvs)

let transient lines =
  let message = String.lowercase_ascii (String.concat ~sep:"\n" lines) in
  List.exists
    [ "http error 408"
    ; "http error 429"
    ; "http error 500"
    ; "http error 502"
    ; "http error 503"
    ; "http error 504"
    ; "status code 429"
    ; "status code 503"
    ; "status code 504"
    ; "connection timed out"
    ; "timeout was reached"
    ; "operation timed out"
    ; "connection reset"
    ; "could not resolve host"
    ; "temporary failure in name resolution"
    ]
    ~f:(fun sub -> Json.contains ~sub message)
