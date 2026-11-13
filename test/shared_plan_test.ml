module Plan = Nix_ci_build.Plan
module Shared = Nix_ci_build.Shared_plan

let check condition message = if not condition then failwith message
let drv name = "/nix/store/" ^ name ^ ".drv"
let out name = "/nix/store/" ^ name
let sorted values = List.sort_uniq String.compare values

let edge ?(outputs = [ "out" ]) name : Plan.edge =
  { drv_path = drv name; outputs }

let node
      ?(inputs = [])
      ?outputs
      ?(system = "x86_64-linux")
      ?(allow_substitutes = true)
      name : Plan.node
  =
  { drv_path = drv name
  ; name
  ; system
  ; allow_substitutes
  ; inputs
  ; outputs = Option.value outputs ~default:[ "out", Some (out name) ]
  }

let request id roots : Shared.request = { id; roots }
let missing _ = Plan.Missing

let cached =
  Plan.Cached { references = []; download_size = None; nar_size = None }

let available values path =
  Option.value (List.assoc_opt path values) ~default:Plan.Missing

let require_ok label = function
  | Ok value -> value
  | Error error -> failwith (label ^ ": " ^ error)

let require_error label = function
  | Error error -> check (String.trim error <> "") (label ^ ": empty error")
  | Ok _ -> failwith (label ^ ": unexpectedly accepted")

let owner (plan : Shared.t) path =
  match
    List.filter
      (fun (group : Shared.group) -> List.mem path group.members)
      plan.groups
  with
  | [ group ] -> group
  | groups ->
    failwith
      (Printf.sprintf
         "%s must have one owner, found %d"
         path
         (List.length groups))

let selected_paths (graph : Plan.t) (edge : Plan.edge) =
  let node = Option.get (Plan.find graph edge.drv_path) in
  let outputs =
    if List.mem "*" edge.outputs
    then List.map fst node.outputs
    else edge.outputs
  in
  List.map (fun output -> Option.get (List.assoc output node.outputs)) outputs

(* A runner cannot rely on paths present only on the planning machine. The
   independent closure oracle therefore cuts only substitutable remote hits. *)
let runner_availability graph availability path =
  let forbidden =
    List.exists
      (fun (node : Plan.node) ->
         (not node.allow_substitutes)
         && List.exists (fun (_, value) -> value = Some path) node.outputs)
      (Plan.nodes graph)
  in
  if forbidden
  then Plan.Missing
  else
    match availability path with Plan.Local -> Plan.Missing | value -> value

let check_coverage graph availability (plan : Shared.t) =
  let availability = runner_availability graph availability in
  let closures =
    List.map
      (fun (request : Shared.request) ->
         let work = Plan.compute graph ~roots:request.roots ~availability in
         check (work.unknown = []) "fixture closure must have complete metadata";
         ( request.id
         , List.map (fun (node : Plan.node) -> node.drv_path) work.builds ))
      plan.requests
  in
  let all_members =
    List.concat_map (fun (group : Shared.group) -> group.members) plan.groups
  in
  check
    (List.length all_members = List.length (sorted all_members))
    "no derivation may have multiple owners";
  check
    (sorted all_members = sorted (List.concat_map snd closures))
    "owned work must exactly cover the requested uncached closures";
  let group_ids =
    List.map (fun (group : Shared.group) -> group.id) plan.groups
  in
  check
    (List.length group_ids = List.length (sorted group_ids))
    "group ids must be unique";
  let group id = List.find (fun (g : Shared.group) -> g.id = id) plan.groups in
  let rec reachable seen = function
    | [] -> seen
    | id :: rest when List.mem id seen -> reachable seen rest
    | id :: rest ->
      check (List.mem id group_ids) "every dependency must identify a group";
      reachable (id :: seen) ((group id).needs @ rest)
  in
  List.iter
    (fun (request : Shared.request) ->
       let closure = List.assoc request.id closures in
       let roots =
         List.filter_map
           (fun (edge : Plan.edge) ->
              if List.mem edge.drv_path closure
              then Some (owner plan edge.drv_path).id
              else None)
           request.roots
       in
       let supplied =
         reachable [] roots |> List.concat_map (fun id -> (group id).members)
       in
       List.iter
         (fun path ->
            check
              (List.mem path supplied)
              (request.id ^ " cannot reach the owner of " ^ path))
         closure)
    plan.requests;
  List.iter
    (fun (group : Shared.group) ->
       check (group.members <> []) "an execution group must own work";
       check
         (not (List.mem group.id (reachable [] group.needs)))
         "execution dependencies must be acyclic";
       check
         (group.system <> "" && group.system <> "builtin")
         "every group must select a concrete executor";
       List.iter
         (fun path ->
            let node = Option.get (Plan.find graph path) in
            List.iter
              (fun (input : Plan.edge) ->
                 if not (List.mem input.drv_path group.members)
                 then (
                   List.iter
                     (fun output ->
                        check
                          (List.mem output group.required_paths)
                          (group.id ^ " omits import path " ^ output))
                     (selected_paths graph input);
                   if List.mem input.drv_path all_members
                   then
                     let supplier = owner plan input.drv_path in
                     let must_build =
                       List.exists
                         (fun output -> availability output = Plan.Missing)
                         (selected_paths graph input)
                     in
                     if must_build
                     then
                       check
                         (List.mem supplier.id (reachable [] group.needs))
                         (group.id
                         ^ " cannot reach dependency owner "
                         ^ supplier.id)))
              node.inputs)
         group.members)
    plan.groups;
  require_ok "validate generated plan" (Shared.validate graph plan)

