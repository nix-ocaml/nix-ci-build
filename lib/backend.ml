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
  if successful result then String.trim result.stdout else "unknown"

let substituters process_mgr =
  (* Query one setting only. The full config can contain access tokens. *)
  let r = run process_mgr (nix [ "config"; "show"; "substituters" ]) in
  if not (successful r) then failwith ("Cannot read substituters: " ^ error r);
  String.split_on_char ~sep:' ' (String.trim r.stdout)
  |> List.filter ~f:(fun s -> s <> "")

let normalize_path path =
  if String.starts_with ~prefix:"/" path then path else "/nix/store/" ^ path

let path_infos json =
  let fields =
    match json with
    | `List xs ->
      List.map xs ~f:(fun j -> Json.string (Json.member "path" j), j)
    | `Assoc xs ->
      (match List.assoc_opt "info" xs with Some (`Assoc xs) -> xs | _ -> xs)
    | _ -> []
  in
  List.filter_map fields ~f:(fun (path, info) ->
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

let cache_query_warning json result =
  let diagnostics = List.map (readable_lines result.tail) ~f:String.trim in
  let format_warning line =
    String.starts_with
      ~prefix:"warning: '--json' without '--json-format' is deprecated"
      line
  in
  let expected_missing line =
    line = ""
    || format_warning line
    || line = "don't know how to build these paths:"
    || String.starts_with ~prefix:"/nix/store/" line
    || (String.starts_with ~prefix:"error: path " line
       && Json.contains ~sub:" is not valid" line)
  in
  let unexpected_error =
    (not (successful result))
    && (diagnostics = []
       || List.exists diagnostics ~f:(fun line -> not (expected_missing line)))
  in
  let cache_warning =
    List.exists diagnostics ~f:(fun line ->
      String.starts_with ~prefix:"warning:" line && not (format_warning line))
  in
  if json = `Null || unexpected_error || cache_warning
  then
    Some
      (if result.tail = []
       then "Cache query returned no valid JSON or diagnostics"
       else error result)
  else None

let path_info process_mgr ?store ?(fresh = false) paths =
  if paths = []
  then [], None
  else
    let options =
      (match store with
        | None ->
          (* Even path-info's read-only installable resolution calls Nix's
             substitution planner. A local validity check must not query remote
             caches or walk the download closure of every missing output. *)
          [ "--option"; "substituters"; "" ]
        | Some s -> [ "--store"; s ])
      @ if fresh then [ "--option"; "narinfo-cache-negative-ttl"; "0" ] else []
    in
    let json, result =
      query_json
        process_mgr
        ~input:(String.concat ~sep:"\n" paths ^ "\n")
        ([ "path-info"; "--json"; "--stdin" ] @ options)
    in
    let infos = path_infos json in
    let warning = cache_query_warning json result in
    infos, warning

let graph process_mgr drvs =
  let json, result =
    query_json
      process_mgr
      ~input:(String.concat ~sep:"\n" drvs ^ "\n")
      [ "derivation"; "show"; "--recursive"; "--stdin" ]
  in
  if not (successful result)
  then failwith ("Cannot read derivation graph: " ^ error result);
  match Plan.of_yojson json with Ok graph -> graph | Error e -> failwith e

let build process_mgr ~log_path ~on_stderr drvs =
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
       @ List.map drvs ~f:(fun drv -> drv ^ "^*")))

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
  let r =
    run
      process_mgr
      [ "nix-store"; "--add-root"; root; "--indirect"; "--realise"; path ]
  in
  if not (successful r)
  then failwith ("Cannot protect cache output from GC: " ^ error r)

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
