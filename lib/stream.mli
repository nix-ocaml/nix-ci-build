type _ t

val empty : unit -> _ t
val from : f:(unit -> 'a option) -> 'a t
val create : int -> 'a t * ('a option -> unit)
val close : _ t -> unit
val closed : _ t -> unit Eio.Promise.t
val when_closed : f:(unit -> unit) -> _ t -> unit
val is_closed : _ t -> bool
val take : 'a t -> 'a option
val of_list : 'a list -> 'a t
val to_list : 'a t -> 'a list
val map : f:('a -> 'b) -> 'a t -> 'b t
val iter : f:('a -> unit) -> 'a t -> unit
val iter_p : sw:Eio.Switch.t -> f:('a -> unit) -> 'a t -> unit
val fold : f:('acc -> 'a -> 'acc) -> init:'acc -> 'a t -> 'acc
val drain : _ t -> unit
val drain_available : _ t -> unit
