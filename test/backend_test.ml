open Nix_ci_build

exception Output_failed
exception Output_failed_again
exception Stop_fixture

let check condition message = if not condition then failwith message

let child_script =
  {|import os, pathlib, signal, sys, time
mode, marker = sys.argv[1:]
stopping = False
def terminate(signum, frame):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, signal.SIG_IGN if mode == "ignore" else terminate)
print(os.getpid(), flush=True)
if mode == "closed":
    os.close(1)
    os.close(2)
    pathlib.Path(marker + ".ready").write_text("ready")
if mode == "natural":
    pathlib.Path(marker).write_text("finished")
    sys.exit(0)
# A broken cleanup must not leave this fixture running indefinitely.
deadline = time.monotonic() + 3
while not stopping and time.monotonic() < deadline:
    time.sleep(0.005)
if stopping:
    if mode != "closed":
        print("terminating", flush=True)
    time.sleep(0.1)
    pathlib.Path(marker).write_text("finished")
    sys.exit(0)
sys.exit(3)
|}

let test env python mode =
  let check condition message = check condition (mode ^ ": " ^ message) in
  let marker = Filename.temp_file "nix-ci-backend-" ".finished" in
  Sys.remove marker;
  let clock = Eio.Stdenv.mono_clock env in
  let pid = ref None
  and callback_calls = ref 0 in
  let started, notify_started = Eio.Promise.create () in
  let wait_until_ready () =
    Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds clock 1.) (fun () ->
      while not (Sys.file_exists (marker ^ ".ready")) do
        Eio.Time.Mono.sleep clock 0.001
      done)
  in
  let on_stdout line =
    incr callback_calls;
    match !pid with
    | None ->
      pid := Some (int_of_string line);
      Eio.Promise.resolve notify_started ();
      if mode = "closed" then wait_until_ready ();
      if mode <> "cancel" && mode <> "natural" then raise Output_failed
    | Some _ -> raise Output_failed_again
  in
  let command () =
    Backend.run
      (Eio.Stdenv.process_mgr env)
      ~cancel_grace:(clock, if mode = "ignore" then 0.25 else 1.)
      ~on_stdout
      [ python; "-u"; "-c"; child_script; mode; marker ]
  in
  let ensure_reaped () =
    match !pid with
    | None -> failwith "Child did not report its PID"
    | Some child ->
      (match Unix.waitpid [ Unix.WNOHANG ] child with
      | 0, _ ->
        Unix.kill child Sys.sigkill;
        ignore (Unix.waitpid [] child);
        failwith "Backend returned while its child was still alive"
      | _ -> failwith "Backend did not reap its child"
      | exception Unix.Unix_error (Unix.ECHILD, _, _) -> ())
  in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun path -> if Sys.file_exists path then Sys.remove path)
        [ marker; marker ^ ".ready" ])
    (fun () ->
       let before = Eio.Time.Mono.now clock in
       let outcome =
         match
           if mode = "cancel"
           then
             Eio.Cancel.sub (fun caller ->
               Eio.Fiber.both
                 (fun () ->
                    Eio.Promise.await started;
                    Eio.Cancel.cancel caller Stop_fixture;
                    Eio.Cancel.cancel caller Stop_fixture)
                 (fun () -> ignore (command ()));
               None)
           else Some (command ())
         with
         | result -> Ok result
         | exception exn -> Error exn
       in
       let seconds =
         Mtime.Span.to_float_ns (Mtime.span before (Eio.Time.Mono.now clock))
         /. 1e9
       in
       ensure_reaped ();
       (match mode, outcome with
       | "natural", Ok (Some result) ->
         check (Backend.successful result) "Natural exit should succeed"
       | "cancel", Error (Eio.Cancel.Cancelled Stop_fixture) -> ()
       | ("callback" | "closed" | "ignore"), Error Output_failed -> ()
       | _, Error exn -> raise exn
       | _ -> failwith "Unexpected Backend outcome");
       check (!callback_calls = 1) "Cleanup invoked the output callback again";
       check (seconds < 2.) "Child cleanup exceeded its bounded grace period";
       if mode = "ignore"
       then (
         check
           (seconds >= 0.2)
           "TERM-ignoring child was killed before its grace";
         check (not (Sys.file_exists marker)) "TERM-ignoring child completed")
       else
         check (Sys.file_exists marker) "Child did not finish graceful cleanup")

let () =
  let python = Sys.argv.(1) in
  Eio_main.run (fun env ->
    List.iter
      (test env python)
      [ "callback"; "closed"; "ignore"; "cancel"; "natural" ]);
  print_endline
    "backend: graceful cancellation, consumer failures, exit and escalation \
     passed"
