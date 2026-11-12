(* Cross-runner plans carry derivations, not evaluator-local availability.
   Workers import their boundary outputs before giving owned work to Nix. *)
let fail message = failwith message
let strings = Json.strs
let unique xs = List.sort_uniq xs ~cmp:String.compare
let unwrap = function Ok value -> value | Error message -> fail message

let required_string context = function
  | `String value when value <> "" -> value
  | _ -> fail (context ^ ": expected a nonempty string")

let fields context = function
  | `Assoc fields -> fields
  | _ -> fail (context ^ ": expected an object")

let array context = function
  | `List values -> values
  | _ -> fail (context ^ ": expected an array")

let write_text path text =
  let channel = open_out_bin path in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () -> output_string channel text)

let absolute path =
  if Filename.is_relative path
  then Filename.concat (Sys.getcwd ()) path
  else path

let with_roots f =
  let directory = Filename.temp_file "nix-ci-shared-roots-" "" in
  Unix.unlink directory;
  Unix.mkdir directory 0o700;
  let rec remove path =
    match (Unix.lstat path).st_kind with
    | Unix.S_DIR ->
      Array.iter (Sys.readdir path) ~f:(fun name ->
        remove (Filename.concat path name));
      Unix.rmdir path
    | _ -> Unix.unlink path
  in
  Fun.protect
    ~finally:(fun () -> try remove directory with Unix.Unix_error _ -> ())
    (fun () -> f directory)

let graph_json graph =
  `Assoc
    (List.map (Plan.nodes graph) ~f:(fun (node : Plan.node) ->
       ( node.drv_path
       , `Assoc
           [ "name", `String node.name
           ; "system", `String node.system
           ; ( "env"
             , `Assoc
                 [ ( "allowSubstitutes"
                   , `String (if node.allow_substitutes then "1" else "") )
                 ] )
           ; ( "outputs"
             , `Assoc
                 (List.map node.outputs ~f:(fun (name, path) ->
                    name, Json.optional Json.str path)) )
           ; ( "inputDrvs"
             , `Assoc
                 (List.map node.inputs ~f:(fun (edge : Plan.edge) ->
                    edge.drv_path, strings edge.outputs)) )
           ] )))

let selected graph (edge : Plan.edge) =
  let node =
    match Plan.find graph edge.drv_path with
    | Some node -> node
    | None -> fail ("Missing derivation " ^ edge.drv_path)
  in
  List.filter_map node.outputs ~f:(fun (name, path) ->
    if List.mem "*" ~set:edge.outputs || List.mem name ~set:edge.outputs
    then
      match path with
      | Some path -> Some path
      | None -> fail ("Unresolved output " ^ edge.drv_path ^ "^" ^ name)
    else None)

let probe process_mgr ~log_dir stores paths =
  let available = Hashtbl.create (List.length paths) in
  List.iter stores ~f:(fun store ->
    let paths =
      List.filter paths ~f:(fun path -> not (Hashtbl.mem available path))
    in
    let infos, warning =
      Backend.path_info process_mgr ~log_dir ~store ~fresh:true paths
    in
    Option.iter (fun message -> fail message) warning;
    List.iter infos ~f:(fun (path, info) ->
      Hashtbl.replace available path (Plan.Cached info)));
  available

let availability table path =
  Option.value (Hashtbl.find_opt table path) ~default:Plan.Missing

let remote_graph_availability
      process_mgr
      ~log_dir
      ~available
      ~checked
      graph
      stores
      roots
  =
  let visited = Hashtbl.create 1024 in
  let rec walk edges =
    let edges =
      List.filter edges ~f:(fun edge ->
        if Hashtbl.mem visited edge
        then false
        else (
          Hashtbl.add visited edge ();
          true))
    in
    if edges <> []
    then (
      let paths =
        unique (List.concat_map edges ~f:(selected graph))
        |> List.filter ~f:(fun path -> not (Hashtbl.mem checked path))
      in
      if paths <> []
      then
        Printf.printf
          "Checking %d dependency outputs in shared caches\n%!"
          (List.length paths);
      let found = probe process_mgr ~log_dir stores paths in
      Hashtbl.iter (Hashtbl.replace available) found;
      List.iter paths ~f:(fun path -> Hashtbl.replace checked path ());
      let next =
        List.concat_map edges ~f:(fun (edge : Plan.edge) ->
          let node = Option.get (Plan.find graph edge.drv_path) in
          let paths = selected graph edge in
          if
            node.allow_substitutes
            && paths <> []
            && List.for_all paths ~f:(Hashtbl.mem available)
          then []
          else node.inputs)
      in
      walk next)
  in
  walk roots;
  available

let require_success description result =
  if not (Backend.successful result)
  then fail (description ^ ": " ^ Backend.error result)

let store_copy process_mgr ~log ~source ~destination drvs =
  let args =
    [ "copy"; "--derivation"; "--stdin" ]
    @ (match source with None -> [] | Some store -> [ "--from"; store ])
    @ match destination with None -> [] | Some store -> [ "--to"; store ]
  in
  let result =
    Backend.run
      process_mgr
      ~capture:false
      ~log_path:log
      ~input:(String.concat ~sep:"\n" drvs ^ "\n")
      (Backend.nix args)
  in
  require_success "Cannot transfer derivation closure" result

let matrix runners groups =
  if List.length groups > 256
  then
    fail
      "A stage exceeds GitHub Actions' 256-job matrix limit; combine \
       package-set requests or plan fewer sets together";
  `Assoc
    [ ( "include"
      , `List
          (List.map groups ~f:(fun (group : Shared_plan.group) ->
             let runner =
               match List.assoc_opt group.system runners with
               | Some runner -> runner
               | None ->
                 fail ("No runner configured for build system " ^ group.system)
             in
             `Assoc
               [ "group", `String group.id
               ; "system", `String group.system
               ; "runner", runner
               ; "consumers", strings group.consumers
               ])) )
    ]

let append_outputs path values =
  let channel =
    open_out_gen
      [ Open_wronly; Open_creat; Open_append; Open_binary ]
      0o600
      path
  in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () ->
       List.iter values ~f:(fun (name, value) ->
         Printf.fprintf channel "%s=%s\n" name value))

let plan ~sets_file ~directory ~jobs ~copy_from ~github_output env =
  let process_mgr = Eio.Stdenv.process_mgr env in
  Json.mkdir directory;
  let logs = Filename.concat directory "logs" in
  Json.mkdir logs;
  let config = Json.read sets_file in
  let sets = array "sets" (Json.member "sets" config) in
  let runners = fields "runners" (Json.member "runners" config) in
  List.iter runners ~f:(fun (_, value) ->
    match value with
    | `String value when value <> "" -> ()
    | `List labels when labels <> [] ->
      List.iter labels ~f:(fun value ->
        ignore (required_string "runner label" value))
    | _ -> fail "Runner must be a label or a nonempty array of labels");
  let stores =
    if copy_from = [] then Backend.substituters process_mgr else copy_from
  in
  with_roots (fun gc_dir ->
    let errors = ref []
    and records = ref []
    and shallow = ref Plan.empty in
    let requests =
      List.mapi sets ~f:(fun index set ->
        let id = required_string "set.id" (Json.member "id" set) in
        let flake = required_string "set.flake" (Json.member "flake" set) in
        Printf.printf "Evaluating %s (%s)\n%!" id flake;
        let roots = ref [] in
        let on_stdout line =
          try
            let record = Yojson.Safe.from_string line in
            let attr = Json.string (Json.member "attr" record) in
            if Json.member "error" record <> `Null
            then
              errors :=
                `Assoc
                  [ "set", `String id
                  ; "attr", `String attr
                  ; "error", Json.member "error" record
                  ]
                :: !errors
            else
              let drv_path =
                required_string
                  "evaluated drvPath"
                  (Json.member "drvPath" record)
              in
              roots := { Plan.drv_path; outputs = [ "*" ] } :: !roots;
              let node : Plan.node =
                { drv_path
                ; name = Json.string (Json.member "name" record)
                ; system = Json.string (Json.member "system" record)
                ; inputs = []
                ; allow_substitutes = true
                ; outputs =
                    List.map
                      (Json.assoc (Json.member "outputs" record))
                      ~f:(fun (name, value) ->
                        ( name
                        , match value with
                          | `String value -> Some value
                          | _ -> None ))
                }
              in
              shallow := Plan.merge !shallow (Plan.of_nodes [ node ]);
              records :=
                `Assoc
                  [ "set", `String id
                  ; "flake", `String flake
                  ; "attr", `String attr
                  ; "drvPath", `String drv_path
                  ]
                :: !records
          with
          | exn ->
            errors :=
              `Assoc
                [ "set", `String id; "error", `String (Printexc.to_string exn) ]
              :: !errors
        in
        let gc_set = Filename.concat gc_dir (string_of_int index) in
        Json.mkdir gc_set;
        let result =
          Backend.run
            process_mgr
            ~capture:false
            ~on_stdout
            ~log_path:
              (Filename.concat logs (Printf.sprintf "evaluation-%d.log" index))
            [ "nix-eval-jobs"
            ; "--gc-roots-dir"
            ; gc_set
            ; "--force-recurse"
            ; "--workers"
            ; string_of_int jobs
            ; "--flake"
            ; flake
            ]
        in
        if not (Backend.successful result)
        then
          errors :=
            `Assoc
              [ "set", `String id; "error", `String (Backend.error result) ]
            :: !errors;
        (* Keep indirect GC roots at their registered paths until the bundle is
           exported. Moving the symlinks would invalidate that protection. *)
        { Shared_plan.id; roots = List.sort_uniq !roots ~cmp:Stdlib.compare })
    in
    Json.atomic_write
      (Filename.concat directory "evaluation.json")
      (`Assoc
          [ "attributes", `List (List.rev !records)
          ; "errors", `List (List.rev !errors)
          ]);
    if !errors <> []
    then
      fail
        (Printf.sprintf
           "%d evaluation errors; see evaluation.json"
           (List.length !errors));
    let drvs =
      unique
        (List.concat_map requests ~f:(fun (request : Shared_plan.request) ->
           List.map request.roots ~f:(fun (edge : Plan.edge) -> edge.drv_path)))
    in
    let roots =
      List.concat_map requests ~f:(fun (request : Shared_plan.request) ->
        request.roots)
    in
    (* Inspect real root metadata before deciding cache cuts: evaluator records
       do not carry allowSubstitutes. Warm sets need no recursive expansion. *)
    Printf.printf
      "Checking %d unique roots in shared caches\n%!"
      (List.length drvs);
    let root_graph =
      if drvs = []
      then Plan.empty
      else Plan.merge !shallow (Backend.graph process_mgr ~recursive:false drvs)
    in
    let root_paths = unique (List.concat_map roots ~f:(selected root_graph)) in
    let available = probe process_mgr ~log_dir:logs stores root_paths in
    let checked = Hashtbl.create (List.length root_paths) in
    List.iter root_paths ~f:(fun path -> Hashtbl.replace checked path ());
    let missing_roots =
      List.filter drvs ~f:(fun drv ->
        let node = Option.get (Plan.find root_graph drv) in
        (not node.allow_substitutes)
        || List.exists node.outputs ~f:(function
          | _, Some path -> not (Hashtbl.mem available path)
          | _, None -> true))
    in
    Printf.printf
      "Expanding %d uncached roots (%d cached)\n%!"
      (List.length missing_roots)
      (List.length drvs - List.length missing_roots);
    let graph =
      if missing_roots = []
      then root_graph
      else Plan.merge root_graph (Backend.graph process_mgr missing_roots)
    in
    let available =
      remote_graph_availability
        process_mgr
        ~log_dir:logs
        ~available
        ~checked
        graph
        stores
        roots
    in
    let planned =
      unwrap
        (Shared_plan.create
           graph
           ~requests
           ~availability:(availability available))
    in
    let shared, packages =
      List.partition planned.groups ~f:(fun (group : Shared_plan.group) ->
        group.kind = `Shared)
    in
    let shared_matrix = matrix runners shared
    and package_matrix = matrix runners packages in
    let cached = Hashtbl.to_seq_keys available |> List.of_seq |> unique in
    let manifest =
      `Assoc
        [ "version", `Int 1
        ; "graph", graph_json graph
        ; "plan", Shared_plan.to_yojson planned
        ; "cachedPaths", strings cached
        ; "attributes", `List (List.rev !records)
        ]
    in
    Json.atomic_write (Filename.concat directory "execution-plan.json") manifest;
    Json.atomic_write
      (Filename.concat directory "matrix-shared.json")
      shared_matrix;
    Json.atomic_write
      (Filename.concat directory "matrix-packages.json")
      package_matrix;
    let group_lines =
      List.map planned.groups ~f:(fun (group : Shared_plan.group) ->
        Printf.sprintf
          "| `%s` | %s | %s | %d | %s |"
          group.id
          (if group.kind = `Shared then "Shared" else "Packages")
          group.system
          (List.length group.members)
          (String.concat ~sep:", " group.consumers))
    in
    let summary =
      Printf.sprintf
        "# Shared dependency plan\n\n\
         %d package sets · %d unique roots · %d shared groups · %d package \
         groups\n\n\
         | Group | Stage | Build system | Owned derivations | Consumers |\n\
         | --- | --- | --- | ---: | --- |\n\
         %s\n"
        (List.length requests)
        (List.length drvs)
        (List.length shared)
        (List.length packages)
        (String.concat ~sep:"\n" group_lines)
    in
    write_text (Filename.concat directory "summary.md") summary;
    print_string summary;
    flush stdout;
    let bundle = Filename.concat directory "store" |> absolute in
    let needed_drvs =
      List.concat_map planned.groups ~f:(fun (group : Shared_plan.group) ->
        List.map group.roots ~f:(fun (edge : Plan.edge) -> edge.drv_path))
      |> unique
    in
    if needed_drvs <> []
    then
      store_copy
        process_mgr
        ~log:(Filename.concat logs "export.log")
        ~source:None
        ~destination:(Some ("file://" ^ bundle))
        needed_drvs;
    Option.iter
      (fun path ->
         append_outputs
           path
           [ "shared", Yojson.Safe.to_string shared_matrix
           ; "packages", Yojson.Safe.to_string package_matrix
           ; "has-shared", string_of_bool (shared <> [])
           ; "has-packages", string_of_bool (packages <> [])
           ])
      github_output;
    0)

let execute ~directory ~group_id ~copy_from (config : Engine.config) env =
  let process_mgr = Eio.Stdenv.process_mgr env in
  Json.mkdir config.report_dir;
  let logs = Filename.concat config.report_dir "logs" in
  Json.mkdir logs;
  let manifest = Json.read (Filename.concat directory "execution-plan.json") in
  if Json.member "version" manifest <> `Int 1
  then fail "Unsupported execution plan version";
  let graph = unwrap (Plan.of_yojson (Json.member "graph" manifest)) in
  let saved = unwrap (Shared_plan.of_yojson (Json.member "plan" manifest)) in
  let cached = Hashtbl.create 1024 in
  List.iter
    (Json.strings (Json.member "cachedPaths" manifest))
    ~f:(fun path ->
      Hashtbl.replace
        cached
        path
        (Plan.Cached { references = []; download_size = None; nar_size = None }));
  let planned =
    unwrap
      (Shared_plan.create
         graph
         ~requests:saved.requests
         ~availability:(availability cached))
  in
  if Shared_plan.to_yojson planned <> Shared_plan.to_yojson saved
  then fail "Execution plan does not match its dependency graph and ownership";
  let group =
    match
      List.find_opt planned.groups ~f:(fun (g : Shared_plan.group) ->
        g.id = group_id)
    with
    | Some group -> group
    | None -> fail ("Unknown execution group " ^ group_id)
  in
  let destination =
    match config.copy_to with
    | Some value -> value
    | None ->
      fail "--execute-plan requires --copy-to so completed work is published"
  in
  let stores =
    if copy_from = [] then Backend.substituters process_mgr else copy_from
  in
  let drvs =
    List.map group.roots ~f:(fun (edge : Plan.edge) -> edge.drv_path) |> unique
  in
  with_roots (fun gc_dir ->
    store_copy
      process_mgr
      ~log:(Filename.concat logs "import-plan.log")
      ~source:(Some ("file://" ^ absolute (Filename.concat directory "store")))
      ~destination:None
      drvs;
    Backend.pin_derivations
      process_mgr
      ~root:(Filename.concat gc_dir "drv")
      drvs;
    let actual = Backend.graph process_mgr drvs in
    List.iter (Plan.nodes actual) ~f:(fun (node : Plan.node) ->
      match Plan.find graph node.drv_path with
      | Some expected
        when graph_json (Plan.of_nodes [ node ])
             = graph_json (Plan.of_nodes [ expected ]) ->
        ()
      | _ -> fail ("Bundled derivation does not match plan: " ^ node.drv_path));
    Printf.printf
      "Group %s: %d owned derivations; importing %d prerequisite outputs\n%!"
      group.id
      (List.length group.members)
      (List.length group.required_paths);
    let pending = ref group.required_paths in
    List.iteri stores ~f:(fun index source ->
      if !pending <> []
      then
        let available = probe process_mgr ~log_dir:logs [ source ] !pending in
        let paths = List.filter !pending ~f:(Hashtbl.mem available) in
        if paths <> []
        then (
          let result =
            Backend.copy_from
              process_mgr
              ~log_path:
                (Filename.concat
                   logs
                   (Printf.sprintf "prerequisites-%d.log" index))
              ~source
              paths
          in
          require_success "Cannot import prerequisites" result;
          pending :=
            List.filter !pending ~f:(fun path -> not (List.mem path ~set:paths))));
    if !pending <> []
    then
      fail
        ("Prerequisites have not been published: "
        ^ String.concat ~sep:", " !pending);
    List.iteri group.required_paths ~f:(fun index path ->
      Backend.pin
        process_mgr
        ~root:(Filename.concat gc_dir ("input-" ^ string_of_int index))
        path);
    let output_paths =
      List.concat_map (Plan.nodes graph) ~f:(fun (node : Plan.node) ->
        List.filter_map node.outputs ~f:snd)
      |> unique
    in
    let local, warning =
      Backend.valid_paths process_mgr ~log_dir:logs output_paths
    in
    Option.iter fail warning;
    let local_table = Hashtbl.create (List.length local) in
    List.iter local ~f:(fun path -> Hashtbl.add local_table path ());
    let remaining =
      Plan.compute graph ~roots:group.roots ~availability:(fun path ->
        if Hashtbl.mem local_table path then Plan.Local else Plan.Missing)
    in
    let outside =
      List.filter remaining.builds ~f:(fun (node : Plan.node) ->
        not (List.mem node.drv_path ~set:group.members))
    in
    if outside <> []
    then
      fail
        ("Refusing to build another group's dependencies: "
        ^ String.concat
            ~sep:", "
            (List.map outside ~f:(fun (node : Plan.node) -> node.drv_path)));
    let prepared =
      ( graph
      , List.map group.roots ~f:(fun (edge : Plan.edge) ->
          let attrs =
            Json.list (Json.member "attributes" manifest)
            |> List.filter_map ~f:(fun record ->
              if Json.string (Json.member "drvPath" record) = edge.drv_path
              then
                Some
                  (Json.string (Json.member "set" record)
                  ^ ":"
                  ^ Json.string (Json.member "attr" record))
              else None)
          in
          edge, if attrs = [] then [ edge.drv_path ] else unique attrs) )
    in
    let code =
      Engine.run
        ~prepared
        ~substituters:stores
        { config with flake = "execution-plan#" ^ group.id }
        env
    in
    if code <> 0
    then (
      Json.atomic_write
        (Filename.concat config.report_dir "execution.json")
        (`Assoc
            [ "version", `Int 1
            ; "group", `String group.id
            ; "status", `String "failed"
            ; "exitCode", `Int code
            ; "imported", strings group.required_paths
            ]);
      code)
    else
      (* A root can already exist locally and be skipped by the engine.
         Explicitly publish every owned output needed by another group, then
         verify remotely. *)
      let boundary =
        List.concat_map planned.groups ~f:(fun (other : Shared_plan.group) ->
          if List.mem group.id ~set:other.needs
          then other.required_paths
          else [])
      in
      let owned_paths =
        List.concat_map group.members ~f:(fun drv ->
          let node = Option.get (Plan.find graph drv) in
          List.filter_map node.outputs ~f:snd)
      in
      let publish =
        unique
          (List.concat_map group.roots ~f:(selected graph)
          @ List.filter boundary ~f:(fun path -> List.mem path ~set:owned_paths)
          )
      in
      let published = probe process_mgr ~log_dir:logs [ destination ] publish in
      let missing =
        List.filter publish ~f:(fun path -> not (Hashtbl.mem published path))
      in
      let local, warning =
        Backend.valid_paths process_mgr ~log_dir:logs missing
      in
      Option.iter fail warning;
      let pending =
        ref
          (List.filter missing ~f:(fun path -> not (List.mem path ~set:local)))
      in
      List.iteri stores ~f:(fun index source ->
        if !pending <> []
        then
          let available = probe process_mgr ~log_dir:logs [ source ] !pending in
          let paths = List.filter !pending ~f:(Hashtbl.mem available) in
          if paths <> []
          then (
            let result =
              Backend.copy_from
                process_mgr
                ~log_path:
                  (Filename.concat
                     logs
                     (Printf.sprintf "publish-import-%d.log" index))
                ~source
                paths
            in
            require_success
              "Cannot import completed outputs for publication"
              result;
            pending :=
              List.filter !pending ~f:(fun path ->
                not (List.mem path ~set:paths))));
      if !pending <> []
      then
        fail
          ("Completed outputs are unavailable: "
          ^ String.concat ~sep:", " !pending);
      List.iteri missing ~f:(fun index path ->
        let result =
          Backend.copy
            process_mgr
            ~log_path:
              (Filename.concat logs (Printf.sprintf "publish-%d.log" index))
            ~destination
            path
        in
        require_success "Cannot publish owned outputs" result);
      let available = probe process_mgr ~log_dir:logs [ destination ] publish in
      if List.exists publish ~f:(fun path -> not (Hashtbl.mem available path))
      then fail "Published outputs are not visible in the destination cache";
      Json.atomic_write
        (Filename.concat config.report_dir "execution.json")
        (`Assoc
            [ "version", `Int 1
            ; "group", `String group.id
            ; "status", `String "success"
            ; "published", strings publish
            ; "imported", strings group.required_paths
            ]);
      Printf.printf
        "Published and verified %d outputs for %s\n%!"
        (List.length publish)
        group.id;
      0)
