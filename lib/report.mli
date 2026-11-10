(** Reporting consumes snapshots so that it does not own scheduling state.
    Unknown fields are ignored and incomplete snapshots are supported. Calls
    should be serialized by the engine. No GitHub environment variables are
    read by this module. *)

type t

val create :
   ?verbose:bool
  -> ?color:bool
  -> directory:string
  -> summary_output:string option
  -> github_actions:bool
  -> unit
  -> t
(** Color defaults to [github_actions]. The caller can disable it for NO_COLOR.
    Verbose mode includes otherwise quiet lifecycle events in the console. *)

val directory : t -> string

val append_event : t -> Yojson.Safe.t -> unit
(** Append one JSON event and flush it immediately. *)

val emit_event : t -> Yojson.Safe.t -> unit
(** Render meaningful lifecycle events. Routine cache/download/sync events stay
    in the event file and aggregate progress unless verbose output is enabled. *)

val emit_plan : t -> Yojson.Safe.t -> unit
(** Print a compact plan, a bounded completed detail group in Actions, and any
    evaluation errors. Groups are emitted atomically, never across build work. *)

val write_snapshot : t -> Yojson.Safe.t -> unit
(** Atomically replace [results.json] and [summary.md] in the report directory. *)

val emit_progress : t -> Yojson.Safe.t -> unit

val emit_failure : t -> Yojson.Safe.t -> unit
(** Emit one distinct root failure. GitHub annotations are bounded, and arbitrary
    log output is protected against workflow-command interpretation. *)

val finish : t -> Yojson.Safe.t -> unit
(** Write the final snapshot and summary to the explicitly configured output.
    [None] prints the saved summary path. A filename is replaced atomically.
    Evaluation and run errors are surfaced even when no build was submitted. *)

val close : t -> unit

val render_summary : Yojson.Safe.t -> string
(** Pure renderers, also used by the report tests. *)

val render_progress : Yojson.Safe.t -> string list
(** Progress counts unique requested derivations. Activity durations cover the
    whole observed activity, independently of the displayed current phase. *)

val render_event :
   ?verbose:bool
  -> ?color:bool
  -> Yojson.Safe.t
  -> string option

val render_failure : github_actions:bool -> Yojson.Safe.t -> string
