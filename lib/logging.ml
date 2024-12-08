module Logs = Logs

module type Logger = Logs.LOG

let setup file =
  let src = Logs.Src.create file in
  let module Logs = (val Logs.src_log src) in
  (module Logs : Logger)

let setup_logging ?style_renderer level =
  Logs_threaded.enable ();
  let pp_header src ppf (l, h) =
    let src_segment =
      if Logs.Src.equal src Logs.default
      then
        match Array.length Sys.argv with
        | 0 -> Filename.basename Sys.executable_name
        | _n -> Filename.basename Sys.argv.(0)
      else Logs.Src.name src
    in
    Format.fprintf ppf "%a [%s] " Logs_fmt.pp_header (l, h) src_segment
  in
  let format_reporter =
    let report src =
      let { Logs.report } = Logs_fmt.reporter ~pp_header:(pp_header src) () in
      report src
    in
    { Logs.report }
  in
  Fmt_tty.setup_std_outputs ?style_renderer ();
  Logs.set_level (Some level);
  Logs.set_reporter format_reporter