let create ?(availability = missing) graph requests =
  let plan =
    require_ok
      "create shared plan"
      (Shared.create graph ~requests ~availability)
  in
  check_coverage graph availability plan;
  plan

let shared_groups (plan : Shared.t) =
  List.filter (fun (group : Shared.group) -> group.kind = `Shared) plan.groups

let test_hidden_diamond () =
  let graph =
    Plan.of_nodes
      [ node "a" ~inputs:[ edge "left" ]
      ; node "b" ~inputs:[ edge "right" ]
      ; node "left" ~inputs:[ edge "hidden-common" ]
      ; node "right" ~inputs:[ edge "hidden-common" ]
      ; node "hidden-common" ~inputs:[ edge "deep-tool" ]
      ; node "deep-tool"
      ; node "independent" ~inputs:[ edge "private-tool" ]
      ; node "private-tool"
      ]
  in
  let plan =
    create
      graph
      [ request "a" [ edge "a" ]
      ; request "b" [ edge "b" ]
      ; request "independent" [ edge "independent" ]
      ]
  in
  let common = owner plan (drv "hidden-common") in
  check (common.kind = `Shared) "hidden transitive sharing must be extracted";
  check
    (sorted common.members = sorted [ drv "hidden-common"; drv "deep-tool" ])
    "the shared owner's transitive closure must include its compiler";
  check
    (sorted common.consumers = [ "a"; "b" ])
    "independent requests must not become shared consumers";
  check
    ((owner plan (drv "a")).id <> (owner plan (drv "b")).id)
    "private branches must stay independently schedulable";
  check
    ((owner plan (drv "independent")).needs = [])
    "independent work must not wait for a shared branch"

