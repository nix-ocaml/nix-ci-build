module Strings = Set.Make (String)
module Paths = Map.Make (String)

type edge =
  { drv_path : string
  ; outputs : string list
  }

type node =
  { drv_path : string
  ; name : string
  ; system : string
  ; allow_substitutes : bool
  ; inputs : edge list
  ; outputs : (string * string option) list
  }

type t = node Paths.t

let empty = Paths.empty

let normalize_path path =
  let path = String.trim path in
  if path = "" || not (Filename.is_relative path)
  then path
  else "/nix/store/" ^ path

let normalize_drv_path path =
  let path =
    match String.index_opt path '^' with
    | None -> path
    | Some i -> String.sub path ~pos:0 ~len:i
  in
  normalize_path path

let normalize_edge (edge : edge) =
  { drv_path = normalize_drv_path edge.drv_path
  ; outputs = List.sort_uniq ~cmp:String.compare edge.outputs
  }

let normalize_node (node : node) =
  { node with
    drv_path = normalize_drv_path node.drv_path
  ; inputs = List.map node.inputs ~f:normalize_edge
  ; outputs =
      List.map node.outputs ~f:(fun (name, path) ->
        name, Option.map normalize_path path)
  }

let of_nodes nodes =
  List.fold_left nodes ~init:empty ~f:(fun graph node ->
    let node = normalize_node node in
    Paths.add node.drv_path node graph)

let nodes graph = List.map (Paths.bindings graph) ~f:snd
let find graph drv_path = Paths.find_opt (normalize_drv_path drv_path) graph

let merge left right =
  Paths.union
    (fun _ (left : node) (right : node) ->
       (* Evaluator records can fill output paths omitted by the v4 derivation
          format without discarding a previously discovered dependency graph. *)
       let outputs =
         List.fold_left
           (left.outputs @ right.outputs)
           ~init:Paths.empty
           ~f:(fun outputs (name, path) ->
             match path, Paths.find_opt name outputs with
             | None, Some (Some _) -> outputs
             | _ -> Paths.add name path outputs)
         |> Paths.bindings
       in
       Some
         { right with
           outputs
         ; inputs = (if right.inputs = [] then left.inputs else right.inputs)
         ; name = (if right.name = "" then left.name else right.name)
         ; system = (if right.system = "" then left.system else right.system)
         ; allow_substitutes = left.allow_substitutes && right.allow_substitutes
         })
    left
    right

exception Invalid_graph of string

let invalid context message = raise (Invalid_graph (context ^ ": " ^ message))

let object_fields context = function
  | `Assoc fields -> fields
  | _ -> invalid context "expected an object"

let field name fields = List.assoc_opt name fields

let optional_object context = function
  | None | Some `Null -> []
  | Some value -> object_fields context value

let string_value context = function
  | `String value -> value
  | _ -> invalid context "expected a string"

let optional_string context = function
  | None | Some `Null -> None
  | Some value -> Some (string_value context value)

