type config =
  { flake : string
  ; jobs : int
  ; copy_to : string option
  ; output : string option
  ; report_dir : string
  ; dry_run : bool
  ; explain : string option
  ; compare : string option
  ; history : string option
  ; heartbeat : float
  ; cache_refresh : float
  ; batch_size : int
  ; retries : int
  ; verbose : bool
  }

type job =
  { edge : Plan.edge
  ; mutable attrs : string list
  ; name : string
  ; system : string
  ; mutable cache : string
  ; queued : float
  ; mutable started : float option
  ; mutable finished : float option
  ; mutable state : string
  ; mutable failure : Yojson.Safe.t
  ; mutable log : string
  }

type activity =
  { node : Plan.node
  ; mutable state : string
  ; mutable phase : string
  ; mutable started : float option
  ; mutable finished : float option
  ; mutable seconds : float
  ; mutable build_seconds : float
  ; mutable download_seconds : float
  ; mutable wait_seconds : float
  ; mutable active_started : float option
  ; mutable building : bool
  ; mutable active : int
  ; mutable active_builds : int
  ; mutable active_downloads : int
  ; log : string
  ; mutable tail : string list
  }

type upload =
  { path : string
  ; mutable state : string
  ; mutable seconds : float
  ; mutable error : string option
  ; log : string
  }

type cache_import =
  { drv_path : string
  ; name : string
  ; paths : string list
  ; source : string
  ; mutable state : string
  ; started : float
  ; mutable seconds : float
  ; mutable error : string option
  ; log : string
  }

type cache_check =
  { mutable next_check : float
  ; mutable misses : int
  ; mutable failures : int
  }

type state =
  { config : config
  ; report : Report.t
  ; event_context : (string * Yojson.Safe.t) list
  ; allowed_builds : string list option
  ; jobs : (string, job) Hashtbl.t
  ; activities : (string, activity) Hashtbl.t
  ; uploads : (string, upload) Hashtbl.t
  ; cache_reuse : (string, cache_import) Hashtbl.t
  ; waits : (string, string * string list * string * float) Hashtbl.t
  ; available : (string, Plan.availability) Hashtbl.t
  ; mutable availability_epoch : int
  ; mutable generation : int
  ; failures : (string, Yojson.Safe.t) Hashtbl.t
  ; candidates : (string, unit) Hashtbl.t
  ; attribution : (string, string list) Hashtbl.t
  ; output_producers : (string, string) Hashtbl.t
  ; mutable graph : Plan.t
  ; mutable roots : Plan.edge list
  ; mutable context : (string * Yojson.Safe.t) list
  ; mutable plan : Yojson.Safe.t
  ; mutable diff : Yojson.Safe.t
  ; mutable eval_attrs : int
  ; mutable eval_errors : Yojson.Safe.t list
  ; mutable eval_complete : bool
  ; mutable status : string
  ; mutable fatal : string option
  ; mutable warnings : string list
  ; mutable builds_done : bool
  ; mutable last_checkpoint : float
  ; gc_dir : string
  }

exception Cancelled

let now = Unix.gettimeofday
let values table = Hashtbl.to_seq_values table |> List.of_seq

let availability t path =
  Option.value (Hashtbl.find_opt t.available path) ~default:Plan.Missing

let changed t = t.generation <- t.generation + 1

let set_availability t path value =
  if availability t path <> value
  then (
    t.availability_epoch <- t.availability_epoch + 1;
    changed t);
  Hashtbl.replace t.available path value

let full_log t path = Filename.concat t.config.report_dir path

let duration start finish =
  match start with
  | None -> 0.
  | Some s -> max 0. (Option.value finish ~default:(now ()) -. s)

let event t kind fields =
  let drv = Json.string (Json.member "drvPath" (`Assoc fields)) in
  let fields =
    match Plan.find t.graph drv with
    | Some node when not (List.mem_assoc "name" ~map:fields) ->
      ("name", `String node.name) :: fields
    | _ -> fields
  in
  let fields =
    if drv = "" || List.mem_assoc "neededBy" ~map:fields
    then fields
    else
      ( "neededBy"
      , Json.strs
          (Option.value (Hashtbl.find_opt t.attribution drv) ~default:[]) )
      :: fields
  in
  let json =
    `Assoc
      (("time", `Float (now ()))
      :: ("type", `String kind)
      :: (t.event_context @ fields))
  in
  Report.append_event t.report json;
  Report.emit_event t.report json

let root_paths t (edge : Plan.edge) =
  let node =
    match Plan.find t.graph edge.drv_path with
    | Some _ as node -> node
    | None ->
      Option.map (fun a -> a.node) (Hashtbl.find_opt t.activities edge.drv_path)
  in
  match node with
  | None -> []
  | Some node ->
    List.filter_map node.outputs ~f:(fun (name, path) ->
      if List.mem "*" ~set:edge.outputs || List.mem name ~set:edge.outputs
      then path
      else None)

let complete_outputs t (edge : Plan.edge) predicate =
  let node =
    match Plan.find t.graph edge.drv_path with
    | Some _ as node -> node
    | None ->
      Option.map (fun a -> a.node) (Hashtbl.find_opt t.activities edge.drv_path)
  in
  match node with
  | None -> false
  | Some node ->
    let outputs =
      List.filter node.outputs ~f:(fun (name, _) ->
        List.mem "*" ~set:edge.outputs || List.mem name ~set:edge.outputs)
    in
    outputs <> []
    && List.for_all outputs ~f:(fun (_, p) ->
      match p with
      | None -> false
      | Some p ->
        let available =
          match availability t p with
          | Plan.Cached _ when not node.allow_substitutes -> Plan.Missing
          | available -> available
        in
        predicate available)

let local = function Plan.Local -> true | _ -> false
let cached = function Plan.Local | Cached _ -> true | Missing -> false

let roots t =
  values t.jobs
  |> List.sort ~cmp:(fun a b -> String.compare a.edge.drv_path b.edge.drv_path)

let job_json t (j : job) =
  let build_seconds =
    match Hashtbl.find_opt t.activities j.edge.drv_path with
    | None -> 0.
    | Some a -> a.build_seconds
  in
  `Assoc
    [ "attrs", Json.strs j.attrs
    ; "drvPath", `String j.edge.drv_path
    ; "name", `String j.name
    ; "system", `String j.system
    ; "state", `String j.state
    ; "cacheStatus", `String j.cache
    ; "queuedAt", `Float j.queued
    ; "startedAt", Json.optional (fun x -> `Float x) j.started
    ; "finishedAt", Json.optional (fun x -> `Float x) j.finished
    ; ( "queueSeconds"
      , `Float
          (max
             0.
             (Option.value
                j.started
                ~default:(Option.value j.finished ~default:(now ()))
             -. j.queued)) )
    ; "activeSeconds", `Float (duration j.started j.finished)
    ; "buildSeconds", `Float build_seconds
    ; "logPath", `String j.log
    ; ( "reproduction"
      , `String
          ("nix build -L --no-link "
          ^ Json.quote (Backend.edge_installable j.edge)) )
    ; "failure", j.failure
    ]

let needed_by t path =
  Option.value (Hashtbl.find_opt t.attribution path) ~default:[]

let index_graph t =
  Hashtbl.clear t.attribution;
  Hashtbl.clear t.output_producers;
  List.iter (Plan.nodes t.graph) ~f:(fun (node : Plan.node) ->
    List.iter node.outputs ~f:(fun (_, path) ->
      Option.iter
        (fun path ->
           if not (Hashtbl.mem t.output_producers path)
           then Hashtbl.add t.output_producers path node.drv_path)
        path));
  (* One traversal per requested derivation, not one traversal per displayed
     dependency per checkpoint. Attribute aliases share the traversal. *)
  List.iter
    (List.filter (roots t) ~f:(fun (j : job) -> j.state <> "cached"))
    ~f:(fun j ->
      let seen = Hashtbl.create 32
      and pending = Stack.create () in
      Stack.push j.edge.drv_path pending;
      while not (Stack.is_empty pending) do
        let drv = Stack.pop pending in
        if not (Hashtbl.mem seen drv)
        then (
          Hashtbl.add seen drv ();
          let attrs =
            Option.value (Hashtbl.find_opt t.attribution drv) ~default:[]
          in
          Hashtbl.replace t.attribution drv (j.attrs @ attrs);
          match Plan.find t.graph drv with
          | None -> ()
          | Some node ->
            List.iter node.inputs ~f:(fun (edge : Plan.edge) ->
              if edge.outputs <> [] then Stack.push edge.drv_path pending))
      done);
  Hashtbl.iter
    (fun drv attrs ->
       Hashtbl.replace
         t.attribution
         drv
         (List.sort_uniq ~cmp:String.compare attrs))
    t.attribution

let snapshot t =
  let timestamp key fallback =
    match List.assoc_opt key t.context with
    | Some (`Float value) -> value
    | _ -> fallback
  in
  let elapsed =
    max 0. (timestamp "finishedAt" (now ()) -. timestamp "startedAt" (now ()))
  in
  let derivations =
    values t.activities
    |> List.sort ~cmp:(fun a b ->
      String.compare a.node.drv_path b.node.drv_path)
    |> List.map ~f:(fun a ->
      let is_drv = String.ends_with ~suffix:".drv" a.node.drv_path in
      `Assoc
        [ ("drvPath", if is_drv then `String a.node.drv_path else `Null)
        ; ("path", if is_drv then `Null else `String a.node.drv_path)
        ; "kind", `String (if is_drv then "derivation" else "download")
        ; "name", `String a.node.name
        ; "system", `String a.node.system
        ; "state", `String a.state
        ; "phase", `String a.phase
        ; "startedAt", Json.optional (fun x -> `Float x) a.started
        ; "finishedAt", Json.optional (fun x -> `Float x) a.finished
        ; "active", `Int a.active
        ; "activeBuilds", `Int a.active_builds
        ; "activeDownloads", `Int a.active_downloads
        ; ( "seconds"
          , `Float
              (a.seconds
              +. if a.active > 0 then duration a.active_started None else 0.) )
        ; "buildSeconds", `Float a.build_seconds
        ; "downloadSeconds", `Float a.download_seconds
        ; "waitSeconds", `Float a.wait_seconds
        ; "logPath", `String a.log
        ; "outputPaths", Json.strs (List.filter_map a.node.outputs ~f:snd)
        ; "neededBy", Json.strs (needed_by t a.node.drv_path)
        ])
  in
  `Assoc
    [ "schemaVersion", `Int 1
    ; "context", `Assoc (("elapsedSeconds", `Float elapsed) :: t.context)
    ; "status", `String t.status
    ; ( "evaluation"
      , `Assoc
          [ "attrs", `Int t.eval_attrs
          ; "complete", `Bool t.eval_complete
          ; "errors", `List (List.rev t.eval_errors)
          ] )
    ; "jobs", `List (List.map (roots t) ~f:(job_json t))
    ; "derivations", `List derivations
    ; ( "cacheReuse"
      , `List
          (values t.cache_reuse
          |> List.sort ~cmp:(fun a b -> String.compare a.drv_path b.drv_path)
          |> List.map ~f:(fun i ->
            `Assoc
              [ "drvPath", `String i.drv_path
              ; "name", `String i.name
              ; "paths", Json.strs i.paths
              ; "source", `String i.source
              ; "state", `String i.state
              ; ( "seconds"
                , `Float
                    (if i.state = "importing"
                     then now () -. i.started
                     else i.seconds) )
              ; "error", Json.optional Json.str i.error
              ; "logPath", `String i.log
              ; "neededBy", Json.strs (needed_by t i.drv_path)
              ])) )
    ; ( "waits"
      , `List
          (Hashtbl.to_seq t.waits
          |> List.of_seq
          |> List.map ~f:(fun (id, (request_id, drvs, reason, started)) ->
            `Assoc
              [ "id", `String id
              ; "requestId", `String request_id
              ; "drvs", Json.strs drvs
              ; "reason", `String reason
              ; "startedAt", `Float started
              ; "seconds", `Float (now () -. started)
              ])) )
    ; ( "uploads"
      , `List
          (List.map (values t.uploads) ~f:(fun u ->
             `Assoc
               [ "path", `String u.path
               ; "state", `String u.state
               ; "seconds", `Float u.seconds
               ; "error", Json.optional Json.str u.error
               ; "logPath", `String u.log
               ])) )
    ; "plan", t.plan
    ; "planDiff", t.diff
    ; "rootFailures", `List (values t.failures)
    ; "warnings", Json.strs (List.rev t.warnings)
    ; "error", Json.optional Json.str t.fatal
    ]

let checkpoint t =
  if now () -. t.last_checkpoint >= 1.
  then (
    t.last_checkpoint <- now ();
    Report.write_snapshot t.report (snapshot t))

let progress t =
  let s = snapshot t in
  Report.write_snapshot t.report s;
  Report.emit_progress t.report s

let warning t message =
  let message = Json.clip 4096 message in
  if not (List.mem message ~set:t.warnings)
  then (
    t.warnings <- message :: t.warnings;
    event t "warning" [ "message", `String message ])

