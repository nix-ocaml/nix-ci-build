open Nix_ci_build

let check condition message = if not condition then failwith message

let group id needs : Shared_plan.group =
  { id
  ; needs
  ; system = "test-system"
  ; kind = `Package
  ; roots = []
  ; members = []
  ; consumers = [ id ]
  ; required_paths = []
  }

let test_readiness env =
  let clock = Eio.Stdenv.clock env in
  let released, release = Eio.Promise.create () in
  let active = ref 0
  and peak = ref 0 in
  let starts = ref []
  and finishes = ref [] in
  let result =
    Eio.Time.with_timeout_exn clock 2. (fun () ->
      Local_runner.dispatch
        ~workers:2
        ~groups:
          [ group "slow" []
          ; group "fast" []
          ; group "consumer" [ "fast" ]
          ; group "tail" [ "slow" ]
          ]
        ~on_state:(fun id -> function
           | Local_runner.Running -> starts := !starts @ [ id ]
           | Local_runner.Succeeded -> finishes := id :: !finishes
           | _ -> ())
        ~execute:(fun g ->
          incr active;
          peak := max !peak !active;
          (match g.id with
          | "slow" -> Eio.Promise.await released
          | "consumer" ->
            check
              (List.mem "fast" ~set:!finishes)
              "consumer ran before its producer completed";
            check
              (not (List.mem "slow" ~set:!finishes))
              "consumer waited for an unrelated producer";
            Eio.Promise.resolve release ()
          | "tail" ->
            check
              (List.mem "slow" ~set:!finishes)
              "tail ran before its producer"
          | _ -> ());
          decr active;
          Ok ()))
  in
  check (!peak = 2) "ready groups did not run concurrently";
  check (!active = 0) "worker leaked after completion";
  check
    (List.for_all result ~f:(fun (_, state) -> state = Local_runner.Succeeded))
    "ready graph failed";
  check
    (!starts = [ "slow"; "fast"; "consumer"; "tail" ])
    "unexpected dependency dispatch order"

let test_failure () =
  let executed = ref [] in
  let states =
    Local_runner.dispatch
      ~workers:2
      ~groups:
        [ group "producer" []
        ; group "blocked" [ "producer" ]
        ; group "descendant" [ "blocked" ]
        ; group "independent" []
        ]
      ~on_state:(fun _ _ -> ())
      ~execute:(fun g ->
        executed := g.id :: !executed;
        if g.id = "producer" then Error "upload failed" else Ok ())
  in
  check
    (List.assoc "producer" states = Local_runner.Failed "upload failed")
    "producer failure was lost";
  check
    (List.assoc "blocked" states = Local_runner.Blocked [ "producer" ])
    "dependent was not blocked";
  check
    (List.assoc "descendant" states = Local_runner.Blocked [ "blocked" ])
    "transitive dependent was not blocked";
  check
    (List.assoc "independent" states = Local_runner.Succeeded)
    "independent work did not finish";
  check
    (List.sort ~cmp:String.compare !executed = [ "independent"; "producer" ])
    "blocked work executed"

let test_invalid () =
  List.iter
    [ [ group "a" [ "b" ]; group "b" [ "a" ] ]
    ; [ group "a" [ "missing" ] ]
    ; [ group "a" []; group "a" [] ]
    ]
    ~f:(fun groups ->
      let started = ref false in
      let failed =
        try
          ignore
            (Local_runner.dispatch
               ~workers:1
               ~groups
               ~on_state:(fun _ _ -> ())
               ~execute:(fun _ ->
                 started := true;
                 Ok ()));
          false
        with
        | Failure _ -> true
      in
      check failed "invalid dependency plan accepted";
      check (not !started) "invalid plan started a worker")

let test_cancellation env =
  let active = ref 0 in
  let never, _ = Eio.Promise.create () in
  let cancelled =
    try
      Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 0.05 (fun () ->
        ignore
          (Local_runner.dispatch
             ~workers:2
             ~groups:[ group "one" []; group "two" [] ]
             ~on_state:(fun _ _ -> ())
             ~execute:(fun _ ->
               incr active;
               Fun.protect
                 ~finally:(fun () -> decr active)
                 (fun () ->
                    Eio.Promise.await never;
                    Ok ()))));
      false
    with
    | Eio.Time.Timeout -> true
  in
  check cancelled "scheduler did not propagate cancellation";
  check (!active = 0) "scheduler returned before cancelled workers stopped"

let () =
  Eio_main.run (fun env ->
    test_readiness env;
    test_failure ();
    test_invalid ();
    test_cancellation env;
    check
      (Local_runner.dispatch
         ~workers:1
         ~groups:[]
         ~execute:(fun _ -> assert false)
         ~on_state:(fun _ _ -> assert false)
      = [])
      "empty plan did work");
  print_endline
    "local_runner: readiness, capacity, failure propagation, validation and \
     empty plans passed"