let strings context = function
  | `List values -> List.map values ~f:(string_value context)
  | _ -> invalid context "expected a list of strings"

let basename_name drv_path =
  let name = Filename.basename drv_path in
  let name =
    if String.ends_with ~suffix:".drv" name
    then String.sub name ~pos:0 ~len:(String.length name - 4)
    else name
  in
  if String.length name > 33 && name.[32] = '-'
  then String.sub name ~pos:33 ~len:(String.length name - 33)
  else name

let parse_node (drv_path, value) =
  let drv_path = normalize_drv_path drv_path in
  if not (String.ends_with ~suffix:".drv" drv_path)
  then invalid drv_path "expected a derivation path ending in .drv";
  let fields = object_fields drv_path value in
  let env = optional_object (drv_path ^ ".env") (field "env" fields) in
  let structured =
    match field "structuredAttrs" fields with
    | Some value when value <> `Null ->
      Some (object_fields (drv_path ^ ".structuredAttrs") value)
    | _ ->
      (match
         optional_string (drv_path ^ ".env.__json") (field "__json" env)
       with
      | None -> None
      | Some json ->
        let context = drv_path ^ ".env.__json" in
        let value =
          try Yojson.Safe.from_string json with
          | Yojson.Json_error message -> invalid context message
        in
        Some (object_fields context value))
  in
  let allow_substitutes =
    match structured with
    | Some fields ->
      (match field "allowSubstitutes" fields with
      | None -> true
      | Some (`Bool value) -> value
      | Some _ -> invalid (drv_path ^ ".allowSubstitutes") "expected a boolean")
    | None ->
      (match
         optional_string
           (drv_path ^ ".env.allowSubstitutes")
           (field "allowSubstitutes" env)
       with
      | None -> true
      | Some value -> value = "1")
  in
  let name =
    match optional_string (drv_path ^ ".name") (field "name" fields) with
    | Some name -> name
    | None ->
      (match optional_string (drv_path ^ ".env.name") (field "name" env) with
      | Some name -> name
      | None -> basename_name drv_path)
  in
  let system =
    match optional_string (drv_path ^ ".system") (field "system" fields) with
    | Some system -> system
    | None -> ""
  in
  let outputs =
    match field "outputs" fields with
    | None -> invalid drv_path "missing outputs"
    | Some value ->
      object_fields (drv_path ^ ".outputs") value
      |> List.map ~f:(fun (name, value) ->
        let context = drv_path ^ ".outputs." ^ name in
        let path =
          match value with
          | `String path -> Some path
          | `Null -> None
          | _ ->
            let fields = object_fields context value in
            optional_string (context ^ ".path") (field "path" fields)
        in
        let path =
          match path with
          | Some "" | None ->
            let fallback fields =
              match field name fields with
              | Some (`String path) when String.starts_with ~prefix:"/" path ->
                Some path
              | _ -> None
            in
            (match fallback env with
            | Some _ as path -> path
            | None -> fallback (Option.value structured ~default:[]))
          | path -> path
        in
        name, Option.map normalize_path path)
  in
  let input_fields =
    match field "inputDrvs" fields with
    | Some value -> object_fields (drv_path ^ ".inputDrvs") value
    | None ->
      let inputs =
        optional_object (drv_path ^ ".inputs") (field "inputs" fields)
      in
      optional_object (drv_path ^ ".inputs.drvs") (field "drvs" inputs)
  in
  let inputs =
    List.map input_fields ~f:(fun (input, value) ->
      let context = drv_path ^ ".inputs." ^ input in
      let outputs =
        match value with
        | `List _ -> strings context value
        | _ ->
          let fields = object_fields context value in
          let dynamic =
            optional_object
              (context ^ ".dynamicOutputs")
              (field "dynamicOutputs" fields)
          in
          if dynamic <> []
          then
            invalid
              context
              "dynamic derivation dependencies cannot be planned statically";
          (match field "outputs" fields with
          | Some value -> strings context value
          | None -> invalid context "missing requested outputs")
      in
      normalize_edge { drv_path = input; outputs })
  in
  { drv_path; name; system; allow_substitutes; inputs; outputs }

let of_yojson json =
  try
    let fields = object_fields "derivation graph" json in
    let derivations =
      match field "derivations" fields with
      | None -> fields
      | Some value ->
        (match field "version" fields with
        | Some (`Int version) when version > 4 ->
          invalid "derivation graph" "unsupported JSON version"
        | _ -> ());
        object_fields "derivations" value
    in
    Ok (of_nodes (List.map derivations ~f:parse_node))
  with
  | Invalid_graph message -> Error message

type cache_info =
  { download_size : int64 option
  ; nar_size : int64 option
  ; references : string list
  }

type availability =
  | Local
  | Cached of cache_info
  | Missing

type download =
  { path : string
  ; download_size : int64 option
  ; nar_size : int64 option
  }

type plan =
  { roots : edge list
  ; builds : node list
  ; downloads : download list
  ; local_outputs : string list
  ; unknown : string list
  }