let transition t (j : job) state =
  if j.state <> state then changed t;
  j.state <- state;
  if state <> "queued" && state <> "submitted" then j.finished <- Some (now ());
  event
    t
    "job"
    [ "drvPath", `String j.edge.drv_path
    ; "attrs", Json.strs j.attrs
    ; "state", `String state
    ; "seconds", `Float (duration j.started j.finished)
    ];
  checkpoint t

let skip_cached t (j : job) ~is_local =
  j.cache <- (if is_local then "local" else "cached");
  if is_local && t.config.copy_to <> None
  then Hashtbl.replace t.candidates j.edge.drv_path ();
  transition t j "cached"

let pending_roots t =
  roots t
  |> List.filter_map ~f:(fun (j : job) ->
    if j.state = "queued" then Some j.edge else None)

let skip_available_roots t =
  List.iter (roots t) ~f:(fun (j : job) ->
    if j.state = "queued" && complete_outputs t j.edge cached
    then skip_cached t j ~is_local:(complete_outputs t j.edge local))

let refresh_local t process_mgr paths =
  let paths = List.sort_uniq ~cmp:String.compare paths in
  let valid_paths, error =
    Backend.valid_paths process_mgr ~log_dir:(full_log t "logs") paths
  in
  Option.iter (warning t) error;
  let valid = Hashtbl.create (List.length valid_paths) in
  List.iter valid_paths ~f:(fun p -> Hashtbl.replace valid p ());
  List.iter paths ~f:(fun p ->
    if Hashtbl.mem valid p
    then set_availability t p Plan.Local
    else if error = None && availability t p = Plan.Local
    then set_availability t p Plan.Missing)

let probe t process_mgr stores ~fresh paths =
  let paths = List.sort_uniq ~cmp:String.compare paths in
  refresh_local t process_mgr paths;
  (* Apply the final observation once: a successful cache recheck must not
     invalidate every memoized root plan through a temporary Missing state. *)
  let observed = Hashtbl.create (List.length paths) in
  List.iter paths ~f:(fun p ->
    Hashtbl.replace
      observed
      p
      (if fresh then Plan.Missing else availability t p));
  List.iter stores ~f:(fun store ->
    let missing =
      List.filter paths ~f:(fun p ->
        (not (local (availability t p)))
        && not (cached (Hashtbl.find observed p)))
    in
    let infos, error =
      Backend.path_info
        process_mgr
        ~log_dir:(full_log t "logs")
        ~store
        ~fresh
        missing
    in
    Option.iter (warning t) error;
    List.iter infos ~f:(fun (p, info) ->
      Hashtbl.replace observed p (Plan.Cached info)));
  List.iter paths ~f:(fun p ->
    if not (local (availability t p))
    then set_availability t p (Hashtbl.find observed p))

let make_plan t process_mgr stores =
  (* The evaluator already checked every output of cached roots. Only inspect
     roots that still need work, in one batch, before expanding any graphs. *)
  probe
    t
    process_mgr
    stores
    ~fresh:false
    (List.concat_map (pending_roots t) ~f:(root_paths t));
  skip_available_roots t;
  let work_roots = pending_roots t in
  (if work_roots <> []
   then
     let graph =
       Backend.graph
         process_mgr
         (List.map work_roots ~f:(fun (e : Plan.edge) -> e.drv_path))
     in
     (* Keep the evaluator's shallow nodes for skipped roots and its output
        paths for fixed-output forms omitted by derivation-show JSON. *)
     t.graph <- Plan.merge t.graph graph);
  let visited = Hashtbl.create 128 in
  let rec walk edges =
    let edges =
      List.filter edges ~f:(fun (e : Plan.edge) ->
        let key = e.drv_path, e.outputs in
        if Hashtbl.mem visited key
        then false
        else (
          Hashtbl.add visited key ();
          true))
    in
    if edges <> []
    then (
      probe
        t
        process_mgr
        stores
        ~fresh:false
        (List.concat_map edges ~f:(root_paths t)
        |> List.filter ~f:(fun path -> not (Hashtbl.mem t.available path)));
      let next =
        List.concat_map edges ~f:(fun e ->
          if complete_outputs t e cached
          then []
          else
            match Plan.find t.graph e.drv_path with
            | None -> []
            | Some n -> n.inputs)
      in
      walk next)
  in
  walk work_roots;
  skip_available_roots t;
  if work_roots <> [] then index_graph t;
  let work_roots = pending_roots t in
  let references_seen = Hashtbl.create 128 in
  let rec references paths =
    let paths =
      paths
      |> List.sort_uniq ~cmp:String.compare
      |> List.filter ~f:(fun p ->
        if Hashtbl.mem references_seen p
        then false
        else (
          Hashtbl.add references_seen p ();
          true))
    in
    if paths <> []
    then (
      probe
        t
        process_mgr
        stores
        ~fresh:false
        (List.filter paths ~f:(fun path -> not (Hashtbl.mem t.available path)));
      references
        (List.concat_map paths ~f:(fun path ->
           match availability t path with
           | Plan.Cached info -> info.references
           | Local | Missing -> [])))
  in
  (* Cached requests are skipped, so their runtime closure is not downloaded.
     Follow references only from substitutes needed by the remaining builds. *)
  let required =
    Plan.compute t.graph ~roots:work_roots ~availability:(availability t)
  in
  references
    (List.map required.downloads ~f:(fun (d : Plan.download) -> d.path));
  let plan =
    Plan.compute t.graph ~roots:work_roots ~availability:(availability t)
  in
  let plan = { plan with roots = t.roots } in
  t.plan <- Plan.to_yojson plan;
  Json.atomic_write (Filename.concat t.config.report_dir "plan.json") t.plan;
  Option.iter
    (fun path ->
       let previous = Json.read path in
       let previous =
         match Json.member "plan" previous with
         | `Null -> previous
         | plan -> plan
       in
       match Plan.diff ~previous ~current:plan with
       | Error e -> failwith e
       | Ok d ->
         t.diff <-
           `Assoc
             [ "addedBuilds", Json.strs d.added_builds
             ; "removedBuilds", Json.strs d.removed_builds
             ; "addedDownloads", Json.strs d.added_downloads
             ; "removedDownloads", Json.strs d.removed_downloads
             ])
    t.config.compare;
  event t "plan" [ "plan", t.plan; "diff", t.diff ];
  Report.emit_plan t.report (snapshot t);
  Option.iter
    (fun attr ->
       let job =
         List.find_opt (roots t) ~f:(fun j ->
           List.mem attr ~set:j.attrs || j.edge.drv_path = attr)
       in
       match job with
       | None -> failwith ("Unknown attribute for --explain: " ^ attr)
       | Some j ->
         let p =
           Plan.compute
             t.graph
             ~roots:(if j.state = "cached" then [] else [ j.edge ])
             ~availability:(availability t)
         in
         let p = { p with roots = [ j.edge ] } in
         let paths =
           List.filter_map p.builds ~f:(fun (n : Plan.node) ->
             Option.map
               (fun path -> n.drv_path, Json.strs path)
               (Plan.explain
                  t.graph
                  ~availability:(availability t)
                  ~root:j.edge
                  ~target:n.drv_path))
         in
         let explanation =
           `Assoc
             [ "attr", `String attr
             ; "plan", Plan.to_yojson p
             ; "dependencyPaths", `Assoc paths
             ]
         in
         Json.atomic_write
           (Filename.concat t.config.report_dir "explanation.json")
           explanation;
         Printf.printf "%s\n%!" (Yojson.Safe.pretty_to_string explanation))
    t.config.explain;
  checkpoint t

