module Plan = Nix_ci_build.Plan

let check condition message = if not condition then failwith message
let drv name = "/nix/store/" ^ name ^ ".drv"
let out name = "/nix/store/" ^ name

let edge ?(outputs = [ "out" ]) name : Plan.edge =
  { drv_path = drv name; outputs }

let node ?(inputs = []) ?outputs ?(allow_substitutes = true) name : Plan.node =
  let outputs =
    match outputs with
    | None -> [ "out", Some (out name) ]
    | Some outputs -> outputs
  in
  { drv_path = drv name
  ; name
  ; system = "x86_64-linux"
  ; allow_substitutes
  ; inputs
  ; outputs
  }

let cached ?(references = []) ?download_size ?nar_size () =
  Plan.Cached { references; download_size; nar_size }

let available values path =
  match List.assoc_opt path values with
  | None -> Plan.Missing
  | Some value -> value

let missing _ = Plan.Missing

let build_names (plan : Plan.plan) =
  List.map (fun (node : Plan.node) -> node.name) plan.builds

let ranked_names roots =
  List.map (fun (root : Plan.edge) -> root.drv_path) roots

let graph () =
  Plan.of_nodes
    [ node "a" ~inputs:[ edge "shared"; edge "cached" ]
    ; node "b" ~inputs:[ edge "shared" ]
    ; node "shared"
    ; node "cached" ~inputs:[ edge "hidden" ]
    ; node "hidden"
    ; node "independent"
    ]

let test_shared_pruned_graph () =
  let availability = available [ out "cached", cached () ] in
  let plan =
    Plan.compute (graph ()) ~roots:[ edge "a"; edge "b" ] ~availability
  in
  check
    (build_names plan = [ "a"; "b"; "shared" ])
    "shared dependencies must be unique, cached branches pruned";
  check
    (List.map (fun (d : Plan.download) -> d.path) plan.downloads
    = [ out "cached" ])
    "cached root must be a download";
  check
    (Plan.explain
       (graph ())
       ~availability
       ~root:(edge "a")
       ~target:(drv "shared")
    = Some [ drv "a"; drv "shared" ])
    "explain should find a dependency path";
  check
    (Plan.explain
       (graph ())
       ~availability
       ~root:(edge "a")
       ~target:(drv "hidden")
    = None)
    "explain must not report prerequisites hidden by a cached output";
  check
    (Plan.explain
       (graph ())
       ~availability
       ~root:(edge "a")
       ~target:(out "cached")
    = Some [ drv "a"; drv "cached"; out "cached" ])
    "explain should identify output paths"

let test_output_sensitivity () =
  let graph =
    Plan.of_nodes
      [ node "root" ~inputs:[ edge "split" ]
      ; node
          "split"
          ~outputs:[ "out", Some (out "split"); "dev", Some (out "split-dev") ]
          ~inputs:[ edge "compiler" ]
      ; node "compiler"
      ]
  in
  let availability = available [ out "split", cached () ] in
  let plan = Plan.compute graph ~roots:[ edge "root" ] ~availability in
  check
    (build_names plan = [ "root" ])
    "an unrequested missing output must not cause a build";
  let plan =
    Plan.compute
      graph
      ~roots:[ edge "root"; edge "split" ~outputs:[ "dev" ] ]
      ~availability
  in
  check
    (build_names plan = [ "compiler"; "root"; "split" ])
    "requesting a missing output must expose the build inputs";
  check
    (plan.downloads = [])
    "an output produced by a required build must not also count as a download";
  let plan =
    Plan.compute graph ~roots:[ edge "split" ~outputs:[ "*" ] ] ~availability
  in
  check
    (build_names plan = [ "compiler"; "split" ])
    "wildcard must include every output";
  let availability =
    available [ out "split", Plan.Local; out "split-dev", Plan.Local ]
  in
  let plan =
    Plan.compute graph ~roots:[ edge "split" ~outputs:[ "*" ] ] ~availability
  in
  check
    (plan.builds = [] && plan.downloads = [])
    "fully local output set should require no work"

let test_download_closure () =
  let graph =
    Plan.of_nodes [ node "cached" ~inputs:[ edge "hidden" ]; node "hidden" ]
  in
  let availability =
    available
      [ ( out "cached"
        , cached
            ~references:[ out "lib"; out "local"; out "unknown" ]
            ~download_size:5L
            () )
      ; ( out "lib"
        , cached
            ~references:[ out "cached"; out "local" ]
            ~download_size:7L
            ~nar_size:20L
            () )
      ; out "local", Plan.Local
      ]
  in
  let plan =
    Plan.compute graph ~roots:[ edge "cached"; edge "cached" ] ~availability
  in
  check
    (plan.builds = [])
    "cached outputs should hide unavailable build prerequisites";
  check
    (List.length plan.downloads = 2)
    "download references should be unique and cycles finite";
  check
    (plan.local_outputs = [ out "local" ])
    "local download references should not be downloaded";
  check
    (plan.unknown = [ out "unknown" ])
    "unknown download references should remain explicit";
  let bytes =
    List.fold_left
      (fun total (d : Plan.download) ->
         Int64.add total (Option.value ~default:0L d.download_size))
      0L
      plan.downloads
  in
  check (bytes = 12L) "known download sizes should be preserved exactly"