let selected_outputs (node : node) names =
  let names =
    if Strings.mem "*" names
    then
      List.fold_left
        node.outputs
        ~init:(Strings.remove "*" names)
        ~f:(fun acc (name, _) -> Strings.add name acc)
    else names
  in
  (* An incomplete evaluator node still needs conservative work accounting. *)
  let names =
    if Strings.is_empty names && node.outputs = []
    then Strings.singleton "*"
    else names
  in
  Strings.elements names
  |> List.map ~f:(fun name ->
    let path =
      match List.assoc_opt name node.outputs with
      | Some path -> path
      | None -> None
    in
    name, path)

let needs_build ~availability outputs =
  List.exists outputs ~f:(function
    | _, None -> true
    | _, Some path ->
      (match availability path with
      | Missing -> true
      | Local | Cached _ -> false))

let requirements graph ~roots ~availability =
  let wanted = ref Paths.empty in
  let pending = Queue.create () in
  List.iter roots ~f:(fun edge -> Queue.add (normalize_edge edge) pending);
  while not (Queue.is_empty pending) do
    let (edge : edge) = Queue.take pending in
    if edge.outputs <> []
    then
      let previous =
        match Paths.find_opt edge.drv_path !wanted with
        | Some names -> names
        | None -> Strings.empty
      in
      let names =
        List.fold_left edge.outputs ~init:previous ~f:(fun names name ->
          Strings.add name names)
      in
      if not (Strings.equal previous names)
      then (
        wanted := Paths.add edge.drv_path names !wanted;
        match find graph edge.drv_path with
        | None -> ()
        | Some node ->
          if needs_build ~availability (selected_outputs node names)
          then List.iter node.inputs ~f:(fun edge -> Queue.add edge pending))
  done;
  !wanted

let compute graph ~roots ~availability =
  let roots = List.map roots ~f:normalize_edge in
  let wanted = requirements graph ~roots ~availability in
  let builds = ref [] in
  let local = ref Strings.empty in
  let unknown = ref Strings.empty in
  let cached = ref Strings.empty in
  Paths.iter
    (fun drv_path names ->
       match find graph drv_path with
       | None -> unknown := Strings.add drv_path !unknown
       | Some node ->
         let outputs = selected_outputs node names in
         let build = needs_build ~availability outputs in
         if build then builds := node :: !builds;
         List.iter outputs ~f:(fun (name, path) ->
           match path with
           | None -> unknown := Strings.add (drv_path ^ "^" ^ name) !unknown
           | Some path ->
             (match availability path with
             | Local -> local := Strings.add path !local
             | Cached _ when not build -> cached := Strings.add path !cached
             | Cached _ | Missing -> ())))
    wanted;
  let produced =
    List.fold_left !builds ~init:Strings.empty ~f:(fun paths (node : node) ->
      List.fold_left node.outputs ~init:paths ~f:(fun paths (_, path) ->
        match path with None -> paths | Some path -> Strings.add path paths))
  in
  let downloads = ref Paths.empty in
  let seen = ref Strings.empty in
  let pending = Queue.create () in
  Strings.iter (fun path -> Queue.add path pending) !cached;
  while not (Queue.is_empty pending) do
    let path = normalize_path (Queue.take pending) in
    if not (Strings.mem path !seen)
    then (
      seen := Strings.add path !seen;
      match availability path with
      | Local -> local := Strings.add path !local
      | _ when Strings.mem path produced -> ()
      | Missing -> unknown := Strings.add path !unknown
      | Cached info ->
        downloads :=
          Paths.add
            path
            { path
            ; download_size = info.download_size
            ; nar_size = info.nar_size
            }
            !downloads;
        List.iter info.references ~f:(fun path -> Queue.add path pending))
  done;
  { roots
  ; builds =
      List.sort !builds ~cmp:(fun (left : node) right ->
        String.compare left.drv_path right.drv_path)
  ; downloads = List.map (Paths.bindings !downloads) ~f:snd
  ; local_outputs = Strings.elements !local
  ; unknown = Strings.elements !unknown
  }

