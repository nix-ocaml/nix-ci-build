open Nix_ci_build

let check condition message = if not condition then failwith message

let contains value part =
  let rec loop offset =
    offset + String.length part <= String.length value
    && (String.sub value offset (String.length part) = part || loop (offset + 1))
  in
  loop 0

let read path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> really_input_string channel (in_channel_length channel))

let () =
  let payload = "</script><script>alert('oops')</script>&__REPORT_STYLE__" in
  let snapshot =
    `Assoc [ "status", `String "cancelled"; "name", `String payload ]
  in
  let html = Html_report.render ~snapshot ~events:[] ~warnings:[] in
  check
    (not (contains html payload))
    "JSON must not break out of its script element";
  check
    (contains html "\\u003c/script\\u003e")
    "script syntax must be JSON-escaped";
  check
    (contains html "__REPORT_STYLE__")
    "data must not undergo template replacement";
  check
    (not (contains html "__REPORT_SCRIPT__"))
    "application script must be embedded";
  let directory = Filename.temp_file "nix-ci-build-html-test-" "" in
  Sys.remove directory;
  Unix.mkdir directory 0o700;
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Sys.remove (Filename.concat directory name))
        (Sys.readdir directory);
      Unix.rmdir directory)
    (fun () ->
       Yojson.Safe.to_file (Filename.concat directory "results.json") snapshot;
       Html_report.regenerate ~directory;
       let output = Filename.concat directory "report.html" in
       check
         (contains (read output) "No event stream was recorded")
         "old snapshots must remain usable";
       let channel = open_out (Filename.concat directory "events.jsonl") in
       output_string channel "{\"time\":1,\"type\":\"job\"}\n{\"partial\":";
       close_out channel;
       Html_report.regenerate ~directory;
       let html = read output in
       check
         (contains html "1 incomplete or invalid event records")
         "interrupted event streams must explain gaps";
       check
         (contains html "\"time\":1")
         "complete events before interruption must survive";
       check
         (Array.length (Sys.readdir directory) = 3)
         "atomic temporary output must be cleaned up");
  print_endline "HTML report tests passed"