let test_compiler_identity_not_names () =
  let tool = { (node "opaque-tool") with name = "ordinary-package" } in
  let unrelated = { (node "unrelated-tool") with name = tool.name } in
  let graph =
    Plan.of_nodes
      [ node "native-app" ~inputs:[ edge "opaque-tool" ]
      ; node "mingw-app" ~inputs:[ edge "opaque-tool" ]
      ; node "other-app" ~inputs:[ edge "unrelated-tool" ]
      ; tool
      ; unrelated
      ]
  in
  let plan =
    create
      graph
      [ request "native" [ edge "native-app" ]
      ; request "cross" [ edge "mingw-app" ]
      ; request "other" [ edge "other-app" ]
      ]
  in
  check
    (sorted (owner plan tool.drv_path).consumers = [ "cross"; "native" ])
    "native and cross requests must share by derivation identity";
  check
    ((owner plan unrelated.drv_path).kind = `Package)
    "identical display names must not manufacture sharing"

let test_aliases_are_one_consumer () =
  let graph =
    Plan.of_nodes
      [ node "first" ~inputs:[ edge "tool" ]
      ; node "second" ~inputs:[ edge "tool" ]
      ; node "tool"
      ]
  in
  let plan =
    create
      graph
      [ request "one-job" [ edge "first"; edge "first"; edge "second" ] ]
  in
  check
    (shared_groups plan = [])
    "multiple aliases or roots inside one request must not count as sharing";
  check
    ((owner plan (drv "tool")).consumers = [ "one-job" ])
    "consumer ids must be deduplicated"

let split_graph () =
  Plan.of_nodes
    [ node "out-user" ~inputs:[ edge "split" ]
    ; node "dev-user" ~inputs:[ edge "split" ~outputs:[ "dev" ] ]
    ; node
        "split"
        ~inputs:[ edge "compiler" ]
        ~outputs:
          [ "out", Some (out "split")
          ; "dev", Some (out "split-dev")
          ; "unrequested", None
          ]
    ; node "compiler"
    ]

let test_multiple_outputs_one_owner () =
  let plan =
    create
      (split_graph ())
      [ request "out" [ edge "out-user" ]; request "dev" [ edge "dev-user" ] ]
  in
  let group = owner plan (drv "split") in
  check (group.kind = `Shared) "different outputs share one derivation owner";
  check
    ((owner plan (drv "compiler")).id = group.id)
    "shared output ownership must include the transitive compiler";
  let selected =
    List.filter
      (fun (edge : Plan.edge) -> edge.drv_path = drv "split")
      group.roots
    |> List.concat_map (fun (edge : Plan.edge) -> edge.outputs)
    |> sorted
  in
  check
    (selected = [ "dev"; "out" ])
    "the shared build frontier must preserve both requested outputs"

