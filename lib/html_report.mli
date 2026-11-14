val render :
   snapshot:Yojson.Safe.t
  -> events:Yojson.Safe.t list
  -> warnings:string list
  -> string
(** A self-contained, offline HTML report. Embedded JSON is escaped independently
    of the trusted application assets; no network resources are needed. *)

val write : directory:string -> Yojson.Safe.t -> unit
(** Generate [report.html] from a snapshot and the durable event stream. Missing
    or incomplete event streams remain usable and are labelled in the report. *)

val regenerate : directory:string -> unit
(** Regenerate [report.html] from existing [results.json] and [events.jsonl]
    without invoking Nix. *)
