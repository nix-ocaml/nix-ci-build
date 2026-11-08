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

val parse : string -> event
(** Decode one [@nix ] record. Unknown or malformed records are preserved as
    [Raw]. Activity identifiers are decimal strings, including uint64 values
    larger than OCaml's [int]. A stop event does not imply build success. *)

val strip_ansi : string -> string
(** Remove terminal control sequences for readable logs and diagnostics. *)

val failed_derivations : string -> string list
(** Recognise explicit Nix builder failures, including the multiline
    [Cannot build ... / Reason: builder failed] format. Dependency-failure
    cascades and text in prefixed builder log excerpts are excluded. *)