let test_cached_output_is_not_a_consumer () =
  let plan =
    create
      (split_graph ())
      ~availability:(available [ out "split", cached ])
      [ request "cached-out" [ edge "split" ]
      ; request "missing-dev" [ edge "split" ~outputs:[ "dev" ] ]
      ]
  in
  let group = owner plan (drv "split") in
  check
    (group.kind = `Package && group.consumers = [ "missing-dev" ])
    "a cached output request must not force a shared owner for another output";
  check (List.length plan.requests = 2) "cached requests remain represented"

let test_boundary_roots_survive_cached_ancestor () =
  let check_case ~external_consumer selected_output =
    let child =
      node
        "child"
        ~inputs:[ edge "compiler" ]
        ~outputs:[ "out", Some (out "child"); "dev", Some (out "child-dev") ]
    in
    let consumer =
      node "consumer" ~inputs:[ edge "child" ~outputs:[ selected_output ] ]
    in
    let graph =
      Plan.of_nodes
        [ node "a" ~inputs:[ edge "parent" ]
        ; node "b" ~inputs:[ edge "parent" ]
        ; node "parent" ~inputs:[ edge "child" ]
        ; child
        ; node "compiler"
        ; consumer
        ]
    in
    let third_root =
      if external_consumer
      then edge "consumer"
      else edge "child" ~outputs:[ selected_output ]
    in
    let plan =
      create
        graph
        [ request "a" [ edge "a" ]
        ; request "b" [ edge "b" ]
        ; request "c" [ third_root ]
        ]
    in
    let group = owner plan child.drv_path in
    check
      ((owner plan (drv "parent")).id = group.id)
      "shared parent and child must have one owner";
    check
      (List.exists
         (fun (edge : Plan.edge) ->
            edge.drv_path = child.drv_path
            && List.mem selected_output edge.outputs)
         group.roots)
      "independent output obligations must remain explicit build roots";
    let remaining =
      Plan.compute
        graph
        ~roots:group.roots
        ~availability:(available [ out "parent", cached ])
    in
    check
      (List.exists
         (fun (node : Plan.node) -> node.drv_path = child.drv_path)
         remaining.builds)
      "a newly cached ancestor must not hide another consumer's child output"
  in
  check_case ~external_consumer:true "dev";
  check_case ~external_consumer:false "out"

let test_remote_local_and_forbidden_cache_cuts () =
  let graph allow_substitutes =
    Plan.of_nodes
      [ node "a" ~inputs:[ edge "shared" ]
      ; node "b" ~inputs:[ edge "shared" ]
      ; node "shared" ~inputs:[ edge "compiler" ] ~allow_substitutes
      ; node "compiler"
      ]
  in
  let requests = [ request "a" [ edge "a" ]; request "b" [ edge "b" ] ] in
  let remote =
    create
      (graph true)
      requests
      ~availability:(available [ out "shared", cached ])
  in
  check (shared_groups remote = []) "remote hits must prune shared build work";
  check
    (List.for_all
       (fun (group : Shared.group) -> group.required_paths = [ out "shared" ])
       remote.groups)
    "cached boundary outputs must be imported explicitly by both runners";
  let local =
    create
      (graph true)
      requests
      ~availability:(available [ out "shared", Plan.Local ])
  in
  check
    ((owner local (drv "shared")).kind = `Shared)
    "planning-machine local paths are not runner cache hits";
  let forbidden =
    create
      (graph false)
      requests
      ~availability:(available [ out "shared", cached ])
  in
  check
    ((owner forbidden (drv "shared")).kind = `Shared)
    "allowSubstitutes=false must preserve builds despite remote metadata"

let test_cached_only_and_irrelevant_bad_graph () =
  let graph =
    Plan.of_nodes
      [ node "cached" ~inputs:[ edge "absent"; edge "cycle" ]
      ; node "cycle" ~inputs:[ edge "cycle" ]
      ]
  in
  let plan =
    create
      graph
      ~availability:(available [ out "cached", cached ])
      [ request "one" [ edge "cached" ]; request "two" [ edge "cached" ] ]
  in
  check (plan.groups = []) "all cached requests need no execution group"

let test_disjoint_shared_components () =
  let graph =
    Plan.of_nodes
      [ node "a" ~inputs:[ edge "one"; edge "two" ]
      ; node "b" ~inputs:[ edge "one"; edge "two" ]
      ; node "one"
      ; node "two"
      ]
  in
  let plan =
    create graph [ request "a" [ edge "a" ]; request "b" [ edge "b" ] ]
  in
  check
    (List.length (shared_groups plan) = 2)
    "disconnected shared prerequisites must remain separately schedulable";
  check
    ((owner plan (drv "one")).id <> (owner plan (drv "two")).id)
    "a shared owner must not combine disconnected components"

let test_deterministic_serialization () =
  let nodes =
    [ node "a" ~inputs:[ edge "one"; edge "two" ]
    ; node "b" ~inputs:[ edge "two"; edge "one" ]
    ; node "one"
    ; node "two"
    ; node "private"
    ]
  in
  let requests =
    [ request "a" [ edge "private"; edge "a" ]; request "b" [ edge "b" ] ]
  in
  let first = create (Plan.of_nodes nodes) requests in
  let reversed_nodes =
    List.rev_map
      (fun (node : Plan.node) ->
         { node with
           inputs = List.rev node.inputs
         ; outputs = List.rev node.outputs
         })
      nodes
  in
  let reversed_requests =
    List.rev_map
      (fun (request : Shared.request) ->
         { request with roots = List.rev request.roots })
      requests
  in
  let second = create (Plan.of_nodes reversed_nodes) reversed_requests in
  check
    (Shared.to_yojson first = Shared.to_yojson second)
    "input order must not alter group ownership, ids, dependencies, or JSON \
     order";
  let decoded =
    Shared.to_yojson first
    |> Yojson.Safe.to_string
    |> Yojson.Safe.from_string
    |> Shared.of_yojson
    |> require_ok "round trip shared plan"
  in
  check
    (Shared.to_yojson first = Shared.to_yojson decoded)
    "saved plans must preserve selected outputs and ownership exactly";
  check_coverage (Plan.of_nodes nodes) missing decoded

let test_invalid_requests_and_graphs () =
  let complete = Plan.of_nodes [ node "root" ] in
  let bad label graph requests =
    require_error label (Shared.create graph ~requests ~availability:missing)
  in
  bad "empty request id" complete [ request "" [ edge "root" ] ];
  bad
    "duplicate request id"
    complete
    [ request "same" [ edge "root" ]; request "same" [ edge "root" ] ];
  bad "missing root metadata" Plan.empty [ request "root" [ edge "root" ] ];
  bad
    "missing dependency metadata"
    (Plan.of_nodes [ node "root" ~inputs:[ edge "absent" ] ])
    [ request "root" [ edge "root" ] ];
  bad
    "unknown selected output path"
    (Plan.of_nodes [ node "root" ~outputs:[ "out", None ] ])
    [ request "root" [ edge "root" ] ];
  bad
    "absent output name"
    complete
    [ request "root" [ edge "root" ~outputs:[ "dev" ] ] ];
  bad
    "dependency cycle"
    (Plan.of_nodes
       [ node "one" ~inputs:[ edge "two" ]; node "two" ~inputs:[ edge "one" ] ])
    [ request "root" [ edge "one" ] ]

let test_executor_compatibility () =
  let linux = node "linux" ~system:"x86_64-linux" in
  let darwin = node "darwin" ~system:"aarch64-darwin" in
  let separate =
    create
      (Plan.of_nodes [ linux; darwin ])
      [ request "both" [ edge "linux"; edge "darwin" ] ]
  in
  check
    (List.length separate.groups = 2)
    "independent roots on different executors require separate groups";
  let incompatible =
    Plan.of_nodes [ { linux with inputs = [ edge "darwin" ] }; darwin ]
  in
  require_error
    "private mixed-executor chain"
    (Shared.create
       incompatible
       ~requests:[ request "linux" [ edge "linux" ] ]
       ~availability:missing);
  require_error
    "shared mixed-executor component"
    (Shared.create
       incompatible
       ~requests:
         [ request "one" [ edge "linux" ]; request "two" [ edge "linux" ] ]
       ~availability:missing)

let test_builtin_executor_context () =
  let graph =
    Plan.of_nodes
      [ node "linux" ~inputs:[ edge "source" ]
      ; node "darwin" ~system:"aarch64-darwin" ~inputs:[ edge "source" ]
      ; node "source" ~system:"builtin"
      ]
  in
  let plan =
    create
      graph
      [ request "linux" [ edge "linux" ]; request "darwin" [ edge "darwin" ] ]
  in
  let source = owner plan (drv "source") in
  check
    (source.kind = `Shared
    && List.mem source.system [ "x86_64-linux"; "aarch64-darwin" ])
    "executor-neutral sources must still run on one concrete consumer executor";
  require_error
    "builtin without executor context"
    (Shared.create
       (Plan.of_nodes [ node "source" ~system:"builtin" ])
       ~requests:[ request "source" [ edge "source" ] ]
       ~availability:missing)

