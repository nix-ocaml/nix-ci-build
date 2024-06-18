open Eio.Std
module Logs = (val Nix_ci_build.Logging.setup __FILE__)
module Stream = Nix_ci_build.Stream
module Job = Nix_ci_build.Job
module StringSet = Set.Make (String)

(* TODO: it'd be really cool if we knew how to avoid building a derivation if
   one of its dependents is a failed job *)
type t =
  { config : Nix_ci_build.Config.t
  ; mutable seen_drv_paths : StringSet.t
  ; builds : Job.t Stream.t * (Job.t option -> unit)
  ; uploads : Job.t Stream.t * (Job.t option -> unit)
  ; mutable all_jobs : int
  ; mutable cached_jobs : int
  ; mutable successful_jobs : int
  ; mutable failed_jobs : (Job.t * string) list
  }

let make config =
  { config
  ; seen_drv_paths = StringSet.empty
  ; builds = Stream.create 128
  ; uploads = Stream.create 128
  ; all_jobs = 0
  ; cached_jobs = 0
  ; successful_jobs = 0
  ; failed_jobs = []
  }

let eval_fiber ~sw t (jobs, finished_p) () =
  let push_to_builds = snd t.builds in
  Stream.iter_p
    ~sw
    ~f:(fun job ->
      let job : Job.t = job |> Yojson.Safe.from_string |> Job.t_of_yojson in
      push_to_builds (Some job))
    jobs;
  match Promise.await_exn finished_p with
  | () -> push_to_builds None
  | exception (Eio.Exn.Io _ as ex) ->
    let bt = Printexc.get_raw_backtrace () in
    Eio.Exn.reraise_with_context ex bt "Evaluating jobs"

let build_fiber t ~domain_mgr ~process_mgr () =
  Switch.run (fun sw ->
    let build_stream, _ = t.builds in
    let pool =
      Eio.Executor_pool.create ~sw ~domain_count:t.config.max_jobs domain_mgr
    in
    let seen_mutex = Mutex.create () in
    Stream.iter_p ~sw build_stream ~f:(fun (job : Job.t) ->
      let drv_path = job.drvPath in
      let seen, cached =
        Mutex.protect seen_mutex (fun () ->
          let seen = StringSet.mem drv_path t.seen_drv_paths in
          if not seen then t.all_jobs <- t.all_jobs + 1;
          let cached =
            match job.cacheStatus with
            | "local" | "cached" ->
              t.cached_jobs <- t.cached_jobs + 1;
              true
            | "notBuild" ->
              t.seen_drv_paths <- StringSet.add drv_path t.seen_drv_paths;
              false
            | _ -> assert false
          in
          seen, cached)
      in
      if not seen
      then
        if cached
        then Logs.info (fun m -> m "skipping %s (cached)" job.attr)
        else
          let task () =
            Logs.info (fun m -> m "building %s" job.attr);
            Nix_ci_build.nix_build process_mgr job
          in
          match
            Eio.Executor_pool.submit_exn
              pool (* 2 jobs per core *)
              ~weight:0.5
              task
          with
          | Ok () ->
            Mutex.protect seen_mutex (fun () ->
              t.successful_jobs <- t.successful_jobs + 1);
            let push_to_uploads = snd t.uploads in
            push_to_uploads (Some job);
            Logs.info (fun m -> m "%s built successfully" job.attr)
          | Error (_, build_logs) ->
            (* TODO: capture stderr and add it to the build summary too. *)
            Mutex.protect seen_mutex (fun () ->
              t.failed_jobs <- (job, build_logs) :: t.failed_jobs)));
  let push_to_uploads = snd t.uploads in
  push_to_uploads None

let upload_fiber t ~process_mgr () =
  match t.config.copy_to with
  | None ->
    let push_to_uploads = snd t.uploads in
    push_to_uploads None
  | Some copy_to ->
    let upload_stream, _ = t.uploads in
    Switch.run (fun _sw ->
      Stream.iter upload_stream ~f:(fun (job : Job.t) ->
        match Nix_ci_build.nix_copy process_mgr ~copy_to job with
        | Ok () -> ()
        | Error _ -> ()));
    let push_to_uploads = snd t.uploads in
    push_to_uploads None