let test_failure_ancestry () =
  let availability = available [ out "cached", cached () ] in
  let blocked =
    Plan.failed_ancestors
      (graph ())
      ~availability
      ~root:(edge "a")
      ~failed:[ drv "hidden"; drv "shared"; drv "shared" ]
  in
  check
    (blocked = [ drv "shared" ])
    "only required, uncached failed ancestors should block a root";
  let recovered =
    available [ out "shared", Plan.Local; out "cached", cached () ]
  in
  check
    (Plan.failed_ancestors
       (graph ())
       ~availability:recovered
       ~root:(edge "a")
       ~failed:[ drv "shared" ]
    = [])
    "a subsequently realised failed derivation must not remain blocked";
  check
    (Plan.failed_ancestors
       (graph ())
       ~availability
       ~root:(edge "independent")
       ~failed:[ drv "shared" ]
    = [])
    "independent roots must remain runnable"

let test_priority_and_aging () =
  let availability = available [ out "cached", cached () ] in
  let pending =
    [ edge "independent", 1000.; edge "a", 1000.; edge "b", 1000. ]
  in
  let rank ?(failed = []) ?(duration = fun _ -> Some 60.) pending =
    Plan.rank (graph ()) ~availability ~failed ~now:1000. ~duration ~pending
    |> ranked_names
  in
  check
    (rank pending = [ drv "a"; drv "b"; drv "independent" ])
    "shared prerequisites should raise priority";
  check
    (rank [ edge "independent", 0.; edge "a", 1000.; edge "b", 1000. ]
    = [ drv "independent"; drv "a"; drv "b" ])
    "queue age should prevent starvation by new shared work";
  check
    (rank ~failed:[ drv "shared" ] pending = [ drv "independent" ])
    "blocked roots should not occupy the ready queue";
  let duration path = Some (if path = drv "independent" then 4000. else 60.) in
  check
    (List.hd (rank ~duration pending) = drv "independent")
    "long critical paths should start early";
  check
    (rank ~duration:(fun _ -> Some nan) pending
    = [ drv "a"; drv "b"; drv "independent" ])
    "invalid historical durations should use the default"

let parsed json =
  match Plan.of_yojson (Yojson.Safe.from_string json) with
  | Ok graph -> graph
  | Error error -> failwith error

let test_json_formats () =
  let old =
    parsed
      {|{
    "/nix/store/root.drv": {
      "system":"x86_64-linux", "env":{"name":"root"},
      "outputs":{"out":{"path":"/nix/store/root"}},
      "inputDrvs":{"/nix/store/dep.drv":["out"]}
    },
    "/nix/store/dep.drv": {
      "system":"x86_64-linux", "env":{"name":"dep"},
      "outputs":{"out":{"path":"/nix/store/dep"}}, "inputDrvs":{}
    }
  }|}
  in
  let modern =
    parsed
      {|{
    "version":4, "derivations": {
      "root.drv": {
        "name":"root", "system":"x86_64-linux",
        "outputs":{"out":{"path":"root"}},
        "inputs":{"drvs":{"dep.drv":{"outputs":["out"],"dynamicOutputs":{}}}}
      },
      "dep.drv": {
        "name":"dep", "system":"x86_64-linux",
        "outputs":{"out":{"path":"dep"}}, "inputs":{"drvs":{}}
      }
    }
  }|}
  in
  check
    (Plan.nodes old = Plan.nodes modern)
    "old and version 4 derivation JSON should normalize identically";
  check
    (Plan.normalize_drv_path "root.drv^*" = drv "root")
    "drv selectors should normalize";
  let fixed =
    parsed
      {|{"version":4,"derivations":{"source.drv":{
    "name":"source","outputs":{"out":{"method":"nar","hash":"sha256-ignored"}},
    "env":{"out":"/nix/store/source"},"inputs":{"drvs":{}}
  }}}|}
  in
  check
    ((Option.get (Plan.find fixed (drv "source"))).outputs
    = [ "out", Some (out "source") ])
    "fixed-output paths should be recovered from env when available";
  let unresolved =
    parsed {|{"unknown.drv":{"outputs":{"out":{}},"inputDrvs":{}}}|}
  in
  let plan =
    Plan.compute unresolved ~roots:[ edge "unknown" ] ~availability:missing
  in
  check
    (plan.unknown = [ drv "unknown" ^ "^out" ])
    "unresolved output paths must be explicit";
  check
    (match Plan.of_yojson (`Assoc [ "root.drv", `Assoc [] ]) with
    | Error _ -> true
    | Ok _ -> false)
    "malformed graph JSON must fail";
  let dynamic =
    {|{"root.drv":{"outputs":{},"inputs":{"drvs":{"dep.drv":{"outputs":[],"dynamicOutputs":{"out":{"outputs":["out"]}}}}}}}|}
  in
  check
    (match Plan.of_yojson (Yojson.Safe.from_string dynamic) with
    | Error _ -> true
    | Ok _ -> false)
    "unsupported dynamic dependencies must not silently disappear"

