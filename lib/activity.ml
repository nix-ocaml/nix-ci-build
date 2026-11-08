type event =
  | Start of
      { id : string
      ; parent : string
      ; kind : int
      ; fields : Yojson.Safe.t list
      ; text : string
      }
  | Stop of string
  | Result of
      { id : string
      ; kind : int
      ; fields : Yojson.Safe.t list
      }
  | Message of
      { level : int
      ; message : string
      }
  | Raw of string

exception Invalid_record

let field name fields = List.assoc_opt name fields

let integer = function
  | Some (`Int value) -> value
  | Some (`Intlit value) ->
    (match int_of_string_opt value with
    | Some value -> value
    | None -> raise Invalid_record)
  | _ -> raise Invalid_record

let string = function
  | Some (`String value) -> value
  | _ -> raise Invalid_record

let identifier = function
  | Some (`Int value) when value >= 0 -> string_of_int value
  | Some (`Intlit value) | Some (`String value) ->
    if
      value = ""
      || not (String.for_all ~f:(fun c -> c >= '0' && c <= '9') value)
    then raise Invalid_record;
    value
  | _ -> raise Invalid_record

let fields = function
  | Some (`List fields) -> fields
  | None | Some `Null -> []
  | _ -> raise Invalid_record

let parse line =
  if not (String.starts_with ~prefix:"@nix " line)
  then Raw line
  else
    try
      let value =
        String.sub line ~pos:5 ~len:(String.length line - 5)
        |> Yojson.Safe.from_string
      in
      let record =
        match value with `Assoc fields -> fields | _ -> raise Invalid_record
      in
      match field "action" record with
      | Some (`String "start") ->
        Start
          { id = identifier (field "id" record)
          ; parent =
              (match field "parent" record with
              | None -> "0"
              | value -> identifier value)
          ; kind = integer (field "type" record)
          ; fields = fields (field "fields" record)
          ; text =
              (match field "text" record with
              | None -> ""
              | value -> string value)
          }
      | Some (`String "stop") -> Stop (identifier (field "id" record))
      | Some (`String "result") ->
        Result
          { id = identifier (field "id" record)
          ; kind = integer (field "type" record)
          ; fields = fields (field "fields" record)
          }
      | Some (`String "msg") ->
        Message
          { level = integer (field "level" record)
          ; message = string (field "msg" record)
          }
      | _ -> Raw line
    with
    | Invalid_record | Yojson.Json_error _ -> Raw line

let strip_ansi text =
  let buffer = Buffer.create (String.length text) in
  let length = String.length text in
  let rec sequence i =
    if i >= length
    then length
    else if text.[i] >= '@' && text.[i] <= '~'
    then i + 1
    else sequence (i + 1)
  in
  let rec control_string i =
    if i >= length
    then length
    else if text.[i] = '\007'
    then i + 1
    else if text.[i] = '\027' && i + 1 < length && text.[i + 1] = '\\'
    then i + 2
    else control_string (i + 1)
  in
  let rec loop i =
    if i < length
    then
      if text.[i] = '\027' && i + 1 < length
      then
        let next =
          match text.[i + 1] with
          | '[' -> sequence (i + 2)
          | ']' | 'P' | '^' | '_' -> control_string (i + 2)
          | _ -> i + 2
        in
        loop next
      else (
        if text.[i] <> '\027' then Buffer.add_char buffer text.[i];
        loop (i + 1))
  in
  loop 0;
  Buffer.contents buffer

let drop_prefix prefix text =
  if String.starts_with ~prefix text
  then
    Some
      (String.sub
         text
         ~pos:(String.length prefix)
         ~len:(String.length text - String.length prefix))
  else None

let header line =
  let line = String.trim line in
  match drop_prefix "error: " line with Some line -> line | None -> line

let path_after_prefix line prefix =
  match drop_prefix prefix line with
  | None -> None
  | Some rest ->
    let rest = String.trim rest in
    let offset =
      if String.length rest > 0 && (rest.[0] = '\'' || rest.[0] = '"')
      then 1
      else 0
    in
    let length = String.length rest in
    let rec finish i =
      if i >= length
      then i
      else
        match rest.[i] with
        | '\'' | '"' | ' ' | '\t' | '\r' | '\n' -> i
        | _ -> finish (i + 1)
    in
    let stop = finish offset in
    let path = String.sub rest ~pos:offset ~len:(stop - offset) in
    if
      String.starts_with ~prefix:"/nix/store/" path
      && String.ends_with ~suffix:".drv" path
    then Some (path, String.sub rest ~pos:stop ~len:(length - stop))
    else None

let failed_derivations message =
  let lines = String.split_on_char ~sep:'\n' (strip_ansi message) in
  let failures = ref [] in
  let current = ref None in
  List.iter lines ~f:(fun line ->
    let line = header line in
    match path_after_prefix line "builder for " with
    | Some (path, rest) ->
      (* The closing quote is retained in [rest]. *)
      let rest = String.trim rest in
      let rest =
        if String.length rest > 0 && (rest.[0] = '\'' || rest.[0] = '"')
        then String.sub rest ~pos:1 ~len:(String.length rest - 1) |> String.trim
        else rest
      in
      if String.starts_with ~prefix:"failed" rest
      then failures := path :: !failures;
      current := None
    | None ->
      (match path_after_prefix line "Cannot build " with
      | Some (path, _) -> current := Some path
      | None ->
        (match drop_prefix "Reason: " line with
        | Some reason ->
          (match !current with
          | Some path when String.starts_with ~prefix:"builder failed" reason ->
            failures := path :: !failures
          | _ -> ());
          current := None
        | None ->
          (* The reason immediately follows the header in Nix's diagnostic. Do
             not associate a later, unrelated builder log with it. *)
          if line <> "" then current := None)));
  List.sort_uniq !failures ~cmp:String.compare