let dump_build_summary (stdenv : Eio_unix.Stdenv.base) ~sw t =
  let sink =
    (* TODO: take this filename as a CLI argument *)
    match Sys.getenv "GITHUB_STEP_SUMMARY" with
    | filename ->
      let path =
        if Filename.is_relative filename
        then
          let cwd = Eio.Stdenv.cwd stdenv in
          Eio.Path.(cwd / filename)
        else
          let fs = Eio.Stdenv.fs stdenv in
          Eio.Path.(fs / filename)
      in
      let p =
        Eio.Path.open_out ~sw ~append:true ~create:(`If_missing 0o700) path
      in
      (p :> [ `Close | `Flow | `W ] r)
    | exception Not_found ->
      let stdout = Eio.Stdenv.stdout stdenv in
      (stdout :> [ `Close | `Flow | `W ] r)
  in

  let header =
    let n_failed_jobs = List.length t.failed_jobs in
    Format.sprintf
      {|## Overview

Total Jobs: %d
Successful builds: %d (of which %d were cached)
Failed builds: %d

## Failed Build Details
    |}
      t.all_jobs
      (t.successful_jobs + t.cached_jobs)
      t.cached_jobs
      n_failed_jobs
  in
  Eio.Flow.copy_string header sink;
  List.iter t.failed_jobs ~f:(fun ((job : Job.t), build_logs) ->
    let detail =
      Format.sprintf
        {|
### ❌ %s

<details>
  <summary>Build error:</summary>
  last 50 lines:
  <pre>%s</pre>
</details>
|}
        job.attr
        build_logs
    in
    Eio.Flow.copy_string detail sink)

let main config stdenv =
  Switch.run (fun sw ->
    let process_mgr = Eio.Stdenv.process_mgr stdenv
    and domain_mgr = Eio.Stdenv.domain_mgr stdenv in
    let t = make config in
    let jobs = Nix_ci_build.nix_eval_jobs process_mgr ~sw config in
    let eval_fiber = eval_fiber ~sw t jobs
    and build_fiber = build_fiber t ~domain_mgr ~process_mgr
    and upload_fiber = upload_fiber t ~process_mgr in
    Fiber.all [ eval_fiber; build_fiber; upload_fiber ];
    dump_build_summary stdenv ~sw t;
    match t.failed_jobs with
    | [] -> `Ok ()
    | _ :: _ ->
      `Error
        ( false
        , "Some jobs weren't successful. Consult the build summary for more \
           details." ))

let main config = Eio_main.run (main config)

module CLI = struct
  module Config = Nix_ci_build.Config
  open Cmdliner

  let output =
    let output_conv =
      let parse s =
        let output = Config.Filename s in
        Ok output
      in
      let print formatter output =
        let s =
          match output with Config.Stdout -> "<stdout>" | Filename f -> f
        in
        Format.fprintf formatter "%s" s
      in
      Arg.conv ~docv:"output" (parse, print)
    in
    let doc = "Write build summary to file instead of stdout" in
    let docv = "file" in
    Arg.(value & opt output_conv Stdout & info [ "o"; "output" ] ~doc ~docv)

  (* `../nix-overlays#hydraJobs.aarch64-darwin.build_x` *)
  let flake =
    let doc = "Flake url to evaluate/build" in
    let docv = "flake-url" in
    Arg.(value & opt (some string) None & info [ "f"; "flake" ] ~doc ~docv)

  let max_jobs =
    let doc = "Max number of eval workers / build jobs" in
    let docv = "jobs" in
    Arg.(
      value
      & opt int (Domain.recommended_domain_count ())
      & info [ "j"; "jobs" ] ~doc ~docv)

  let copy_to =
    let doc = "Copy build results to the given URL" in
    let docv = "URL" in
    Arg.(value & opt (some string) None & info [ "copy-to" ] ~doc ~docv)

  let parse flake max_jobs copy_to build_summary_output =
    let flake = Option.get flake in
    { Nix_ci_build.Config.flake
    ; skip_cached = true
    ; max_jobs
    ; copy_to
    ; build_summary_output
    }

  let t =
    let open Cmdliner in
    let doc = "nix-ci-build TODO" in
    let info = Cmd.info "nix-ci-build" ~doc in
    Cmd.v
      info
      Term.(
        ret (const main $ (const parse $ flake $ max_jobs $ copy_to $ output)))
end

let () =
  Random.self_init ();
  (* TODO: make logging a CLI flag too. *)
  Nix_ci_build.Logging.setup_logging Info;
  let open Cmdliner in
  exit (Cmd.eval CLI.t)