let test_substitution_policy () =
  let policy fields =
    let json =
      `Assoc [ drv "root", `Assoc (("outputs", `Assoc []) :: fields) ]
    in
    match Plan.of_yojson json with
    | Error message -> failwith message
    | Ok graph -> (Option.get (Plan.find graph (drv "root"))).allow_substitutes
  in
  check (policy []) "substitution should default to enabled";
  check
    (policy [ "env", `Assoc [ "preferLocalBuild", `String "1" ] ])
    "preferring local builds must not disable substitution";
  List.iter
    (fun (value, expected) ->
       check
         (policy [ "env", `Assoc [ "allowSubstitutes", `String value ] ]
         = expected)
         "legacy substitution booleans must match Nix's string conversion")
    [ "", false; "1", true; "true", false ];
  List.iter
    (fun value ->
       check
         (policy
            [ "structuredAttrs", `Assoc [ "allowSubstitutes", `Bool value ] ]
         = value)
         "structured substitution booleans must be preserved";
       check
         (policy
            [ ( "env"
              , `Assoc
                  [ ( "__json"
                    , `String
                        (Yojson.Safe.to_string
                           (`Assoc [ "allowSubstitutes", `Bool value ])) )
                  ] )
            ]
         = value)
         "legacy __json structured attributes must be parsed")
    [ false; true ];
  check
    (policy
       [ "structuredAttrs", `Assoc []
       ; "env", `Assoc [ "allowSubstitutes", `String "" ]
       ])
    "structured attributes take precedence over legacy environment settings";
  let merged =
    Plan.merge
      (Plan.of_nodes [ node "root" ~allow_substitutes:false ])
      (Plan.of_nodes [ node "root" ])
  in
  check
    (not (Option.get (Plan.find merged (drv "root"))).allow_substitutes)
    "an incomplete evaluator node must not enable forbidden substitution";
  List.iter
    (fun fields ->
       check
         (match
            Plan.of_yojson
              (`Assoc [ drv "root", `Assoc (("outputs", `Assoc []) :: fields) ])
          with
         | Error _ -> true
         | Ok _ -> false)
         "malformed structured substitution policy must not default to enabled")
    [ [ "structuredAttrs", `Assoc [ "allowSubstitutes", `String "1" ] ]
    ; [ "env", `Assoc [ "__json", `String "{" ] ]
    ]

let test_non_substitutable_outputs () =
  let graph =
    Plan.of_nodes
      [ node "root" ~allow_substitutes:false ~inputs:[ edge "compiler" ]
      ; node "compiler"
      ; node "consumer" ~inputs:[ edge "root" ]
      ]
  in
  let remote = available [ out "root", cached () ] in
  let plan = Plan.compute graph ~roots:[ edge "root" ] ~availability:remote in
  check
    (build_names plan = [ "compiler"; "root" ] && plan.downloads = [])
    "a remote hit must not substitute a root that disables substitution";
  check
    (build_names
       (Plan.compute graph ~roots:[ edge "consumer" ] ~availability:remote)
    = [ "compiler"; "consumer"; "root" ])
    "non-substitutable dependencies must keep their build inputs reachable";
  check
    (Plan.explain
       graph
       ~availability:remote
       ~root:(edge "root")
       ~target:(drv "compiler")
    = Some [ drv "root"; drv "compiler" ])
    "explanations must include inputs behind a forbidden substitute";
  check
    (Plan.failed_ancestors
       graph
       ~availability:remote
       ~root:(edge "root")
       ~failed:[ drv "compiler" ]
    = [ drv "compiler" ])
    "a forbidden substitute cannot bypass a failed build input";
  let local = available [ out "root", Plan.Local ] in
  let plan = Plan.compute graph ~roots:[ edge "root" ] ~availability:local in
  check
    (plan.builds = []
    && plan.downloads = []
    && plan.local_outputs = [ out "root" ])
    "a valid local output satisfies a non-substitutable root";
  check
    (build_names
       (Plan.compute graph ~roots:[ edge "consumer" ] ~availability:local)
    = [ "consumer" ])
    "explicitly imported local boundary outputs must remain reusable"

let test_incomplete_and_cyclic_graph () =
  let graph = Plan.of_nodes [ node "root" ~inputs:[ edge "absent" ] ] in
  let plan = Plan.compute graph ~roots:[ edge "root" ] ~availability:missing in
  check (plan.unknown = [ drv "absent" ]) "missing graph nodes must be reported";
  let cycle =
    Plan.of_nodes
      [ node "a" ~inputs:[ edge "b" ]; node "b" ~inputs:[ edge "a" ] ]
  in
  check
    (build_names (Plan.compute cycle ~roots:[ edge "a" ] ~availability:missing)
    = [ "a"; "b" ])
    "graph traversal must terminate even for malformed cyclic graphs";
  check
    (Plan.rank
       cycle
       ~availability:missing
       ~failed:[]
       ~now:0.
       ~duration:(fun _ -> None)
       ~pending:[ edge "a", 0. ]
    <> [])
    "priority computation must terminate for malformed cyclic graphs"

let test_reused_ranking_plans () =
  let graph =
    Plan.of_nodes
      [ node
          "split"
          ~outputs:[ "out", Some (out "split"); "dev", Some (out "split-dev") ]
          ~inputs:[ edge "compiler" ]
      ; node "compiler"
      ; node "independent"
      ; node "incomplete" ~inputs:[ edge "absent" ]
      ]
  in
  let availability = available [ out "split", cached () ] in
  let pending =
    [ edge "split", 0.
    ; edge "split" ~outputs:[ "dev" ], 0.
    ; edge "independent", 0.
    ; edge "incomplete", 0.
    ]
  in
  let plans =
    List.map
      (fun (root, _) -> root, Plan.compute graph ~roots:[ root ] ~availability)
      pending
  in
  let calls = ref 0 in
  let plan_for_root root =
    incr calls;
    List.assoc root plans
  in
  let failed = [ drv "compiler"; drv "absent" ] in
  let ranked =
    Plan.rank
      ~plan_for_root
      graph
      ~availability:(fun _ -> failwith "cached ranking should not replan")
      ~failed
      ~now:0.
      ~duration:(fun _ -> None)
      ~pending
  in
  check
    (!calls = List.length pending)
    "ranking should request exactly one plan per pending root";
  check
    (ranked = [ edge "independent"; edge "split" ])
    "cached ranking must preserve output-sensitive failure and unknown \
     ancestors";
  check
    (ranked
    = Plan.rank
        graph
        ~availability
        ~failed
        ~now:0.
        ~duration:(fun _ -> None)
        ~pending)
    "reused and computed ranking plans must give identical priorities"

let test_snapshot_and_merge () =
  let graph = graph () in
  let previous = Plan.compute graph ~roots:[ edge "a" ] ~availability:missing in
  let current =
    Plan.compute
      graph
      ~roots:[ edge "a" ]
      ~availability:(available [ out "cached", cached () ])
  in
  (match Plan.diff ~previous:(Plan.to_yojson previous) ~current with
  | Error error -> failwith error
  | Ok diff ->
    check
      (diff.removed_builds = [ drv "cached"; drv "hidden" ])
      "snapshot diff should identify pruned build work";
    check
      (diff.added_downloads = [ out "cached" ])
      "snapshot diff should identify replacement downloads");
  check
    (match Plan.diff ~previous:(`Assoc []) ~current with
    | Error _ -> true
    | Ok _ -> false)
    "invalid history must not be treated as an empty plan";
  let parsed =
    Plan.of_nodes
      [ node "root" ~inputs:[ edge "dep" ] ~outputs:[ "out", None ]
      ; node "dep"
      ]
  in
  let evaluator = Plan.of_nodes [ node "root" ] in
  let merged = Plan.merge parsed evaluator in
  let root = Option.get (Plan.find merged (drv "root")) in
  check
    (root.inputs = [ edge "dep" ] && root.outputs = [ "out", Some (out "root") ])
    "merging evaluator outputs must preserve parsed dependency edges"

let () =
  test_shared_pruned_graph ();
  test_output_sensitivity ();
  test_download_closure ();
  test_failure_ancestry ();
  test_priority_and_aging ();
  test_json_formats ();
  test_substitution_policy ();
  test_non_substitutable_outputs ();
  test_incomplete_and_cyclic_graph ();
  test_reused_ranking_plans ();
  test_snapshot_and_merge ();
  print_endline "plan tests passed"
