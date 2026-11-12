module Strings = Set.Make (String)
module Paths = Map.Make (String)

type request =
  { id : string
  ; roots : Plan.edge list
  }

type group =
  { id : string
  ; system : string
  ; kind : [ `Shared | `Package ]
  ; roots : Plan.edge list
  ; members : string list
  ; consumers : string list
  ; needs : string list
  ; required_paths : string list
  }

type t =
  { requests : request list
  ; groups : group list
  }

exception Invalid_plan of string

let invalid message = raise (Invalid_plan message)
let sorted values = List.sort_uniq values ~cmp:String.compare
let set values = Strings.of_list values
let neutral system = system = "builtin"

let node graph path =
  match Plan.find graph path with
  | Some node -> node
  | None -> invalid ("missing derivation graph node: " ^ path)

let selected (node : Plan.node) names =
  let names =
    if List.mem "*" ~set:names
    then List.map node.outputs ~f:fst @ List.filter names ~f:(( <> ) "*")
    else names
  in
  if names = [] then invalid ("no requested outputs for " ^ node.drv_path);
  List.map (sorted names) ~f:(fun name ->
    if name = "" then invalid ("empty output name for " ^ node.drv_path);
    match List.assoc_opt name node.outputs with
    | Some (Some path) when path <> "" && not (Filename.is_relative path) ->
      name, path
    | _ -> invalid ("unresolved output path: " ^ node.drv_path ^ "^" ^ name))

let merge_edges edges =
  List.fold_left edges ~init:Paths.empty ~f:(fun acc (edge : Plan.edge) ->
    if edge.outputs = []
    then acc
    else
      let path = Plan.normalize_drv_path edge.drv_path in
      let old = Option.value (Paths.find_opt path acc) ~default:Strings.empty in
      Paths.add path (Strings.union old (set edge.outputs)) acc)
  |> Paths.bindings
  |> List.map ~f:(fun (drv_path, names) ->
    ({ drv_path; outputs = Strings.elements names } : Plan.edge))

let normalize_roots graph roots =
  merge_edges roots
  |> List.map ~f:(fun (edge : Plan.edge) ->
    { edge with
      outputs =
        List.map (selected (node graph edge.drv_path) edge.outputs) ~f:fst
    })

let normalize_requests graph requests =
  let seen = ref Strings.empty in
  List.map requests ~f:(fun (request : request) ->
    if String.trim request.id = "" then invalid "request IDs must not be empty";
    if Strings.mem request.id !seen
    then invalid ("duplicate request ID: " ^ request.id);
    seen := Strings.add request.id !seen;
    { request with roots = normalize_roots graph request.roots })
  |> List.sort ~cmp:(fun (a : request) b -> String.compare a.id b.id)

type requirement =
  { node : Plan.node
  ; outputs : Strings.t
  ; consumers : Strings.t
  }

let add_link links left right =
  let previous =
    Option.value (Paths.find_opt left links) ~default:Strings.empty
  in
  Paths.add left (Strings.add right previous) links

let neighbours links path =
  Option.value (Paths.find_opt path links) ~default:Strings.empty

let check_acyclic members inputs =
  let remaining = Hashtbl.create (Strings.cardinal members) in
  let parents = ref Paths.empty in
  let ready = Queue.create () in
  Strings.iter
    (fun path ->
       let children = Strings.inter members (neighbours inputs path) in
       let count = Strings.cardinal children in
       Hashtbl.add remaining path count;
       if count = 0 then Queue.add path ready;
       Strings.iter
         (fun child -> parents := add_link !parents child path)
         children)
    members;
  let visited = ref 0 in
  while not (Queue.is_empty ready) do
    let path = Queue.take ready in
    incr visited;
    Strings.iter
      (fun parent ->
         let count = Hashtbl.find remaining parent - 1 in
         Hashtbl.replace remaining parent count;
         if count = 0 then Queue.add parent ready)
      (neighbours !parents path)
  done;
  if !visited <> Strings.cardinal members
  then invalid "cyclic missing derivation graph cannot be scheduled"

