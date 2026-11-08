module Activity = Nix_ci_build.Activity

let check condition message = if not condition then failwith message

let test_records () =
  let line =
    {|@nix {"action":"start","id":18446744073709551615,"parent":9223372036854775808,"type":105,"fields":["/nix/store/example.drv","",1,1],"text":"building example","future":true}|}
  in
  (match Activity.parse line with
  | Activity.Start { id; parent; kind; fields; text } ->
    check
      (id = "18446744073709551615" && parent = "9223372036854775808")
      "uint64 IDs must not overflow";
    check
      (kind = 105 && List.length fields = 4 && text = "building example")
      "build activity fields must survive decoding"
  | _ -> failwith "expected start activity");
  check
    (Activity.parse {|@nix {"action":"stop","id":18446744073709551615}|}
    = Activity.Stop "18446744073709551615")
    "stop IDs must preserve uint64 precision";
  check
    (Activity.parse
       {|@nix {"action":"result","id":42,"type":104,"fields":["checkPhase"]}|}
    = Activity.Result
        { id = "42"; kind = 104; fields = [ `String "checkPhase" ] })
    "phase results must decode";
  check
    (Activity.parse
       {|@nix {"action":"msg","level":0,"msg":"error: build failed","raw_msg":"build failed"}|}
    = Activity.Message { level = 0; message = "error: build failed" })
    "messages should preserve rendered diagnostics";
  check
    (Activity.parse {|@nix {"action":"start","id":1,"type":111}|}
    = Activity.Start
        { id = "1"; parent = "0"; kind = 111; fields = []; text = "" })
    "optional activity metadata should tolerate omission"

let test_fallback () =
  List.iter
    (fun line ->
       check
         (Activity.parse line = Activity.Raw line)
         ("record must be preserved: " ^ line))
    [ "ordinary output"
    ; "@nix not-json"
    ; "@nix []"
    ; {|@nix {"action":"future","id":1}|}
    ; {|@nix {"action":"stop","id":-1}|}
    ; {|@nix {"action":"stop","id":1.2}|}
    ; {|@nix {"action":"start","id":1,"type":"build"}|}
    ; {|@nix {"action":"result","id":1,"type":104,"fields":{}}|}
    ; {|@nix {"action":"msg","level":0}|}
    ]

let test_builder_failures () =
  let old =
    "error: builder for '/nix/store/old.drv' failed with exit code 1;\n\
     error: 1 dependencies of derivation '/nix/store/dependent.drv' failed to \
     build\n"
  in
  check
    (Activity.failed_derivations old = [ "/nix/store/old.drv" ])
    "old format must exclude dependency cascades";
  let current =
    "error: Cannot build '/nix/store/root.drv'.\n\
    \       Reason: builder failed with exit code 2.\n\
    \       Output paths:\n\
    \         /nix/store/root\n\
     error: Cannot build '/nix/store/dependent.drv'.\n\
    \       Reason: 1 dependency failed.\n"
  in
  check
    (Activity.failed_derivations current = [ "/nix/store/root.drv" ])
    "multiline format must attribute only explicit builder failure";
  let fake =
    "some-package> error: builder for '/nix/store/pretend.drv' failed\n\
    \       > error: Cannot build '/nix/store/pretend.drv'.\n\
    \       > Reason: builder failed with exit code 1.\n"
  in
  check
    (Activity.failed_derivations fake = [])
    "prefixed builder log excerpts must not be classified as Nix failures";
  check
    (Activity.failed_derivations
       "Cannot build '/nix/store/unknown.drv'.\n\
        Last 25 log lines:\n\
        Reason: builder failed with exit code 1."
    = [])
    "a later unrelated reason must not attach to an old header";
  check
    (Activity.failed_derivations
       "error: Cannot build '/nix/store/download.drv'.\n\
        Reason: download failed: HTTP 504"
    = [])
    "download infrastructure failures are not explicit builder failures";
  let colored =
    "\027[31;1merror:\027[0m builder for \
     '\027[1m/nix/store/colored.drv\027[0m' failed with exit code 1;"
  in
  check
    (Activity.failed_derivations colored = [ "/nix/store/colored.drv" ])
    "ANSI color codes should not obscure failure paths";
  check
    (Activity.strip_ansi "a\027]8;;https://example.com\007link\027]8;;\027\\b"
    = "alinkb")
    "OSC hyperlink escapes should be removed"

let () =
  test_records ();
  test_fallback ();
  test_builder_failures ();
  print_endline "activity tests passed"