let explain graph ~availability ~root ~target =
  let target = normalize_path target in
  let root = normalize_edge root in
  let seen = ref Paths.empty in
  let pending = Queue.create () in
  Queue.add (root, []) pending;
  let found = ref None in
  while !found = None && not (Queue.is_empty pending) do
    let (edge : edge), path = Queue.take pending in
    let previous =
      match Paths.find_opt edge.drv_path !seen with
      | Some names -> names
      | None -> Strings.empty
    in
    let names = Strings.of_list edge.outputs in
    if edge.outputs <> [] && not (Strings.subset names previous)
    then (
      seen := Paths.add edge.drv_path (Strings.union previous names) !seen;
      let path = edge.drv_path :: path in
      if edge.drv_path = target
      then found := Some (List.rev path)
      else
        match find graph edge.drv_path with
        | None -> ()
        | Some node ->
          let outputs = selected_outputs node names in
          if List.exists outputs ~f:(fun (_, output) -> output = Some target)
          then found := Some (List.rev (target :: path))
          else if needs_build ~availability outputs
          then
            List.iter node.inputs ~f:(fun input ->
              Queue.add (input, path) pending))
  done;
  !found

let failed_ancestors graph ~availability ~root ~failed =
  let required = requirements graph ~roots:[ root ] ~availability in
  List.filter_map failed ~f:(fun path ->
    let path = normalize_drv_path path in
    match Paths.find_opt path required with
    | None -> None
    | Some names ->
      (match find graph path with
      | Some node
        when not (needs_build ~availability (selected_outputs node names)) ->
        None
      | _ -> Some path))
  |> List.sort_uniq ~cmp:String.compare

let rank ?plan_for_root graph ~availability ~failed ~now ~duration ~pending =
  let plan_for_root =
    match plan_for_root with
    | Some plan_for_root -> plan_for_root
    | None -> fun root -> compute graph ~roots:[ root ] ~availability
  in
  let failed =
    List.fold_left failed ~init:Strings.empty ~f:(fun failed path ->
      Strings.add (normalize_drv_path path) failed)
  in
  let candidates =
    List.filter_map
      (List.mapi pending ~f:(fun index (root, queued_at) ->
         index, root, queued_at))
      ~f:(fun (index, root, queued_at) ->
        let plan = plan_for_root root in
        if
          (not (Strings.is_empty failed))
          && (List.exists plan.builds ~f:(fun (node : node) ->
                Strings.mem node.drv_path failed)
             || List.exists plan.unknown ~f:(fun path ->
               Strings.mem path failed))
        then None
        else Some (index, root, queued_at, plan))
  in
  let counts =
    List.fold_left
      candidates
      ~init:Paths.empty
      ~f:(fun counts (_, _, _, plan) ->
        List.fold_left plan.builds ~init:counts ~f:(fun counts (node : node) ->
          let count =
            match Paths.find_opt node.drv_path counts with
            | Some count -> count
            | None -> 0
          in
          Paths.add node.drv_path (count + 1) counts))
  in
  let score (index, (root : edge), queued_at, plan) =
    let missing =
      List.fold_left
        plan.builds
        ~init:Strings.empty
        ~f:(fun set (node : node) -> Strings.add node.drv_path set)
    in
    let memo = Hashtbl.create 32 in
    let seconds path =
      match duration path with
      | Some seconds when Float.is_finite seconds && seconds > 0. -> seconds
      | _ -> 60.
    in
    let rec critical visiting path =
      if Strings.mem path visiting || not (Strings.mem path missing)
      then 0.
      else
        match Hashtbl.find_opt memo path with
        | Some value -> value
        | None ->
          let visiting = Strings.add path visiting in
          let longest =
            match find graph path with
            | None -> 0.
            | Some node ->
              List.fold_left
                node.inputs
                ~init:0.
                ~f:(fun longest (edge : edge) ->
                  max longest (critical visiting edge.drv_path))
          in
          let result = seconds path +. longest in
          Hashtbl.add memo path result;
          result
    in
    let impact =
      Strings.fold
        (fun path sum ->
           let count =
             match Paths.find_opt path counts with
             | Some count -> count
             | None -> 1
           in
           sum +. float_of_int (count - 1))
        missing
        0.
    in
    let age =
      if Float.is_finite queued_at && Float.is_finite now
      then max 0. (now -. queued_at)
      else 0.
    in
    let priority =
      (300. *. impact)
      +. critical Strings.empty (normalize_drv_path root.drv_path)
      +. (2. *. age)
    in
    priority, index, root
  in
  List.map candidates ~f:score
  |> List.sort ~cmp:(fun (a, ai, _) (b, bi, _) ->
    let c = Float.compare b a in
    if c = 0 then Int.compare ai bi else c)
  |> List.map ~f:(fun (_, _, root) -> root)

