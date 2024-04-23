module Logging = Logging
module Stream = Stream
module Logs = (val Logging.setup __FILE__)

(* TODO:
 * - add uploading with `nix copy`
 * -
 *)

let parse_out t ~sw ?cwd ?stdin ?stderr ?is_success ?env ?executable args =
  let r, w = Eio.Process.pipe t ~sw in
  try
    let child =
      Eio.Process.spawn
        ~sw
        t
        ?cwd
        ?stdin
        ~stdout:w
        ?stderr
        ?env
        ?executable
        args
    in
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
      Eio.Fiber.fork_promise ~sw (fun () ->
        Eio.Process.await_exn ?is_success child)
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
  Format.eprintf "%d@." rand_num;
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
  Logs.info (fun m -> m "run `%s`" (String.concat ~sep:" " args));
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
    ; isCached : bool
    ; name : string
    ; outputs : string StringMap.t
    ; system : string
    }
  [@@deriving yojson] [@@yojson.allow_extra_fields]
end

let nix_build proc_mgr (job : Job.t) =
  let args =
    [ "nix-build"
    ; job.drvPath
    ; "--keep-going"
    ; "--no-link"
    ; "--no-build-output"
    ; "--quiet"
    ]
  in
  Logs.info (fun m -> m "run `%s`" (String.concat ~sep:" " args));
  (* let null = Eio.Path.(open_out ~sw ~create:`Never (fs / Filename.null))
     in *)
  match Eio.Process.run proc_mgr args with
  | () -> Ok ()
  | exception (Eio.Exn.Io _ as exn) -> Error exn
