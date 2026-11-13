(* GitHub's runner labels and matrix limits are an adapter for a portable
   plan. *)
let matrix ~runners groups =
  if List.length groups > 256
  then failwith "A GitHub stage exceeds the 256-job matrix limit";
  `Assoc
    [ ( "include"
      , `List
          (List.map groups ~f:(fun (group : Shared_plan.group) ->
             let runner =
               match List.assoc_opt group.system runners with
               | Some runner -> runner
               | None ->
                 failwith
                   ("No GitHub runner configured for build system "
                   ^ group.system)
             in
             `Assoc
               [ "group", `String group.id
               ; "system", `String group.system
               ; "runner", runner
               ; "consumers", Json.strs group.consumers
               ])) )
    ]