let evaluate t process_mgr =
  let log = full_log t "logs/evaluation.log" in
  let add_error attr error =
    t.eval_errors <-
      `Assoc [ "attr", `String attr; "error", `String error ] :: t.eval_errors;
    event t "evaluation-error" [ "attr", `String attr; "error", `String error ]
  in
  let on_stdout line =
    match Yojson.Safe.from_string line with
    | json ->
      let attr = Json.string (Json.member "attr" json) in
      let error = Json.member "error" json in
      t.eval_attrs <- t.eval_attrs + 1;
      if error <> `Null
      then
        add_error
          attr
          (match error with `String s -> s | _ -> Yojson.Safe.to_string error)
      else
        let drv = Json.string (Json.member "drvPath" json) in
        if drv = ""
        then add_error attr ("Missing drvPath: " ^ Json.clip 1024 line)
        else (
          match Hashtbl.find_opt t.jobs drv with
          | Some j ->
            j.attrs <- List.sort_uniq ~cmp:String.compare (attr :: j.attrs)
          | None ->
            let edge = { Plan.drv_path = drv; outputs = [ "*" ] } in
            let name = Json.string (Json.member "name" json)
            and system = Json.string (Json.member "system" json) in
            let outputs =
              Json.assoc (Json.member "outputs" json)
              |> List.map ~f:(fun (n, j) ->
                n, match j with `String p -> Some p | _ -> None)
            in
            let inputs =
              Json.assoc (Json.member "inputDrvs" json)
              |> List.map ~f:(fun (drv_path, outs) ->
                { Plan.drv_path; outputs = Json.strings outs })
            in
            t.graph <-
              Plan.merge
                t.graph
                (Plan.of_nodes
                   [ { Plan.drv_path = drv
                     ; name
                     ; system
                     ; inputs
                     ; outputs
                     ; allow_substitutes = true
                     }
                   ]);
            let job =
              { edge
              ; attrs = [ attr ]
              ; name
              ; system
              ; cache = Json.string (Json.member "cacheStatus" json)
              ; queued = now ()
              ; started = None
              ; finished = None
              ; state = "queued"
              ; failure = `Null
              ; log = ""
              }
            in
            Hashtbl.add t.jobs drv job;
            event t "evaluated" [ "drvPath", `String drv; "attr", `String attr ];
            if
              (job.cache = "local" || job.cache = "cached")
              && complete_outputs t edge (fun _ -> true)
            then (
              let is_local = job.cache = "local" in
              if is_local
              then
                List.iter (root_paths t edge) ~f:(fun path ->
                  set_availability t path Plan.Local);
              (* Do not invent remote reference metadata here: a cached root can
                 also be needed by an uncached root, in which case its real
                 metadata must be probed while planning that build. *)
              skip_cached t job ~is_local))
    | exception Yojson.Json_error error ->
      add_error
        "<evaluation>"
        ("Invalid evaluation JSON: " ^ Json.clip 1024 error)
  in
  let result =
    Backend.run
      process_mgr
      ~capture:false
      ~log_path:log
      ~on_stdout
      [ "nix-eval-jobs"
      ; "--gc-roots-dir"
      ; t.gc_dir
      ; "--force-recurse"
      ; "--check-cache-status"
      ; "--show-input-drvs"
      ; "--workers"
      ; string_of_int t.config.jobs
      ; "--flake"
      ; t.config.flake
      ]
  in
  t.eval_complete <- Backend.successful result;
  if not t.eval_complete then add_error "<evaluation>" (Backend.error result);
  t.roots <- List.map (roots t) ~f:(fun j -> j.edge);
  checkpoint t

let load_prepared t process_mgr (graph, requests) =
  let module Requests = Map.Make (String) in
  t.graph <- graph;
  let requests =
    List.fold_left
      requests
      ~init:Requests.empty
      ~f:(fun requests ((edge : Plan.edge), attrs) ->
        let edge =
          { Plan.drv_path = Plan.normalize_drv_path edge.drv_path
          ; outputs = List.sort_uniq ~cmp:String.compare edge.outputs
          }
        in
        let node =
          match Plan.find graph edge.drv_path with
          | Some node -> node
          | None ->
            failwith ("Prepared root is absent from the graph: " ^ edge.drv_path)
        in
        let outputs =
          if List.mem "*" ~set:edge.outputs
          then List.map node.outputs ~f:fst
          else edge.outputs
        in
        if outputs = []
        then failwith ("Prepared root selects no outputs: " ^ edge.drv_path);
        List.iter outputs ~f:(fun output ->
          if not (List.mem_assoc output ~map:node.outputs)
          then
            failwith ("Unknown prepared output: " ^ edge.drv_path ^ "^" ^ output));
        let attrs = if attrs = [] then [ node.name ] else attrs in
        let previous_outputs, previous_attrs =
          match Requests.find_opt edge.drv_path requests with
          | None -> [], []
          | Some ((previous : Plan.edge), attrs) -> previous.outputs, attrs
        in
        let edge =
          { edge with
            outputs =
              List.sort_uniq ~cmp:String.compare (outputs @ previous_outputs)
          }
        in
        Requests.add
          edge.drv_path
          (edge, List.sort_uniq ~cmp:String.compare (attrs @ previous_attrs))
          requests)
  in
  Requests.iter
    (fun drv ((edge : Plan.edge), attrs) ->
       let node = Option.get (Plan.find graph drv) in
       let job =
         { edge
         ; attrs
         ; name = node.name
         ; system = node.system
         ; cache = "unknown"
         ; queued = now ()
         ; started = None
         ; finished = None
         ; state = "queued"
         ; failure = `Null
         ; log = ""
         }
       in
       Hashtbl.add t.jobs drv job;
       t.eval_attrs <- t.eval_attrs + List.length attrs;
       List.iter attrs ~f:(fun attr ->
         event
           t
           "evaluated"
           [ "drvPath", `String drv
           ; "attr", `String attr
           ; "prepared", `Bool true
           ]))
    requests;
  t.roots <- List.map (roots t) ~f:(fun j -> j.edge);
  (* The evaluator normally pins these files. Prepared execution has no
     evaluator process, so retain the imported recipe closure ourselves. No
     availability from the planner is reused; make_plan probes this worker. *)
  Backend.pin_derivations
    process_mgr
    ~root:(Filename.concat t.gc_dir "prepared")
    (List.map t.roots ~f:(fun (edge : Plan.edge) -> edge.drv_path));
  t.eval_complete <- true;
  checkpoint t

let get_activity t drv =
  match Hashtbl.find_opt t.activities drv with
  | Some a -> a
  | None ->
    let node =
      Option.value
        (Plan.find t.graph drv)
        ~default:
          { Plan.drv_path = drv
          ; name = Filename.basename drv
          ; system = ""
          ; inputs = []
          ; allow_substitutes = false
          ; outputs =
              (if String.ends_with ~suffix:".drv" drv
               then []
               else [ "out", Some drv ])
          }
    in
    let a =
      { node
      ; state = "waiting"
      ; phase = ""
      ; started = None
      ; finished = None
      ; seconds = 0.
      ; build_seconds = 0.
      ; download_seconds = 0.
      ; wait_seconds = 0.
      ; active_started = None
      ; building = false
      ; active = 0
      ; active_builds = 0
      ; active_downloads = 0
      ; log = "logs/" ^ Filename.basename drv ^ ".log"
      ; tail = []
      }
    in
    Hashtbl.add t.activities drv a;
    a

let append_log t (a : activity) line =
  let ch =
    open_out_gen
      [ Open_wronly; Open_append; Open_creat; Open_binary ]
      0o600
      (full_log t a.log)
  in
  Fun.protect
    ~finally:(fun () -> close_out_noerr ch)
    (fun () ->
       output_string ch line;
       output_char ch '\n');
  a.tail <-
    Json.clip 4096 line
    ::
    (let rec take n = function
       | [] -> []
       | _ when n = 0 -> []
       | x :: xs -> x :: take (n - 1) xs
     in
     take 49 a.tail)

let mark_failure t ~kind ~message ~log ~excerpt drv =
  if not (Hashtbl.mem t.failures drv)
  then (
    let a = get_activity t drv in
    a.state <- "failed";
    let affected =
      roots t
      |> List.filter ~f:(fun (j : job) ->
        j.state <> "cached"
        && Plan.explain
             t.graph
             ~availability:(availability t)
             ~root:j.edge
             ~target:drv
           <> None)
      |> List.concat_map ~f:(fun j -> j.attrs)
    in
    let failure =
      `Assoc
        [ "drvPath", `String drv
        ; "name", `String a.node.name
        ; "kind", `String kind
        ; "message", `String message
        ; "affected", Json.strs affected
        ; "logPath", `String log
        ; "excerpt", Json.strs excerpt
        ]
    in
    Hashtbl.add t.failures drv failure;
    changed t;
    event t "root-failure" [ "failure", failure ];
    Report.emit_failure t.report failure)

let record_failure t (j : job) drv kind message =
  let path =
    Option.value
      (Plan.explain
         t.graph
         ~availability:(fun _ -> Plan.Missing)
         ~root:j.edge
         ~target:drv)
      ~default:[ j.edge.drv_path; drv ]
  in
  j.failure <-
    `Assoc
      [ "kind", `String kind
      ; "message", `String message
      ; "rootDrv", `String drv
      ; "dependencyPath", Json.strs path
      ];
  transition t j (if drv = j.edge.drv_path then "failed" else "blocked")

let run_build t process_mgr clock stores ~cancel_grace batch =
  let request_id =
    Digest.to_hex
      (Digest.string
         (String.concat
            ~sep:"\n"
            (List.map batch ~f:(fun j -> j.edge.drv_path))))
  in
  let observed = Hashtbl.create 32
  and explicit_failures = Hashtbl.create 8 in
  let rec attempt number remaining =
    let log = Printf.sprintf "logs/request-%s-%d.log" request_id number in
    List.iter remaining ~f:(fun (j : job) -> j.log <- log);
    let ids = Hashtbl.create 32 in
    let wait_ids = Hashtbl.create 4 in
    let stop_wait id =
      Option.iter
        (fun key ->
           let _, drvs, reason, started = Hashtbl.find t.waits key in
           Hashtbl.remove wait_ids id;
           Hashtbl.remove t.waits key;
           event
             t
             "request-wait-ended"
             [ "requestId", `String request_id
             ; "drvs", Json.strs drvs
             ; "reason", `String reason
             ; "seconds", `Float (now () -. started)
             ])
        (Hashtbl.find_opt wait_ids id)
    in
    let on_stderr line =
      let open Activity in
      match parse line with
      | Start { id; kind = 111; fields = []; text; _ } ->
        let key = request_id ^ ":" ^ string_of_int number ^ ":" ^ id in
        let drvs = List.map remaining ~f:(fun j -> j.edge.drv_path) in
        Hashtbl.replace wait_ids id key;
        Hashtbl.replace t.waits key (request_id, drvs, strip_ansi text, now ());
        event
          t
          "request-wait"
          [ "requestId", `String request_id
          ; "drvs", Json.strs drvs
          ; "reason", `String (strip_ansi text)
          ]
      | Start { id; kind; fields; text; _ }
        when kind = 105 || kind = 108 || kind = 111 ->
        (match fields with
        | `String path :: _ ->
          let drv =
            if kind = 108
            then
              Some
                (Option.value
                   (Hashtbl.find_opt t.output_producers path)
                   ~default:path)
            else Some path
          in
          Option.iter
            (fun drv ->
               let a = get_activity t drv in
               (if not (String.ends_with ~suffix:".drv" drv)
                then
                  let attrs =
                    List.concat_map remaining ~f:(fun j -> j.attrs)
                    @ needed_by t drv
                  in
                  Hashtbl.replace
                    t.attribution
                    drv
                    (List.sort_uniq ~cmp:String.compare attrs));
               append_log t a (strip_ansi text);
               Hashtbl.replace ids id (drv, kind, now ());
               Hashtbl.replace observed drv ();
               if a.started = None then a.started <- Some (now ());
               if a.active = 0 then a.active_started <- Some (now ());
               a.finished <- None;
               a.active <- a.active + 1;
               if kind = 105 then a.active_builds <- a.active_builds + 1;
               if kind = 108 then a.active_downloads <- a.active_downloads + 1;
               a.building <- a.building || kind = 105;
               a.state <-
                 (if a.active_builds > 0
                  then "building"
                  else if a.active_downloads > 0
                  then "downloading"
                  else "waiting");
               event
                 t
                 "activity-start"
                 [ "drvPath", `String drv
                 ; "state", `String a.state
                 ; "active", `Int a.active
                 ];
               checkpoint t)
            drv
        | _ -> ())
      | Result { id; kind; fields } ->
        Option.iter
          (fun (drv, _, _) ->
             let a = get_activity t drv in
             match fields with
             | `String text :: _ when kind = 104 ->
               a.phase <- text;
               event t "phase" [ "drvPath", `String drv; "phase", `String text ]
             | `String text :: _ when kind = 101 -> append_log t a text
             | _ -> ())
          (Hashtbl.find_opt ids id)
      | Stop id ->
        stop_wait id;
        Option.iter
          (fun (drv, kind, started) ->
             Hashtbl.remove ids id;
             let a = get_activity t drv in
             let elapsed = now () -. started in
             if kind = 105
             then a.build_seconds <- a.build_seconds +. elapsed
             else if kind = 108
             then a.download_seconds <- a.download_seconds +. elapsed
             else a.wait_seconds <- a.wait_seconds +. elapsed;
             a.active <- max 0 (a.active - 1);
             if kind = 105 then a.active_builds <- max 0 (a.active_builds - 1);
             if kind = 108
             then a.active_downloads <- max 0 (a.active_downloads - 1);
             if a.active = 0
             then (
               a.seconds <- a.seconds +. duration a.active_started None;
               a.active_started <- None;
               a.finished <- Some (now ());
               Hashtbl.replace t.candidates drv ());
             (* A stopped substitution is finished even if Nix only requested
                one output of a multi-output derivation. It must not remain an
                active wait until every unrelated output becomes local. *)
             a.state <-
               (if a.active_builds > 0
                then "building"
                else if a.active_downloads > 0
                then "downloading"
                else if a.active > 0
                then "waiting"
                else "finished");
             event
               t
               "activity-stop"
               [ "drvPath", `String drv
               ; "state", `String a.state
               ; "seconds", `Float a.seconds
               ; "active", `Int a.active
               ];
             checkpoint t)
          (Hashtbl.find_opt ids id)
      | Message { message; _ } ->
        List.iter (failed_derivations message) ~f:(fun drv ->
          Hashtbl.replace explicit_failures drv message)
      | _ -> ()
    in
    let result =
      Fun.protect
        ~finally:(fun () ->
          Hashtbl.to_seq_keys wait_ids |> List.of_seq |> List.iter ~f:stop_wait)
        (fun () ->
           Option.iter
             (fun allowed ->
                (* Prepared workers may only build their own derivations. Check
                   the local graph at every actual dispatch (including retries),
                   so a vanished remote hit cannot turn into an unowned fallback
                   build. Live cache cuts have been imported and pinned by the
                   orchestrator before reaching this point. *)
                let paths =
                  let possible =
                    Plan.compute
                      t.graph
                      ~roots:(List.map remaining ~f:(fun j -> j.edge))
                      ~availability:(fun _ -> Plan.Missing)
                  in
                  List.concat_map possible.builds ~f:(fun (node : Plan.node) ->
                    List.filter_map node.outputs ~f:snd)
                  |> List.sort_uniq ~cmp:String.compare
                in
                let local = Hashtbl.create (List.length paths) in
                let valid, warning =
                  Backend.valid_paths
                    process_mgr
                    ~log_dir:(Filename.concat t.config.report_dir "logs")
                    paths
                in
                Option.iter failwith warning;
                List.iter valid ~f:(fun path -> Hashtbl.replace local path ());
                let plan =
                  Plan.compute
                    t.graph
                    ~roots:(List.map remaining ~f:(fun j -> j.edge))
                    ~availability:(fun path ->
                      if Hashtbl.mem local path
                      then Plan.Local
                      else Plan.Missing)
                in
                if plan.unknown <> []
                then
                  failwith
                    ("Unresolved prepared execution requirements: "
                    ^ String.concat ~sep:", " plan.unknown);
                let outside =
                  List.filter_map plan.builds ~f:(fun (node : Plan.node) ->
                    if List.mem node.drv_path ~set:allowed
                    then None
                    else Some node.drv_path)
                in
                if outside <> []
                then
                  failwith
                    ("Refusing to build another group's dependencies: "
                    ^ String.concat ~sep:", " outside))
             t.allowed_builds;
           Backend.build_edges
             process_mgr
             ~substituters:stores
             ~cancel_grace
             ~log_path:(full_log t log)
             ~on_stderr
             (List.map remaining ~f:(fun j -> j.edge)))
    in
    let paths =
      List.concat_map remaining ~f:(fun j -> root_paths t j.edge)
      @ (Hashtbl.to_seq_keys observed
        |> List.of_seq
        |> List.concat_map ~f:(fun drv ->
          root_paths t { Plan.drv_path = drv; outputs = [ "*" ] }))
    in
    refresh_local t process_mgr paths;
    Hashtbl.iter
      (fun drv () ->
         let a = get_activity t drv in
         if complete_outputs t { Plan.drv_path = drv; outputs = [ "*" ] } local
         then a.state <- (if a.building then "built" else "cached");
         Hashtbl.replace t.candidates drv ())
      observed;
    let unfinished =
      List.filter remaining ~f:(fun j ->
        if complete_outputs t j.edge local
        then (
          Hashtbl.replace t.candidates j.edge.drv_path ();
          transition t j "built";
          false)
        else true)
    in
    if unfinished <> []
    then (
      let request_transient =
        (not (Backend.successful result)) && Backend.transient result.tail
      in
      let request_message =
        if Backend.successful result
        then "Nix returned success without realizing every requested output"
        else Json.clip 4096 (Backend.error result)
      in
      let explicit =
        Hashtbl.to_seq explicit_failures
        |> List.of_seq
        |> List.filter_map ~f:(fun (drv, message) ->
          if complete_outputs t { Plan.drv_path = drv; outputs = [ "*" ] } local
          then None
          else
            let a = get_activity t drv in
            (* A batch may contain a compiler failure and an unrelated HTTP
               failure. Only this derivation's own diagnostics classify it. *)
            let kind =
              if Backend.transient (message :: a.tail)
              then "download"
              else "build"
            in
            Some (drv, (kind, message)))
      in
      let details drv =
        match List.assoc_opt drv explicit with
        | Some details -> details
        | None ->
          (match Hashtbl.find_opt t.failures drv with
          | Some failure ->
            ( Json.string (Json.member "kind" failure)
            , Json.string (Json.member "message" failure) )
          | None -> "request", request_message)
      in
      let save_failure drv kind message =
        if not (Hashtbl.mem t.failures drv)
        then
          let a = get_activity t drv in
          mark_failure
            t
            ~kind
            ~message
            ~log:(if a.tail = [] then log else a.log)
            ~excerpt:
              (if a.tail = []
               then Backend.readable_lines result.tail
               else List.rev a.tail)
            drv
      in
      (* Deterministic failures are final immediately; a later retry of a
         different root must neither erase them nor retry their dependents. *)
      List.iter explicit ~f:(fun (drv, (kind, message)) ->
        if kind = "build" then save_failure drv kind message);
      let failed =
        List.map explicit ~f:fst
        @ (Hashtbl.to_seq_keys t.failures |> List.of_seq)
      in
      let retry = ref [] in
      List.iter unfinished ~f:(fun j ->
        let causes =
          Plan.failed_ancestors
            t.graph
            ~availability:(availability t)
            ~root:j.edge
            ~failed
        in
        let deterministic =
          List.find_opt causes ~f:(fun drv -> fst (details drv) = "build")
        in
        let cause =
          match deterministic with
          | Some _ as cause -> cause
          | None -> List.nth_opt causes 0
        in
        let drv, kind, message, retryable =
          match cause with
          | Some drv ->
            let kind, message = details drv in
            drv, kind, message, kind = "download"
          | None ->
            j.edge.drv_path, "request", request_message, request_transient
        in
        if retryable && number < t.config.retries
        then retry := j :: !retry
        else (
          save_failure drv kind message;
          record_failure t j drv kind message));
      let retry = List.rev !retry in
      (* Keep final explicit causes, including another failed input of a blocked
         root. A transient input abandoned because a different input failed has
         not exhausted its retry budget: a queued independent root may still
         need it, so it must not become a permanent blocker yet. *)
      List.iter explicit ~f:(fun (drv, (kind, message)) ->
        let still_needed =
          List.exists retry ~f:(fun j ->
            Plan.failed_ancestors
              t.graph
              ~availability:(availability t)
              ~root:j.edge
              ~failed:[ drv ]
            <> [])
        in
        if (not still_needed) && (kind = "build" || number >= t.config.retries)
        then save_failure drv kind message);
      if retry <> []
      then (
        event
          t
          "retry"
          [ "attempt", `Int (number + 1)
          ; "drvs", Json.strs (List.map retry ~f:(fun j -> j.edge.drv_path))
          ];
        Eio.Time.sleep clock (min 10. (2. ** float_of_int number));
        Hashtbl.clear explicit_failures;
        attempt (number + 1) retry))
  in
  attempt 0 batch

let history_duration config graph =
  let by_drv = Hashtbl.create 32
  and by_name = Hashtbl.create 32 in
  Option.iter
    (fun path ->
       let json = Json.read path in
       List.iter
         (Json.list (Json.member "derivations" json))
         ~f:(fun j ->
           let drv = Json.string (Json.member "drvPath" j) in
           let seconds =
             match Json.member "buildSeconds" j with
             | `Null -> Json.number (Json.member "seconds" j)
             | value -> Json.number value
           in
           if seconds > 0. && Float.is_finite seconds
           then (
             Hashtbl.replace by_drv drv seconds;
             Hashtbl.replace
               by_name
               ( Json.string (Json.member "system" j)
               , Json.string (Json.member "name" j) )
               seconds)))
    config.history;
  fun drv ->
    match Hashtbl.find_opt by_drv drv with
    | Some _ as value -> value
    | None ->
      Option.bind (Plan.find graph drv) (fun n ->
        Hashtbl.find_opt by_name (n.system, n.name))

let scheduler t process_mgr clock stores ~cancel_grace =
  let max_active = 2 * t.config.jobs in
  let active = ref 0
  and duration = history_duration t.config t.graph in
  let plans = Hashtbl.create 128 in
  let plan_epoch = ref t.availability_epoch in
  let plan_for_root (edge : Plan.edge) =
    if !plan_epoch <> t.availability_epoch
    then (
      Hashtbl.clear plans;
      plan_epoch := t.availability_epoch);
    let key = edge.drv_path, List.sort_uniq ~cmp:String.compare edge.outputs in
    match Hashtbl.find_opt plans key with
    | Some plan -> plan
    | None ->
      let plan =
        Plan.compute t.graph ~roots:[ edge ] ~availability:(availability t)
      in
      Hashtbl.add plans key plan;
      plan
  in
  let blocked_generation = ref None in
  Eio.Switch.run (fun sw ->
    let rec loop () =
      if !active >= max_active || !blocked_generation = Some t.generation
      then (
        (* Waiting on another request cannot change priorities or readiness. In
           particular, avoid walking thousands of shared dependency graphs every
           polling tick while a toolchain is still building. *)
        Eio.Time.sleep clock 0.05;
        loop ())
      else
        let requested = roots t in
        let pending =
          List.filter requested ~f:(fun (j : job) -> j.state = "queued")
        in
        (* Re-check every admitted root before failure propagation: another
           worker may already have built it, or a new substitute can bypass a
           failed input. *)
        if pending = [] && !active = 0
        then ()
        else if pending = []
        then (
          blocked_generation := Some t.generation;
          Eio.Time.sleep clock 0.05;
          loop ())
        else
          let ranked =
            Plan.rank
              ~plan_for_root
              t.graph
              ~availability:(availability t)
              ~failed:[]
              ~now:(now ())
              ~duration
              ~pending:(List.map pending ~f:(fun j -> j.edge, j.queued))
          in
          let active_work = Hashtbl.create 128 in
          List.iter requested ~f:(fun (j : job) ->
            if j.state = "submitted"
            then
              List.iter (plan_for_root j.edge).builds ~f:(fun (n : Plan.node) ->
                Hashtbl.replace active_work n.drv_path ()));
          let ready =
            List.filter ranked ~f:(fun (edge : Plan.edge) ->
              let needed = plan_for_root edge in
              not
                (List.exists needed.builds ~f:(fun (n : Plan.node) ->
                   Hashtbl.mem active_work n.drv_path
                   || (n.drv_path <> edge.drv_path
                      &&
                      match Hashtbl.find_opt t.jobs n.drv_path with
                      | Some j -> j.state = "queued" || j.state = "submitted"
                      | None -> false))))
          in
          let first = match ready with [] -> None | x :: _ -> Some x in
          match first with
          | None ->
            if !active = 0
            then failwith "No schedulable roots (cyclic dependency graph)";
            blocked_generation := Some t.generation;
            Eio.Time.sleep clock 0.05;
            loop ()
          | Some first ->
            let initial = Hashtbl.find t.jobs first.drv_path in
            let first_work = Hashtbl.create 128 in
            List.iter (plan_for_root first).builds ~f:(fun (n : Plan.node) ->
              Hashtbl.replace first_work n.drv_path ());
            let related e =
              List.exists (plan_for_root e).builds ~f:(fun (n : Plan.node) ->
                Hashtbl.mem first_work n.drv_path)
            in
            let rec take n = function
              | [] -> []
              | _ when n = 0 -> []
              | (e : Plan.edge) :: es ->
                Hashtbl.find t.jobs e.drv_path :: take (n - 1) es
            in
            let others =
              List.filter ready ~f:(fun (e : Plan.edge) ->
                e.drv_path <> first.drv_path && related e)
            in
            let batch = initial :: take (t.config.batch_size - 1) others in
            probe
              t
              process_mgr
              stores
              ~fresh:true
              (List.concat_map batch ~f:(fun j -> root_paths t j.edge));
            let failed = Hashtbl.to_seq_keys t.failures |> List.of_seq in
            let batch =
              List.filter batch ~f:(fun j ->
                if complete_outputs t j.edge cached
                then (
                  skip_cached t j ~is_local:(complete_outputs t j.edge local);
                  false)
                else
                  match
                    Plan.failed_ancestors
                      t.graph
                      ~availability:(availability t)
                      ~root:j.edge
                      ~failed
                  with
                  | drv :: _ ->
                    record_failure
                      t
                      j
                      drv
                      "dependency"
                      "A required derivation failed";
                    false
                  | [] -> true)
            in
            if batch <> []
            then (
              List.iter batch ~f:(fun (j : job) ->
                j.started <- Some (now ());
                transition t j "submitted");
              incr active;
              Eio.Fiber.fork ~sw (fun () ->
                Fun.protect
                  ~finally:(fun () ->
                    decr active;
                    changed t)
                  (fun () ->
                     run_build t process_mgr clock stores ~cancel_grace batch)));
            loop ()
    in
    loop ());
  t.builds_done <- true

let cache_follower t process_mgr clock stores =
  if t.config.cache_refresh > 0. && stores <> []
  then (
    let interval = t.config.cache_refresh in
    let checks = Hashtbl.create 128 in
    let active = ref 0
    and serial = ref 0 in
    let jobs_by_attr = Hashtbl.create 128 in
    List.iter (roots t) ~f:(fun j ->
      List.iter j.attrs ~f:(fun attr -> Hashtbl.replace jobs_by_attr attr j));
    let live (j : job) = j.state = "queued" || j.state = "submitted" in
    let requirements = ref None in
    let current_plan () =
      match !requirements with
      | Some (generation, plan, required) when generation = t.generation ->
        plan, required
      | _ ->
        let roots =
          List.filter (roots t) ~f:live |> List.map ~f:(fun j -> j.edge)
        in
        let plan = Plan.compute t.graph ~roots ~availability:(availability t) in
        let required = Hashtbl.create 128 in
        let add (edge : Plan.edge) =
          if edge.outputs <> [] then Hashtbl.replace required edge.drv_path ()
        in
        List.iter roots ~f:add;
        (* Keep direct inputs even once their requested output is local: an
           in-flight import must still finish the derivation's other outputs.
           Inputs below a now-local ancestor disappear from this pruned plan. *)
        List.iter plan.builds ~f:(fun (node : Plan.node) ->
          List.iter node.inputs ~f:add);
        requirements := Some (t.generation, plan, required);
        plan, required
    in
    let needed drv =
      let _, required = current_plan () in
      Hashtbl.mem required drv
    in
    let needed_by_submitted drv =
      (* Existing Nix requests may still await input goals below an imported
         ancestor. Only queued consumers can safely use the newly pruned plan to
         abandon an in-flight import. *)
      List.exists (needed_by t drv) ~f:(fun attr ->
        Option.fold
          ~none:false
          ~some:(fun (j : job) -> j.state = "submitted")
          (Hashtbl.find_opt jobs_by_attr attr))
    in
    let busy drv =
      match Hashtbl.find_opt t.activities drv with
      | Some a -> a.active_builds > 0 || a.active_downloads > 0
      | None -> false
    in
    let check_for drv =
      match Hashtbl.find_opt checks drv with
      | Some check -> check
      | None ->
        let check = { next_check = 0.; misses = 0; failures = 0 } in
        Hashtbl.add checks drv check;
        check
    in
    let backoff check =
      let factor = 2. ** float_of_int (min 3 check.misses) in
      check.next_check <- now () +. max interval (min 300. (interval *. factor));
      check.misses <- min 3 (check.misses + 1)
    in
    let bounded seconds action =
      Eio.Fiber.first
        (fun () -> `Result (action ()))
        (fun () ->
           Eio.Time.sleep clock seconds;
           `Timeout)
    in
    let rec chunks size xs =
      let rec take n taken = function
        | rest when n = 0 -> List.rev taken, rest
        | [] -> List.rev taken, []
        | x :: rest -> take (n - 1) (x :: taken) rest
      in
      match xs with
      | [] -> []
      | _ ->
        let batch, rest = take size [] xs in
        batch :: chunks size rest
    in
    let local_paths paths =
      List.iter (chunks 128 paths) ~f:(fun paths ->
        match bounded 30. (fun () -> refresh_local t process_mgr paths) with
        | `Result () -> ()
        | `Timeout ->
          warning t "Dependency cache refresh: local query timed out")
    in
    let import ~sw (node : Plan.node) source paths =
      let drv = node.drv_path in
      let check = check_for drv in
      incr serial;
      let i =
        { drv_path = drv
        ; name = node.name
        ; paths
        ; source
        ; state = "importing"
        ; started = now ()
        ; seconds = 0.
        ; error = None
        ; log =
            Printf.sprintf
              "logs/cache-import-%s-%d.log"
              (Filename.basename drv)
              !serial
        }
      in
      Hashtbl.replace t.cache_reuse drv i;
      incr active;
      event
        t
        "cache-import-start"
        [ "drvPath", `String drv
        ; "source", `String source
        ; "paths", Json.strs paths
        ; "logPath", `String i.log
        ];
      checkpoint t;
      Eio.Fiber.fork ~sw (fun () ->
        Fun.protect
          ~finally:(fun () ->
            if i.state = "importing" then i.state <- "cancelled";
            i.seconds <- now () -. i.started;
            decr active;
            changed t;
            event
              t
              "cache-import-finished"
              [ "drvPath", `String drv
              ; "state", `String i.state
              ; "seconds", `Float i.seconds
              ; "error", Json.optional Json.str i.error
              ; "logPath", `String i.log
              ];
            checkpoint t)
          (fun () ->
             let failed message =
               i.state <- "failed";
               i.error <- Some (Json.clip 4096 message);
               check.failures <- check.failures + 1;
               backoff check;
               warning
                 t
                 ("Optional cache import for " ^ node.name ^ ": " ^ message)
             in
             try
               let result =
                 Eio.Fiber.first
                   (fun () ->
                      bounded 120. (fun () ->
                        Backend.copy_from
                          process_mgr
                          ~log_path:(full_log t i.log)
                          ~source
                          paths))
                   (fun () ->
                      let rec watch () =
                        if
                          busy drv || not (needed drv || needed_by_submitted drv)
                        then `Stopped
                        else (
                          Eio.Time.sleep clock 0.1;
                          watch ())
                      in
                      watch ())
               in
               match result with
               | `Stopped ->
                 i.state <- "cancelled";
                 i.error <-
                   Some "Dependency is already active or no longer needed"
               | `Timeout -> failed "Import timed out after 120 seconds"
               | `Result result ->
                 let edge = { Plan.drv_path = drv; outputs = [ "*" ] } in
                 local_paths (root_paths t edge);
                 if Backend.successful result && complete_outputs t edge local
                 then (
                   (* Keep queued consumers' imported outputs alive until their
                      build requests can establish their own temporary roots. *)
                   List.iter paths ~f:(fun path ->
                     match
                       bounded 30. (fun () ->
                         Backend.pin
                           process_mgr
                           ~root:
                             (Filename.concat
                                t.gc_dir
                                ("cache-" ^ Filename.basename path))
                           path)
                     with
                     | `Result () -> ()
                     | `Timeout ->
                       warning
                         t
                         "Dependency cache import: GC root registration timed \
                          out");
                   i.state <- "imported";
                   check.misses <- 0)
                 else if Backend.successful result
                 then
                   failed
                     "Copy finished without all derivation outputs being valid \
                      locally"
                 else failed (Backend.error result)
             with
             | Eio.Cancel.Cancelled _ as exn -> raise exn
             | exn -> failed (Printexc.to_string exn)))
    in
    let poll ~sw () =
      let plan, _ = current_plan () in
      let candidates =
        List.filter plan.builds ~f:(fun (n : Plan.node) ->
          let check = check_for n.drv_path in
          check.next_check <= now ()
          && check.failures < 3
          && n.allow_substitutes
          && (not (busy n.drv_path))
          && (not (Hashtbl.mem t.failures n.drv_path))
          && n.outputs <> []
          && List.for_all n.outputs ~f:(fun (_, p) -> p <> None)
          &&
          match Hashtbl.find_opt t.cache_reuse n.drv_path with
          | Some i -> i.state <> "importing"
          | None -> true)
        |> List.sort ~cmp:(fun (a : Plan.node) (b : Plan.node) ->
          let order =
            Float.compare
              (check_for a.drv_path).next_check
              (check_for b.drv_path).next_check
          in
          if order = 0 then String.compare a.drv_path b.drv_path else order)
      in
      let candidates =
        let rec take n = function
          | _ when n = 0 -> []
          | [] -> []
          | x :: xs -> x :: take (n - 1) xs
        in
        take 64 candidates
      in
      if candidates <> []
      then (
        (* A failed import must not immediately retry via a later substituter in
           this same pass, bypassing its newly scheduled cooldown. *)
        let attempted = Hashtbl.create 64 in
        List.iter candidates ~f:(fun (n : Plan.node) ->
          backoff (check_for n.drv_path));
        let all_paths =
          List.concat_map candidates ~f:(fun (n : Plan.node) ->
            List.filter_map n.outputs ~f:snd)
          |> List.sort_uniq ~cmp:String.compare
        in
        local_paths all_paths;
        event
          t
          "cache-refresh"
          [ "derivations", `Int (List.length candidates)
          ; "paths", `Int (List.length all_paths)
          ];
        List.iter stores ~f:(fun source ->
          if !active < 2
          then (
            let candidates =
              List.filter candidates ~f:(fun (n : Plan.node) ->
                needed n.drv_path
                && (not (Hashtbl.mem attempted n.drv_path))
                && (not (busy n.drv_path))
                && (not
                      (complete_outputs
                         t
                         { Plan.drv_path = n.drv_path; outputs = [ "*" ] }
                         local))
                &&
                match Hashtbl.find_opt t.cache_reuse n.drv_path with
                | Some i -> i.state <> "importing"
                | None -> true)
            in
            let paths =
              List.concat_map candidates ~f:(fun (n : Plan.node) ->
                List.filter_map n.outputs ~f:snd)
              |> List.sort_uniq ~cmp:String.compare
              |> List.filter ~f:(fun path -> not (local (availability t path)))
            in
            let found = Hashtbl.create (List.length paths) in
            List.iter (chunks 128 paths) ~f:(fun paths ->
              match
                bounded 30. (fun () ->
                  Backend.path_info
                    process_mgr
                    ~log_dir:(full_log t "logs")
                    ~store:source
                    ~fresh:true
                    paths)
              with
              | `Timeout ->
                warning t ("Dependency cache refresh timed out for " ^ source)
              | `Result (infos, error) ->
                Option.iter (warning t) error;
                List.iter infos ~f:(fun (path, _) ->
                  Hashtbl.replace found path ()));
            List.iter candidates ~f:(fun (n : Plan.node) ->
              let paths =
                List.filter_map n.outputs ~f:snd
                |> List.filter ~f:(fun path ->
                  not (local (availability t path)))
              in
              if
                !active < 2
                && paths <> []
                && needed n.drv_path
                && (not (busy n.drv_path))
                && (not (Hashtbl.mem attempted n.drv_path))
                && (check_for n.drv_path).failures < 3
                && List.for_all paths ~f:(Hashtbl.mem found)
              then (
                Hashtbl.add attempted n.drv_path ();
                import ~sw n source paths)))))
    in
    (* The follower owns only optional queries/imports. Ending the build phase
       cancels these children without delaying uploads or cancelling a
       builder. *)
    Eio.Fiber.first
      (fun () ->
         Eio.Switch.run (fun sw ->
           let rec loop () =
             Eio.Time.sleep clock interval;
             (try if !active < 2 then poll ~sw () with
             | Eio.Cancel.Cancelled _ as exn -> raise exn
             | exn ->
               warning t ("Dependency cache refresh: " ^ Printexc.to_string exn));
             loop ()
           in
           loop ()))
      (fun () ->
         let rec wait () =
           if not t.builds_done
           then (
             Eio.Time.sleep clock 0.1;
             wait ())
         in
         wait ()))

let uploader t process_mgr clock =
  let process_candidate drv =
    Hashtbl.remove t.candidates drv;
    let edge = { Plan.drv_path = drv; outputs = [ "*" ] } in
    let paths = root_paths t edge in
    refresh_local t process_mgr paths;
    let a = Hashtbl.find_opt t.activities drv in
    if complete_outputs t edge local
    then
      Option.iter
        (fun (a : activity) ->
           a.state <- (if a.building then "built" else "cached"))
        a;
    List.iter paths ~f:(fun path ->
      if
        local (availability t path)
        && (not (Hashtbl.mem t.uploads path))
        && (Hashtbl.mem t.jobs drv
           || Option.fold ~none:false ~some:(fun a -> a.building) a)
      then
        Option.iter
          (fun _ ->
             let name = Filename.basename path in
             let u =
               { path
               ; state = "queued"
               ; seconds = 0.
               ; error = None
               ; log = "logs/upload-" ^ name ^ ".log"
               }
             in
             Hashtbl.add t.uploads path u;
             match
               Backend.pin
                 process_mgr
                 ~root:(Filename.concat t.gc_dir ("upload-" ^ name))
                 path
             with
             | () -> event t "upload-queued" [ "path", `String path ]
             | exception Failure message ->
               u.state <- "failed";
               u.error <- Some message;
               event
                 t
                 "upload"
                 [ "path", `String path; "state", `String "failed" ])
          t.config.copy_to)
  in
  (* A fixed pool and bounded admission window, independent of build workers. *)
  let active = ref 0 in
  Eio.Switch.run (fun sw ->
    let rec loop () =
      let queued =
        values t.uploads
        |> List.filter ~f:(fun (u : upload) -> u.state = "queued")
      in
      (if List.length queued < 64
       then
         match Hashtbl.to_seq_keys t.candidates () with
         | Seq.Nil -> ()
         | Seq.Cons (drv, _) -> process_candidate drv);
      let queued =
        values t.uploads
        |> List.filter ~f:(fun (u : upload) -> u.state = "queued")
      in
      (match queued, t.config.copy_to with
      | u :: _, Some destination when !active < 2 ->
        incr active;
        u.state <- "uploading";
        Eio.Fiber.fork ~sw (fun () ->
          let started = now () in
          Fun.protect
            ~finally:(fun () -> decr active)
            (fun () ->
               let rec copy attempt =
                 let r =
                   Backend.copy
                     process_mgr
                     ~append:(attempt > 0)
                     ~log_path:(full_log t u.log)
                     ~destination
                     u.path
                 in
                 if
                   (not (Backend.successful r))
                   && Backend.transient r.tail
                   && attempt < t.config.retries
                 then (
                   event
                     t
                     "upload-retry"
                     [ "path", `String u.path; "attempt", `Int (attempt + 1) ];
                   Eio.Time.sleep clock (min 10. (2. ** float_of_int attempt));
                   copy (attempt + 1))
                 else r
               in
               let result = copy 0 in
               u.seconds <- now () -. started;
               u.state <-
                 (if Backend.successful result then "uploaded" else "failed");
               if u.state = "failed" then u.error <- Some (Backend.error result);
               event
                 t
                 "upload"
                 [ "path", `String u.path; "state", `String u.state ];
               let root =
                 Filename.concat t.gc_dir ("upload-" ^ Filename.basename u.path)
               in
               (try Unix.unlink root with
               | Unix.Unix_error (Unix.ENOENT, _, _) -> ());
               checkpoint t))
      | _ -> ());
      if
        t.builds_done
        && Hashtbl.length t.candidates = 0
        && queued = []
        && !active = 0
      then ()
      else (
        Eio.Time.sleep clock 0.05;
        loop ())
    in
    loop ())

