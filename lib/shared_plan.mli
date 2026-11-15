type request =
  { id : string
  ; roots : Plan.edge list
  }

type group =
  { id : string
  ; system : string
  ; kind : [ `Shared | `Package ]
  ; roots : Plan.edge list
  ; members : string list
  ; consumers : string list
  ; needs : string list
  ; required_paths : string list
  }
(** [members] are the derivations owned by this job. [roots] cover those
    members without independently scheduling overlapping shared components.
    [required_paths] must be imported before execution; they are already
    cached outputs or outputs published by jobs in [needs]. *)

type t =
  { requests : request list
  ; groups : group list
  }

val create :
   Plan.t
  -> requests:request list
  -> availability:(string -> Plan.availability)
  -> (t, string) result
(** Plan unique ownership of the remote-cache-pruned graph. Local outputs are
    treated as missing. Missing derivations consumed by multiple requests are
    grouped into shared dependency components; remaining work belongs to its
    request. A component spanning incompatible executors is rejected. Builtin
    derivations inherit a concrete consuming executor. All lists and IDs are
    deterministic. Unresolved required outputs and missing graph nodes fail
    planning rather than producing a non-portable plan. *)

val validate : Plan.t -> t -> (unit, string) result
(** Check ownership, roots, executor compatibility, dependencies, and transfer
    paths against the supplied complete graph. This does not query caches. *)

val to_yojson : t -> Yojson.Safe.t

val of_yojson : Yojson.Safe.t -> (t, string) result
(** Versioned JSON with strict structural validation. Use [validate] as well
    when loading a plan for execution. *)
