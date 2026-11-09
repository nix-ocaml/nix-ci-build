type edge =
  { drv_path : string
  ; outputs : string list
  }
(** A conservative, output-sensitive view of a derivation graph. Nix remains
    responsible for deciding whether and how a derivation is realised. *)

type node =
  { drv_path : string
  ; name : string
  ; system : string
  ; allow_substitutes : bool
  ; inputs : edge list
  ; outputs : (string * string option) list
  }
(** An edge requesting ["*"] requests every output. *)

type t

val empty : t
val normalize_drv_path : string -> string
val of_nodes : node list -> t
val nodes : t -> node list
val find : t -> string -> node option
val merge : t -> t -> t
val of_yojson : Yojson.Safe.t -> (t, string) result

type cache_info =
  { download_size : int64 option
  ; nar_size : int64 option
  ; references : string list
  }

type availability =
  | Local
  | Cached of cache_info
  | Missing

type download =
  { path : string
  ; download_size : int64 option
  ; nar_size : int64 option
  }

type plan =
  { roots : edge list
  ; builds : node list
  ; downloads : download list
  ; local_outputs : string list
  ; unknown : string list
  }

val compute :
   t
  -> roots:edge list
  -> availability:(string -> availability)
  -> plan
(** Cached requested outputs prune their build dependencies. Missing outputs of
    the same derivation require its inputs. Cached references are followed when
    supplied; missing graph nodes and unresolved output paths remain [unknown]. *)

val explain :
   t
  -> availability:(string -> availability)
  -> root:edge
  -> target:string
  -> string list option
(** A path of derivation paths from a root to a required dependency. Dependencies
    hidden behind cached outputs are excluded. [target] may also be an output
    path, in which case that path is the final element. *)

val failed_ancestors :
   t
  -> availability:(string -> availability)
  -> root:edge
  -> failed:string list
  -> string list

val rank :
   ?plan_for_root:(edge -> plan)
  -> t
  -> availability:(string -> availability)
  -> failed:string list
  -> now:float
  -> duration:(string -> float option)
  -> pending:(edge * float) list
  -> edge list
(** Rank unblocked requested roots using shared missing prerequisites, estimated
    critical-path duration and age. Unknown durations use a small default; each
    hour waiting adds enough weight to prevent short jobs being starved by a
    steady supply of comparable new jobs. Input order breaks remaining ties.
    Timestamps use the same clock as [now]. [plan_for_root], when supplied, is
    called once per pending root and must reflect the same graph, requested
    outputs and availability snapshot. Callers may cache these plans until
    availability changes. *)

val to_yojson : plan -> Yojson.Safe.t

type diff =
  { added_builds : string list
  ; removed_builds : string list
  ; added_downloads : string list
  ; removed_downloads : string list
  }

val diff : previous:Yojson.Safe.t -> current:plan -> (diff, string) result
(** Compare the identities in two saved plans; malformed snapshots return an
    error instead of masquerading as an empty previous build. *)
