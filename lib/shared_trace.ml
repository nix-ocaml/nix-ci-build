(* One provider-neutral event stream covers orchestration around the engine. An
   attempt without a terminal event is interrupted, never successful. *)
let rec canonical = function
  | `Assoc fields ->
    `Assoc
      (List.map fields ~f:(fun (key, value) -> key, canonical value)
      |> List.sort ~cmp:(fun (a, _) (b, _) -> String.compare a b))
  | `List values -> `List (List.map values ~f:canonical)
  | value -> value

let plan_id manifest =
  "plan-"
  ^ Digest.to_hex (Digest.string (Yojson.Safe.to_string (canonical manifest)))

let fresh_id prefix =
  let file = Filename.temp_file (prefix ^ "-") ".id" in
  Unix.unlink file;
  prefix
  ^ "-"
  ^ Digest.to_hex
      (Digest.string
         (Printf.sprintf
            "%s:%d:%.9f"
            file
            (Unix.getpid ())
            (Unix.gettimeofday ())))

let nonempty = function
  | Some value when String.trim value <> "" -> Some value
  | _ -> None

let choose explicit variable fallback =
  match nonempty explicit with
  | Some value -> value
  | None ->
    (match nonempty (Sys.getenv_opt variable) with
    | Some value -> value
    | None -> fallback ())

let default_run_id () =
  match nonempty (Sys.getenv_opt "GITHUB_RUN_ID") with
  | Some run ->
    String.concat
      ~sep:":"
      [ "github"
      ; Option.value (Sys.getenv_opt "GITHUB_REPOSITORY") ~default:""
      ; run
      ; Option.value (Sys.getenv_opt "GITHUB_RUN_ATTEMPT") ~default:"1"
      ]
  | None -> fresh_id "run"

type t =
  { channel : out_channel
  ; identity : (string * Yojson.Safe.t) list
  ; started_at : float
  ; elapsed : unit -> float
  ; mutable sequence : int
  ; mutable finished_at : float option
  }

exception Cancelled

let with_signals env f =
  let interrupted = ref false in
  let handler = Sys.Signal_handle (fun _ -> interrupted := true) in
  let previous_int = Sys.signal Sys.sigint handler
  and previous_term = Sys.signal Sys.sigterm handler in
  Fun.protect
    ~finally:(fun () ->
      Sys.set_signal Sys.sigint previous_int;
      Sys.set_signal Sys.sigterm previous_term)
    (fun () ->
       Eio.Fiber.first f (fun () ->
         let rec loop () =
           if !interrupted then raise Cancelled;
           Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 0.05;
           loop ()
         in
         loop ()))

let identity t = t.identity

let context t =
  t.identity
  @ [ "startedAt", `Float t.started_at ]
  @
  match t.finished_at with
  | None -> []
  | Some time -> [ "finishedAt", `Float time ]

let emit t kind fields =
  t.sequence <- t.sequence + 1;
  let event =
    `Assoc
      ([ "version", `Int 1
       ; "sequence", `Int t.sequence
       ; "time", `Float (Unix.gettimeofday ())
       ; "elapsed", `Float (t.elapsed ())
       ; "type", `String kind
       ]
      @ t.identity
      @ fields)
  in
  Yojson.Safe.to_channel t.channel event;
  output_char t.channel '\n';
  flush t.channel

let create ~directory ~manifest ~group_id ?run_id ?attempt_id ?worker_id env =
  Json.mkdir directory;
  let run_id = choose run_id "NIX_CI_BUILD_RUN_ID" default_run_id in
  let attempt_id =
    choose attempt_id "NIX_CI_BUILD_ATTEMPT_ID" (fun () -> fresh_id "attempt")
  in
  let worker_id =
    choose worker_id "NIX_CI_BUILD_WORKER_ID" (fun () -> Unix.gethostname ())
  in
  let clock = Eio.Stdenv.mono_clock env in
  let started = Eio.Time.Mono.now clock in
  let elapsed () =
    Mtime.Span.to_float_ns (Mtime.span started (Eio.Time.Mono.now clock))
    *. 1e-9
  in
  let t =
    { channel =
        open_out_gen
          [ Open_wronly; Open_creat; Open_append; Open_binary ]
          0o600
          (Filename.concat directory "execution-events.jsonl")
    ; identity =
        [ "planId", `String (plan_id manifest)
        ; "runId", `String run_id
        ; "groupId", `String group_id
        ; "attemptId", `String attempt_id
        ; "workerId", `String worker_id
        ]
    ; started_at = Unix.gettimeofday ()
    ; elapsed
    ; sequence = 0
    ; finished_at = None
    }
  in
  emit t "attempt_start" [];
  t

let finish t ~status fields =
  if t.finished_at = None
  then (
    t.finished_at <- Some (Unix.gettimeofday ());
    emit
      t
      "attempt_finish"
      ([ "status", `String status; "durationSeconds", `Float (t.elapsed ()) ]
      @ fields))

let exception_status = function
  | Eio.Cancel.Cancelled _ | Cancelled -> "cancelled"
  | _ -> "failed"

let phase t name f =
  let started = t.elapsed () in
  emit t "phase_start" [ "phase", `String name ];
  let finish status fields =
    emit
      t
      "phase_finish"
      ([ "phase", `String name
       ; "status", `String status
       ; "durationSeconds", `Float (max 0. (t.elapsed () -. started))
       ]
      @ fields)
  in
  match f () with
  | value, status, fields ->
    finish status fields;
    value
  | exception exn ->
    finish (exception_status exn) [ "error", `String (Printexc.to_string exn) ];
    raise exn

let close t = close_out_noerr t.channel
