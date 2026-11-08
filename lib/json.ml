let member key = function
  | `Assoc fields -> Option.value (List.assoc_opt key fields) ~default:`Null
  | _ -> `Null

let string = function `String s -> s | _ -> ""

let strings = function
  | `List xs ->
    List.filter_map xs ~f:(function `String s -> Some s | _ -> None)
  | _ -> []

let list = function `List xs -> xs | _ -> []
let assoc = function `Assoc xs -> xs | _ -> []
let number = function `Float n -> n | `Int n -> float_of_int n | _ -> 0.

let int64 = function
  | `Int n -> Some (Int64.of_int n)
  | `Intlit s -> Int64.of_string_opt s
  | _ -> None

let str s = `String s
let strs xs = `List (List.map xs ~f:str)
let optional f = function None -> `Null | Some x -> f x

let id = function
  | `Int n -> string_of_int n
  | `Intlit s | `String s -> s
  | _ -> ""

let read path = Yojson.Safe.from_file path

let atomic_write path json =
  let tmp = path ^ ".tmp" in
  let ch = open_out_bin tmp in
  Fun.protect
    ~finally:(fun () -> close_out_noerr ch)
    (fun () ->
       Yojson.Safe.to_channel ch json;
       output_char ch '\n';
       flush ch);
  Unix.rename tmp path

let rec mkdir path =
  if path <> "." && not (Sys.file_exists path)
  then (
    mkdir (Filename.dirname path);
    Unix.mkdir path 0o700)

let quote s =
  "'" ^ String.concat ~sep:"'\\''" (String.split_on_char ~sep:'\'' s) ^ "'"

let contains ~sub s =
  let rec loop i =
    i + String.length sub <= String.length s
    && (String.sub s ~pos:i ~len:(String.length sub) = sub || loop (i + 1))
  in
  loop 0

let clip n s =
  if String.length s <= n then s else String.sub s ~pos:0 ~len:n ^ "…"