let run ?prepared ?substituters ?allowed_builds ?(event_context = []) config env
  =
  Json.mkdir config.report_dir;
  Json.mkdir (Filename.concat config.report_dir "logs");
  let gc_dir = Filename.temp_file "nix-ci-build-" "" in
  Unix.unlink gc_dir;
  Unix.mkdir gc_dir 0o700;
  let github_actions = Sys.getenv_opt "GITHUB_ACTIONS" = Some "true" in
  let summary_output =
    match config.output with
    | Some _ as output -> output
    | None -> Sys.getenv_opt "GITHUB_STEP_SUMMARY"
  in
  let report =
    Report.create
      ~verbose:config.verbose
      ~color:(github_actions && Sys.getenv_opt "NO_COLOR" = None)
      ~directory:config.report_dir
      ~summary_output
      ~github_actions
      ()
  in
  let env_string name = Option.value (Sys.getenv_opt name) ~default:"" in
  let run_url =
    match
      ( Sys.getenv_opt "GITHUB_SERVER_URL"
      , Sys.getenv_opt "GITHUB_REPOSITORY"
      , Sys.getenv_opt "GITHUB_RUN_ID" )
    with
    | Some server, Some repo, Some id ->
      server ^ "/" ^ repo ^ "/actions/runs/" ^ id
    | _ -> ""
  in
  let context =
    [ "flake", `String config.flake
    ; "startedAt", `Float (now ())
    ; "gitSha", `String (env_string "GITHUB_SHA")
    ; "runUrl", `String run_url
    ; "runAttempt", `String (env_string "GITHUB_RUN_ATTEMPT")
    ; "jobs", `Int config.jobs
    ]
    @ event_context
  in
  let t =
    { config
    ; report
    ; event_context
    ; allowed_builds
    ; jobs = Hashtbl.create 128
    ; activities = Hashtbl.create 128
    ; uploads = Hashtbl.create 128
    ; cache_reuse = Hashtbl.create 128
    ; waits = Hashtbl.create 16
    ; available = Hashtbl.create 256
    ; availability_epoch = 0
    ; generation = 0
    ; failures = Hashtbl.create 32
    ; candidates = Hashtbl.create 128
    ; attribution = Hashtbl.create 256
    ; output_producers = Hashtbl.create 256
    ; graph = Plan.empty
    ; roots = []
    ; context
    ; plan = `Null
    ; diff = `Null
    ; eval_attrs = 0
    ; eval_errors = []
    ; eval_complete = false
    ; status = "evaluating"
    ; fatal = None
    ; warnings = []
    ; builds_done = false
    ; last_checkpoint = 0.
    ; gc_dir
    }
  in
  let process_mgr = Eio.Stdenv.process_mgr env
  and clock = Eio.Stdenv.clock env in
  let interrupted = ref false in
  let handler = Sys.Signal_handle (fun _ -> interrupted := true) in
  let int_handler = Sys.signal Sys.sigint handler
  and term_handler = Sys.signal Sys.sigterm handler in
  Fun.protect
    ~finally:(fun () ->
      Sys.set_signal Sys.sigint int_handler;
      Sys.set_signal Sys.sigterm term_handler;
      Report.close report;
      Array.iter (Sys.readdir gc_dir) ~f:(fun file ->
        try Unix.unlink (Filename.concat gc_dir file) with
        | Unix.Unix_error _ -> ());
      try Unix.rmdir gc_dir with Unix.Unix_error _ -> ())
    (fun () ->
       checkpoint t;
       (try
          Eio.Fiber.first
            (fun () ->
               Eio.Fiber.first
                 (fun () ->
                    t.context <-
                      ("nixVersion", `String (Backend.version process_mgr "nix"))
                      :: ( "nixEvalJobsVersion"
                         , `String
                             (match prepared with
                             | None ->
                               Backend.version process_mgr "nix-eval-jobs"
                             | Some _ -> "not used (prepared plan)") )
                      :: t.context;
                    let evaluation_started = now () in
                    (match prepared with
                    | None -> evaluate t process_mgr
                    | Some prepared -> load_prepared t process_mgr prepared);
                    t.context <-
                      ( "evaluationSeconds"
                      , `Float (now () -. evaluation_started) )
                      :: t.context;
                    t.status <- "planning";
                    checkpoint t;
                    let planning_started = now () in
                    let stores =
                      if pending_roots t = []
                      then []
                      else
                        match substituters with
                        | Some stores -> stores
                        | None -> Backend.substituters process_mgr
                    in
                    make_plan t process_mgr stores;
                    t.context <-
                      ("planningSeconds", `Float (now () -. planning_started))
                      :: t.context;
                    if config.dry_run || config.explain <> None
                    then t.status <- "planned"
                    else (
                      t.status <- "building";
                      Eio.Fiber.all
                        [ (fun () ->
                            scheduler
                              t
                              process_mgr
                              clock
                              stores
                              ~cancel_grace:(Eio.Stdenv.mono_clock env, 5.))
                        ; (fun () -> uploader t process_mgr clock)
                        ; (fun () -> cache_follower t process_mgr clock stores)
                        ];
                      t.status <- "success"))
                 (fun () ->
                    let rec loop () =
                      Eio.Time.sleep clock config.heartbeat;
                      progress t;
                      loop ()
                    in
                    loop ()))
            (fun () ->
               let rec loop () =
                 Eio.Time.sleep clock 0.1;
                 if !interrupted then raise Cancelled;
                 loop ()
               in
               loop ())
        with
       | Cancelled -> t.status <- "cancelled"
       | exn ->
         if !interrupted
         then t.status <- "cancelled"
         else (
           t.status <- "failed";
           t.fatal <- Some (Printexc.to_string exn)));
       Hashtbl.iter
         (fun _ (a : activity) ->
            if a.active > 0
            then (
              let elapsed = duration a.active_started None in
              a.seconds <- a.seconds +. elapsed;
              if a.state = "building"
              then a.build_seconds <- a.build_seconds +. elapsed
              else if a.state = "downloading"
              then a.download_seconds <- a.download_seconds +. elapsed
              else a.wait_seconds <- a.wait_seconds +. elapsed;
              a.active <- 0;
              a.active_builds <- 0;
              a.active_downloads <- 0;
              a.active_started <- None;
              a.finished <- Some (now ());
              a.state <- "cancelled"))
         t.activities;
       if t.status <> "planned"
       then
         List.iter (roots t) ~f:(fun (j : job) ->
           if j.state = "queued" || j.state = "submitted"
           then transition t j "cancelled");
       Hashtbl.iter
         (fun _ (u : upload) ->
            if u.state = "queued" || u.state = "uploading"
            then u.state <- "cancelled")
         t.uploads;
       if
         t.status <> "cancelled"
         && (t.eval_errors <> []
            || Hashtbl.length t.failures <> 0
            || List.exists (values t.uploads) ~f:(fun (u : upload) ->
              u.state = "failed"))
       then t.status <- "failed";
       t.context <- ("finishedAt", `Float (now ())) :: t.context;
       event t "finished" [ "status", `String t.status ];
       Report.finish report (snapshot t);
       if t.status = "cancelled"
       then 130
       else if t.status = "failed"
       then 1
       else 0)