let int64_json = function
  | None -> `Null
  | Some n -> `Intlit (Int64.to_string n)

let string_list values = `List (List.map values ~f:(fun value -> `String value))

let edge_json (edge : edge) =
  `Assoc
    [ "drvPath", `String edge.drv_path; "outputs", string_list edge.outputs ]

let to_yojson plan =
  `Assoc
    [ "version", `Int 1
    ; "roots", `List (List.map plan.roots ~f:edge_json)
    ; ( "builds"
      , `List
          (List.map plan.builds ~f:(fun (node : node) ->
             `Assoc
               [ "drvPath", `String node.drv_path
               ; "name", `String node.name
               ; "system", `String node.system
               ; "allowSubstitutes", `Bool node.allow_substitutes
               ; "inputs", `List (List.map node.inputs ~f:edge_json)
               ; ( "outputs"
                 , `Assoc
                     (List.map node.outputs ~f:(fun (name, path) ->
                        ( name
                        , match path with
                          | None -> `Null
                          | Some path -> `String path ))) )
               ])) )
    ; ( "downloads"
      , `List
          (List.map plan.downloads ~f:(fun download ->
             `Assoc
               [ "path", `String download.path
               ; "downloadSize", int64_json download.download_size
               ; "narSize", int64_json download.nar_size
               ])) )
    ; "localOutputs", string_list plan.local_outputs
    ; "unknown", string_list plan.unknown
    ]

type diff =
  { added_builds : string list
  ; removed_builds : string list
  ; added_downloads : string list
  ; removed_downloads : string list
  }

let diff ~previous ~current =
  try
    let fields = object_fields "previous plan" previous in
    (match field "version" fields with
    | Some (`Int 1) -> ()
    | _ -> invalid "previous plan" "unsupported or missing version");
    let identities name key normalize =
      match field name fields with
      | Some (`List values) ->
        List.fold_left values ~init:Strings.empty ~f:(fun paths value ->
          let fields = object_fields ("previous plan." ^ name) value in
          match field key fields with
          | Some (`String path) -> Strings.add (normalize path) paths
          | _ -> invalid ("previous plan." ^ name) ("missing " ^ key))
      | _ -> invalid "previous plan" ("missing " ^ name)
    in
    let previous_builds = identities "builds" "drvPath" normalize_drv_path in
    let previous_downloads = identities "downloads" "path" normalize_path in
    let current_builds =
      List.fold_left
        current.builds
        ~init:Strings.empty
        ~f:(fun paths (node : node) -> Strings.add node.drv_path paths)
    in
    let current_downloads =
      List.fold_left
        current.downloads
        ~init:Strings.empty
        ~f:(fun paths download -> Strings.add download.path paths)
    in
    Ok
      { added_builds =
          Strings.elements (Strings.diff current_builds previous_builds)
      ; removed_builds =
          Strings.elements (Strings.diff previous_builds current_builds)
      ; added_downloads =
          Strings.elements (Strings.diff current_downloads previous_downloads)
      ; removed_downloads =
          Strings.elements (Strings.diff previous_downloads current_downloads)
      }
  with
  | Invalid_graph message -> Error message
