module Logging = Logging
module Stream = Stream
module Logs = (val Logging.setup __FILE__)

let parse_out t ~sw args =
  let r, w = Eio.Process.pipe t ~sw in
  try
    let child = Eio.Process.spawn ~sw t ~stdout:w args in
    Eio.Flow.close w;
    let stream =
      let buf = Eio.Buf_read.of_flow r ~initial_size:256 ~max_size:max_int in
      Stream.from ~f:(fun () ->
        match Eio.Buf_read.line buf with
        | line -> Some line
        | exception End_of_file ->
          Eio.Flow.close r;
          None)
    in
    let finished_p =
      Eio.Fiber.fork_promise ~sw (fun () -> Eio.Process.await_exn child)
    in
    (* TODO: return a record here. *)
    stream, finished_p
  with
  | Eio.Exn.Io _ as ex ->
    let bt = Printexc.get_raw_backtrace () in
    Eio.Exn.reraise_with_context
      ex
      bt
      "running command: %a"
      Eio.Process.pp_args
      args

let create_temp_dir () =
  let rand_num = Random.int 1000000 in
  let pattern = "nix-ci-build" in
  let tmp_dir =
    Format.sprintf
      "%s%s%s-%d"
      (Filename.get_temp_dir_name ())
      Filename.dir_sep
      pattern
      rand_num
  in
  try
    Unix.mkdir tmp_dir 0o700;
    tmp_dir
  with
  | _ -> raise (Sys_error "Cannot create temp dir")

module Config = struct
  type output =
    | Stdout
    | Filename of string

  type t =
    { flake : string
    ; max_jobs : int
    ; skip_cached : bool
    ; build_summary_output : output
    ; copy_to : string option
    }
end

let nix_eval_jobs proc_mgr ~sw { Config.flake; skip_cached; max_jobs; _ } =
  let gc_root_dir = create_temp_dir () in
  let args =
    let base =
      [ "nix-eval-jobs"
      ; "--gc-roots-dir"
      ; gc_root_dir
      ; "--force-recurse"
      ; "--check-cache-status"
      ; "--workers"
      ; string_of_int max_jobs
      ; (* "--max-memory-size"; *)
        (* str(opts.eval_max_memory_size); *)
        "--flake"
      ; flake
      ]
    in
    if skip_cached then base @ [ "--check-cache-status" ] else base
  in
  Logs.debug (fun m -> m "run `%s`" (String.concat ~sep:" " args));
  (* TODO: suppress stderr for evaluation if successful. *)
  parse_out ~sw proc_mgr args

module Job = struct
  module StringMap = struct
    include Map.Make (String)

    let find_opt k t =
      match find k t with v -> Some v | exception Not_found -> None

    let yojson_of_t a_to_yojson t =
      let items =
        List.map ~f:(fun (key, v) -> key, a_to_yojson v) (bindings t)
      in
      `Assoc items

    let t_of_yojson a_of_yojson = function
      | `Assoc items ->
        let rec f map = function
          | [] -> map
          | (name, json) :: xs -> f (add name (a_of_yojson json) map) xs
        in
        f empty items
      | `Null -> empty
      | _ -> failwith "expected an object"
  end

  open Ppx_yojson_conv_lib.Yojson_conv

  type t =
    { attr : string
    ; attrPath : string list
    ; drvPath : string
    ; inputDrvs : string list StringMap.t
    ; cacheStatus : string
    ; name : string
    ; outputs : string StringMap.t
    ; system : string
    }
  [@@deriving yojson] [@@yojson.allow_extra_fields]
end

let nix_build proc_mgr (job : Job.t) =
  let args =
    [ "nix-build"; job.drvPath; "--keep-going"; "--no-link"; "--quiet" ]
  in
  let build_logs_buf = Buffer.create 1024 in
  let logs_sink = Eio.Flow.buffer_sink build_logs_buf in
  Logs.debug (fun m -> m "run `%s`" (String.concat ~sep:" " args));
  match Eio.Process.run proc_mgr ~stdout:logs_sink ~stderr:logs_sink args with
  | () -> Ok ()
  | exception (Eio.Exn.Io _ as exn) ->
    (* Whenever a build fails, also print its build logs on stderr - this allows
       us to go and fix builds without having to wait for the job to finish. *)
    let build_logs = Buffer.contents build_logs_buf in
    Printf.fprintf stderr "%s" build_logs;
    flush stderr;
    Error (exn, build_logs)

let nix_copy proc_mgr ~copy_to (job : Job.t) =
  let args =
    let urls = Job.StringMap.to_list job.outputs |> List.map ~f:snd in
    [ "nix"
    ; "--experimental-features"
    ; "nix-command flakes"
    ; "copy"
    ; "--log-format"
    ; "raw"
    ; "--to"
    ; copy_to
    ]
    @ urls
  in
  Logs.debug (fun m -> m "run `%s`" (String.concat ~sep:" " args));
  match Eio.Process.run proc_mgr args with
  | () -> Ok ()
  | exception (Eio.Exn.Io _ as exn) -> Error exn