let test_invalid_saved_plans () =
  List.iter
    (fun json -> require_error "malformed saved plan" (Shared.of_yojson json))
    [ `Null; `List []; `Assoc []; `Assoc [ "version", `Int 999 ] ];
  let graph =
    Plan.of_nodes [ node "a" ~inputs:[ edge "tool" ]; node "b"; node "tool" ]
  in
  let plan =
    create graph [ request "a" [ edge "a" ]; request "b" [ edge "b" ] ]
  in
  let first = List.hd plan.groups in
  require_error
    "duplicate group identity"
    (Shared.validate graph { plan with groups = first :: plan.groups });
  require_error
    "unknown group dependency"
    (Shared.validate
       graph
       { plan with
         groups =
           { first with needs = [ "not-a-group" ] } :: List.tl plan.groups
       });
  let second = List.nth plan.groups 1 in
  require_error
    "duplicate derivation ownership"
    (Shared.validate
       graph
       { plan with
         groups =
           [ first
           ; { second with members = List.hd first.members :: second.members }
           ]
       });
  require_error
    "cyclic group dependencies"
    (Shared.validate
       graph
       { plan with
         groups =
           [ { first with needs = [ second.id ] }
           ; { second with needs = [ first.id ] }
           ]
       })

let () =
  List.iter
    (fun (name, test) ->
       test ();
       Printf.printf "shared_plan: %s passed\n%!" name)
    [ "hidden diamond", test_hidden_diamond
    ; "compiler identity", test_compiler_identity_not_names
    ; "request aliases", test_aliases_are_one_consumer
    ; "multiple outputs", test_multiple_outputs_one_owner
    ; "cached output consumers", test_cached_output_is_not_a_consumer
    ; ( "boundary roots after cache changes"
      , test_boundary_roots_survive_cached_ancestor )
    ; "cache cuts", test_remote_local_and_forbidden_cache_cuts
    ; "cached irrelevant graph", test_cached_only_and_irrelevant_bad_graph
    ; "disjoint components", test_disjoint_shared_components
    ; "deterministic saved plan", test_deterministic_serialization
    ; "invalid graph and requests", test_invalid_requests_and_graphs
    ; "executor compatibility", test_executor_compatibility
    ; "builtin executor context", test_builtin_executor_context
    ; "invalid saved plans", test_invalid_saved_plans
    ]
