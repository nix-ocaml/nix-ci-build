let read path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> really_input_string channel (in_channel_length channel))

let () =
  List.iter
    (fun (name, path) -> Printf.printf "let %s = %S\n" name (read path))
    [ "template", Sys.argv.(1); "style", Sys.argv.(2); "script", Sys.argv.(3) ]
