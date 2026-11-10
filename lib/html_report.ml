let replace_once value marker replacement =
  let length = String.length value
  and size = String.length marker in
  let rec find offset =
    if offset + size > length
    then invalid_arg ("Missing report marker: " ^ marker)
    else if String.sub value ~pos:offset ~len:size = marker
    then offset
    else find (offset + 1)
  in
  let offset = find 0 in
  String.sub value ~pos:0 ~len:offset
  ^ replacement
  ^ String.sub value ~pos:(offset + size) ~len:(length - offset - size)

let script_data json =
  let output = Buffer.create 4096 in
  Yojson.Safe.to_string ~std:true json
  |> String.iter ~f:(function
    | '<' -> Buffer.add_string output "\\u003c"
    | '>' -> Buffer.add_string output "\\u003e"
    | '&' -> Buffer.add_string output "\\u0026"
    | c -> Buffer.add_char output c);
  Buffer.contents output

let render ~snapshot ~events ~warnings =
  let data =
    `Assoc
      [ "snapshot", snapshot
      ; "events", `List events
      ; "warnings", `List (List.map warnings ~f:(fun s -> `String s))
      ]
    |> script_data
  in
  (* Insert data last: package names can themselves contain template markers. *)
  Report_assets.template |> fun value ->
  replace_once value "__REPORT_STYLE__" Report_assets.style |> fun value ->
  replace_once value "__REPORT_SCRIPT__" Report_assets.script |> fun value ->
  replace_once value "__REPORT_DATA__" data

let read_events directory =
  let path = Filename.concat directory "events.jsonl" in
  if not (Sys.file_exists path)
  then
    ( []
    , [ "No event stream was recorded. Activity timing comes from the saved \
         snapshot."
      ] )
  else
    let channel = open_in_bin path in
    Fun.protect
      ~finally:(fun () -> close_in_noerr channel)
      (fun () ->
         let rec loop events skipped =
           match input_line channel with
           | line ->
             if String.trim line = ""
             then loop events skipped
             else (
               match Yojson.Safe.from_string line with
               | `Assoc _ as event -> loop (event :: events) skipped
               | _ -> loop events (skipped + 1)
               | exception Yojson.Json_error _ -> loop events (skipped + 1))
           | exception End_of_file ->
             ( List.rev events
             , if skipped = 0
               then []
               else
                 [ Printf.sprintf
                     "%d incomplete or invalid event records were skipped; \
                      some intervals may be incomplete."
                     skipped
                 ] )
         in
         loop [] 0)

let write ~directory snapshot =
  let events, warnings = read_events directory in
  let temporary, channel =
    Filename.open_temp_file ~temp_dir:directory ".nix-ci-build-report-" ".html"
  in
  try
    output_string channel (render ~snapshot ~events ~warnings);
    close_out channel;
    Unix.rename temporary (Filename.concat directory "report.html")
  with
  | exn ->
    close_out_noerr channel;
    (try Sys.remove temporary with Sys_error _ -> ());
    raise exn

let regenerate ~directory =
  let snapshot =
    Yojson.Safe.from_file (Filename.concat directory "results.json")
  in
  match snapshot with
  | `Assoc _ -> write ~directory snapshot
  | _ -> invalid_arg "results.json must contain an object"