let components members inputs =
  let links = ref inputs in
  Paths.iter
    (fun parent children ->
       Strings.iter
         (fun child -> links := add_link !links child parent)
         children)
    inputs;
  let remaining = ref members in
  let result = ref [] in
  while not (Strings.is_empty !remaining) do
    let ready = Queue.create () in
    let first = Strings.min_elt !remaining in
    Queue.add first ready;
    remaining := Strings.remove first !remaining;
    let component = ref Strings.empty in
    while not (Queue.is_empty ready) do
      let path = Queue.take ready in
      component := Strings.add path !component;
      let next = Strings.inter !remaining (neighbours !links path) in
      remaining := Strings.diff !remaining next;
      Strings.iter (fun path -> Queue.add path ready) next
    done;
    result := !component :: !result
  done;
  List.rev !result

let group_id kind system consumers members =
  let prefix = match kind with `Shared -> "shared" | `Package -> "package" in
  let identity =
    `List
      [ `String prefix
      ; `String system
      ; `List (List.map consumers ~f:(fun s -> `String s))
      ; `List (List.map members ~f:(fun s -> `String s))
      ]
    |> Yojson.Safe.to_string
  in
  prefix ^ "-" ^ Digest.to_hex (Digest.string identity)

let create graph ~requests ~availability =
  try
    let requests = normalize_requests graph requests in
    let cache = Hashtbl.create 128 in
    let available path =
      match Hashtbl.find_opt cache path with
      | Some value -> value
      | None ->
        let value =
          match availability path with
          | Plan.Local -> Plan.Missing
          | value -> value
        in
        Hashtbl.add cache path value;
        value
    in
    let needs_build (node : Plan.node) outputs =
      (not node.allow_substitutes)
      || List.exists outputs ~f:(fun (_, path) ->
        match available path with
        | Plan.Cached _ -> false
        | Plan.Local | Plan.Missing -> true)
    in
    let missing = ref Paths.empty in
    let request_systems = ref Paths.empty in
    List.iter requests ~f:(fun (request : request) ->
      let seen = ref Paths.empty in
      let expanded = ref Strings.empty in
      let systems = ref Strings.empty in
      let queue = Queue.create () in
      List.iter request.roots ~f:(fun edge -> Queue.add edge queue);
      while not (Queue.is_empty queue) do
        let (edge : Plan.edge) = Queue.take queue in
        if edge.outputs <> []
        then
          let drv_path = Plan.normalize_drv_path edge.drv_path in
          let node = node graph drv_path in
          let outputs = selected node edge.outputs in
          let old =
            Option.value (Paths.find_opt drv_path !seen) ~default:Strings.empty
          in
          let names = Strings.union old (set (List.map outputs ~f:fst)) in
          if not (Strings.equal old names)
          then (
            seen := Paths.add drv_path names !seen;
            if node.system <> "" && not (neutral node.system)
            then systems := Strings.add node.system !systems;
            if needs_build node (selected node (Strings.elements names))
            then (
              if node.system = ""
              then invalid ("missing executor system for " ^ drv_path);
              let previous = Paths.find_opt drv_path !missing in
              let consumers, outputs =
                match previous with
                | None -> Strings.singleton request.id, names
                | Some previous ->
                  ( Strings.add request.id previous.consumers
                  , Strings.union names previous.outputs )
              in
              missing :=
                Paths.add drv_path { node; outputs; consumers } !missing;
              if not (Strings.mem drv_path !expanded)
              then (
                expanded := Strings.add drv_path !expanded;
                List.iter node.inputs ~f:(fun edge -> Queue.add edge queue))))
      done;
      request_systems := Paths.add request.id !systems !request_systems);
    let all = set (List.map (Paths.bindings !missing) ~f:fst) in
    let inputs =
      Paths.fold
        (fun path required links ->
           List.fold_left
             required.node.inputs
             ~init:links
             ~f:(fun links (edge : Plan.edge) ->
               if edge.Plan.outputs = []
               then links
               else
                 let child = node graph edge.drv_path in
                 if needs_build child (selected child edge.outputs)
                 then add_link links path child.drv_path
                 else links))
        !missing
        Paths.empty
    in
    check_acyclic all inputs;
    let shared =
      Paths.fold
        (fun path required shared ->
           if Strings.cardinal required.consumers > 1
           then Strings.add path shared
           else shared)
        !missing
        Strings.empty
    in
    let consumers members =
      Strings.fold
        (fun path consumers ->
           Strings.union consumers (Paths.find path !missing).consumers)
        members
        Strings.empty
    in
    let system members =
      let systems =
        Strings.fold
          (fun path systems ->
             let system = (Paths.find path !missing).node.system in
             if neutral system then systems else Strings.add system systems)
          members
          Strings.empty
      in
      match Strings.elements systems with
      | [ system ] -> system
      | [] ->
        let candidates =
          Strings.fold
            (fun request candidates ->
               Strings.union candidates (Paths.find request !request_systems))
            (consumers members)
            Strings.empty
        in
        if Strings.is_empty candidates
        then
          invalid "builtin-only work needs a concrete consuming executor system"
        else Strings.min_elt candidates
      | systems ->
        invalid
          ("dependency component requires incompatible executor systems: "
          ^ String.concat ~sep:", " systems)
    in
    let make_group kind system members =
      let consumers = Strings.elements (consumers members) in
      let covered_inputs =
        Strings.fold
          (fun path acc -> Strings.union acc (neighbours inputs path))
          members
          Strings.empty
      in
      let roots =
        Strings.elements (Strings.diff members covered_inputs)
        |> List.map ~f:(fun drv_path ->
          ({ drv_path
           ; outputs = Strings.elements (Paths.find drv_path !missing).outputs
           }
           : Plan.edge))
      in
      let members = Strings.elements members in
      { id = group_id kind system consumers members
      ; system
      ; kind
      ; roots
      ; members
      ; consumers
      ; needs = []
      ; required_paths = []
      }
    in
    let shared_groups =
      List.map (components shared inputs) ~f:(fun members ->
        make_group `Shared (system members) members)
    in
    let private_components = components (Strings.diff all shared) inputs in
    let private_groups =
      List.fold_left
        private_components
        ~init:Paths.empty
        ~f:(fun groups members ->
          let consumer_set = consumers members in
          if Strings.cardinal consumer_set <> 1
          then invalid "private dependency component has multiple consumers";
          let consumer = Strings.min_elt consumer_set in
          let system = system members in
          let key =
            Yojson.Safe.to_string (`List [ `String consumer; `String system ])
          in
          let previous =
            match Paths.find_opt key groups with
            | None -> Strings.empty
            | Some (_, previous) -> previous
          in
          Paths.add key (system, Strings.union previous members) groups)
      |> Paths.bindings
      |> List.map ~f:(fun (_, (system, members)) ->
        make_group `Package system members)
    in
    let groups = shared_groups @ private_groups in
    let owners =
      List.fold_left groups ~init:Paths.empty ~f:(fun owners (group : group) ->
        List.fold_left group.members ~init:owners ~f:(fun owners path ->
          Paths.add path group owners))
    in
    (* A dependency being reachable from another owned root does not ensure all
       its outputs: Nix may substitute that parent and prune its inputs. Keep
       every obligation at the job boundary as an explicit selector. *)
    let boundary = ref Paths.empty in
    let add_boundary (edge : Plan.edge) =
      let child = node graph edge.drv_path in
      let outputs = selected child edge.outputs in
      if needs_build child outputs
      then
        let previous =
          Option.value
            (Paths.find_opt child.drv_path !boundary)
            ~default:Strings.empty
        in
        boundary :=
          Paths.add
            child.drv_path
            (Strings.union previous (set (List.map outputs ~f:fst)))
            !boundary
    in
    List.iter requests ~f:(fun (request : request) ->
      List.iter request.roots ~f:add_boundary);
    Paths.iter
      (fun path required ->
         let owner = Paths.find path owners in
         List.iter required.node.inputs ~f:(fun (edge : Plan.edge) ->
           if edge.outputs <> []
           then
             match
               Paths.find_opt (Plan.normalize_drv_path edge.drv_path) owners
             with
             | Some dependency when owner.id <> dependency.id ->
               add_boundary edge
             | _ -> ()))
      !missing;
    let groups =
      List.map groups ~f:(fun (group : group) ->
        let members = set group.members in
        let roots =
          List.filter_map group.members ~f:(fun drv_path ->
            Option.map
              (fun names ->
                 ({ drv_path; outputs = Strings.elements names } : Plan.edge))
              (Paths.find_opt drv_path !boundary))
          |> fun obligations -> merge_edges (group.roots @ obligations)
        in
        let needed = ref Strings.empty in
        let required_paths = ref Strings.empty in
        List.iter group.members ~f:(fun path ->
          List.iter (node graph path).inputs ~f:(fun (edge : Plan.edge) ->
            if edge.Plan.outputs <> []
            then
              let child = node graph edge.drv_path in
              if not (Strings.mem child.drv_path members)
              then (
                let outputs = selected child edge.outputs in
                List.iter outputs ~f:(fun (_, path) ->
                  required_paths := Strings.add path !required_paths);
                if needs_build child outputs
                then (
                  let owner = Paths.find child.drv_path owners in
                  if owner.kind <> `Shared
                  then
                    invalid
                      ("private dependency crosses executor groups: "
                      ^ child.drv_path);
                  needed := Strings.add owner.id !needed))));
        { group with
          roots
        ; needs = Strings.elements !needed
        ; required_paths = Strings.elements !required_paths
        })
      |> List.sort ~cmp:(fun a b ->
        match a.kind, b.kind with
        | `Shared, `Package -> -1
        | `Package, `Shared -> 1
        | _ -> String.compare a.id b.id)
    in
    Ok { requests; groups }
  with
  | Invalid_plan message -> Error message

let string_list values = `List (List.map values ~f:(fun value -> `String value))

let edge_json (edge : Plan.edge) =
  `Assoc
    [ "drvPath", `String edge.drv_path; "outputs", string_list edge.outputs ]

let to_yojson plan =
  `Assoc
    [ "version", `Int 1
    ; ( "requests"
      , `List
          (List.map plan.requests ~f:(fun (request : request) ->
             `Assoc
               [ "id", `String request.id
               ; "roots", `List (List.map request.roots ~f:edge_json)
               ])) )
    ; ( "groups"
      , `List
          (List.map plan.groups ~f:(fun (group : group) ->
             `Assoc
               [ "id", `String group.id
               ; "system", `String group.system
               ; ( "kind"
                 , `String
                     (match group.kind with
                     | `Shared -> "shared"
                     | `Package -> "package") )
               ; "roots", `List (List.map group.roots ~f:edge_json)
               ; "members", string_list group.members
               ; "consumers", string_list group.consumers
               ; "needs", string_list group.needs
               ; "requiredPaths", string_list group.required_paths
               ])) )
    ]

let fields context = function
  | `Assoc fields -> fields
  | _ -> invalid (context ^ ": expected an object")

let field fields name =
  match List.assoc_opt name fields with
  | Some value -> value
  | None -> invalid ("missing field: " ^ name)

let string = function
  | `String value when String.trim value <> "" -> value
  | _ -> invalid "expected a nonempty string"

let list parse = function
  | `List values -> List.map values ~f:parse
  | _ -> invalid "expected a list"

let unique context values =
  if List.length values <> List.length (sorted values)
  then invalid ("duplicate " ^ context)

let check_structure plan =
  let request_ids = List.map plan.requests ~f:(fun (r : request) -> r.id) in
  unique "request ID" request_ids;
  unique "group ID" (List.map plan.groups ~f:(fun (g : group) -> g.id));
  let owners = ref Strings.empty in
  let groups =
    List.fold_left plan.groups ~init:Paths.empty ~f:(fun acc (g : group) ->
      Paths.add g.id g acc)
  in
  List.iter plan.groups ~f:(fun (group : group) ->
    if group.members = [] || group.roots = [] || group.consumers = []
    then invalid ("empty execution group: " ^ group.id);
    if group.system = "" || neutral group.system
    then invalid ("group needs a concrete executor: " ^ group.id);
    unique "group member" group.members;
    unique "group consumer" group.consumers;
    unique "group dependency" group.needs;
    unique "required path" group.required_paths;
    List.iter group.consumers ~f:(fun id ->
      if not (List.mem id ~set:request_ids)
      then invalid ("unknown consumer request: " ^ id));
    if group.kind = `Package && List.length group.consumers <> 1
    then invalid ("package group must have one consumer: " ^ group.id);
    if group.kind = `Shared && List.length group.consumers < 2
    then invalid ("shared group needs multiple consumers: " ^ group.id);
    List.iter group.members ~f:(fun path ->
      if Strings.mem path !owners
      then invalid ("duplicate derivation ownership: " ^ path);
      owners := Strings.add path !owners);
    List.iter group.roots ~f:(fun (root : Plan.edge) ->
      if root.outputs = [] || not (List.mem root.drv_path ~set:group.members)
      then invalid ("group root must be an owned derivation: " ^ root.drv_path));
    List.iter group.needs ~f:(fun id ->
      match Paths.find_opt id groups with
      | Some dependency when dependency.kind = `Shared && group.kind = `Package
        ->
        ()
      | _ -> invalid ("invalid prerequisite group: " ^ id)))

let of_yojson json =
  try
    let top = fields "shared plan" json in
    (match field top "version" with
    | `Int 1 -> ()
    | _ -> invalid "unsupported shared plan version");
    let edge value =
      let fields = fields "edge" value in
      ({ drv_path = string (field fields "drvPath")
       ; outputs = list string (field fields "outputs")
       }
       : Plan.edge)
    in
    let requests =
      list
        (fun value ->
           let fields = fields "request" value in
           ({ id = string (field fields "id")
            ; roots = list edge (field fields "roots")
            }
            : request))
        (field top "requests")
    in
    let groups =
      list
        (fun value ->
           let fields = fields "group" value in
           let strings name = list string (field fields name) in
           { id = string (field fields "id")
           ; system = string (field fields "system")
           ; kind =
               (match field fields "kind" with
               | `String "shared" -> `Shared
               | `String "package" -> `Package
               | _ -> invalid "unknown group kind")
           ; roots = list edge (field fields "roots")
           ; members = strings "members"
           ; consumers = strings "consumers"
           ; needs = strings "needs"
           ; required_paths = strings "requiredPaths"
           })
        (field top "groups")
    in
    let plan = { requests; groups } in
    check_structure plan;
    Ok plan
  with
  | Invalid_plan message -> Error message

let validate graph plan =
  try
    check_structure plan;
    ignore (normalize_requests graph plan.requests);
    let owners =
      List.fold_left
        plan.groups
        ~init:Paths.empty
        ~f:(fun owners (group : group) ->
          List.fold_left group.members ~init:owners ~f:(fun owners path ->
            Paths.add path group owners))
    in
    List.iter plan.groups ~f:(fun (group : group) ->
      let members = set group.members in
      let external_paths = ref Strings.empty in
      let external_owners = ref Strings.empty in
      let queue = Queue.create () in
      let seen = ref Strings.empty in
      List.iter
        (normalize_roots graph group.roots)
        ~f:(fun (edge : Plan.edge) -> Queue.add edge.drv_path queue);
      while not (Queue.is_empty queue) do
        let path = Queue.take queue in
        if not (Strings.mem path !seen)
        then (
          seen := Strings.add path !seen;
          let current = node graph path in
          if current.system <> group.system && not (neutral current.system)
          then invalid ("executor mismatch for " ^ path);
          List.iter current.inputs ~f:(fun (edge : Plan.edge) ->
            if edge.Plan.outputs <> []
            then
              let child = node graph edge.drv_path in
              let outputs = selected child edge.outputs in
              if Strings.mem child.drv_path members
              then Queue.add child.drv_path queue
              else (
                List.iter outputs ~f:(fun (_, path) ->
                  external_paths := Strings.add path !external_paths);
                match Paths.find_opt child.drv_path owners with
                | Some owner ->
                  external_owners := Strings.add owner.id !external_owners
                | None -> ())))
      done;
      if not (Strings.equal !seen members)
      then invalid ("group roots do not cover owned derivations: " ^ group.id);
      if not (Strings.equal !external_paths (set group.required_paths))
      then invalid ("incorrect external transfer paths for " ^ group.id);
      if not (Strings.subset (set group.needs) !external_owners)
      then
        invalid ("prerequisite group supplies no required output: " ^ group.id));
    Ok ()
  with
  | Invalid_plan message -> Error message
