(function (global) {
  "use strict";

  const limits = Object.freeze({ characters: 8192, terms: 64 });
  const fields = new Map([
    ["kind", "kind"],
    ["status", "status"],
    ["state", "status"],
    ["name", "name"],
    ["needed-by", "needed-by"],
    ["consumer", "needed-by"],
    ["duration", "duration"],
  ]);
  const kinds = new Map([
    ["evaluation", "evaluation"],
    ["planning", "planning"],
    ["request", "request"],
    ["build", "build"],
    ["download", "download"],
    ["wait", "wait"],
    ["upload", "upload"],
    ["sync", "upload"],
    ["cache-sync", "upload"],
    ["import", "import"],
  ]);
  const statuses = new Map([
    ...[
      "built",
      "cached",
      "failed",
      "blocked",
      "cancelled",
      "queued",
      "submitted",
      "building",
      "downloading",
      "waiting",
      "uploading",
      "uploaded",
      "importing",
      "imported",
      "evaluating",
      "planning",
      "finished",
      "unobserved",
      "unknown",
      "skipped",
      "planned",
      "warning",
      "success",
      "active",
    ].map((name) => [name, name]),
    ["canceled", "cancelled"],
    ["failure", "failed"],
    ["error", "failed"],
    ["warn", "warning"],
    ["completed", "success"],
    ["complete", "success"],
    ["running", "active"],
    ["pending", "queued"],
    ["local", "cached"],
  ]);
  const activeStates = new Set([
    "queued",
    "submitted",
    "building",
    "downloading",
    "waiting",
    "uploading",
    "importing",
    "evaluating",
    "planning",
    "running",
  ]);
  const successStates = new Set([
    "built",
    "cached",
    "uploaded",
    "imported",
    "finished",
    "success",
    "completed",
    "complete",
  ]);
  const text = (value) => (typeof value === "string" ? value : "");
  const lower = (value) => text(value).toLowerCase();
  const whitespace = (character) => /\s/.test(character);

  function statusMatches(row, status) {
    const state = lower(row.state);
    if (status === "active") return activeStates.has(state);
    if (status === "success") return successStates.has(state);
    if (status === "built") {
      return (
        state === "built" ||
        (lower(row.kind) === "build" &&
          ["success", "completed", "complete", "finished"].includes(state))
      );
    }
    if (status === "failed")
      return ["failed", "failure", "error"].includes(state);
    if (status === "cancelled")
      return ["cancelled", "canceled"].includes(state);
    return state === status;
  }

  function predicate(term) {
    const value = term.value.toLowerCase();
    switch (term.field) {
      case "kind": {
        const kind = kinds.get(value);
        if (!kind)
          throw new Error(
            `Unknown kind '${term.value}'. Use build, download, wait, request, upload, import, evaluation, or planning.`,
          );
        return (row) => lower(row.kind) === kind;
      }
      case "status": {
        const status = statuses.get(value);
        if (!status)
          throw new Error(
            `Unknown status '${term.value}'. Use built, cached, failed, blocked, cancelled, queued, active, or an activity state.`,
          );
        return (row) => statusMatches(row, status);
      }
      case "name":
        return (row) => lower(row.name).includes(value);
      case "needed-by":
        return (row) =>
          Array.isArray(row.neededBy) &&
          row.neededBy.some((name) => lower(name).includes(value));
      case "duration": {
        const parsed =
          /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d*)?|\.\d+)\s*(ms|s|m|h)?$/i.exec(
            term.value.trim(),
          );
        if (!parsed)
          throw new Error(
            "Invalid duration. Use a nonnegative number with ms, s, m, or h, for example duration:>=2m (bare numbers are seconds).",
          );
        const units = { ms: 0.001, s: 1, m: 60, h: 3600 };
        term.operator = parsed[1] || "=";
        term.seconds =
          Number(parsed[2]) * units[(parsed[3] || "s").toLowerCase()];
        if (!Number.isFinite(term.seconds))
          throw new Error(
            "Duration is too large; use a finite number of seconds.",
          );
        return (row) => {
          if (
            typeof row.seconds !== "number" ||
            !Number.isFinite(row.seconds) ||
            row.seconds < 0
          )
            return false;
          switch (term.operator) {
            case ">":
              return row.seconds > term.seconds;
            case ">=":
              return row.seconds >= term.seconds;
            case "<":
              return row.seconds < term.seconds;
            case "<=":
              return row.seconds <= term.seconds;
            default:
              return row.seconds === term.seconds;
          }
        };
      }
      default:
        return (row) =>
          [
            text(row.search),
            text(row.name),
            text(row.kind),
            text(row.state),
            ...(Array.isArray(row.neededBy) ? row.neededBy.map(text) : []),
          ]
            .join(" ")
            .toLowerCase()
            .includes(value);
    }
  }

  // A bounded scanner keeps quotes and escaped punctuation literal. User input
  // is never compiled as a regular expression or evaluated as JavaScript.
  function compile(query) {
    const terms = [],
      predicates = [];
    let position = 0;
    const fail = (message, offset = position) => ({
      terms,
      error: message,
      errorAt: offset,
      match: () => false,
    });
    if (typeof query !== "string") return fail("Query must be text.", 0);
    if (query.length > limits.characters)
      return fail(
        `Query is too long; use at most ${limits.characters} characters.`,
        limits.characters,
      );
    while (position < query.length) {
      while (position < query.length && whitespace(query[position])) position++;
      if (position === query.length) break;
      const start = position;
      if (terms.length >= limits.terms)
        return fail(`Too many search terms; use at most ${limits.terms}.`);
      const negated = query[position] === "-";
      if (negated) position++;
      let value = "",
        colon = -1,
        quote = null;
      while (position < query.length) {
        const character = query[position];
        if (!quote && whitespace(character)) break;
        if (character === "\\") {
          position++;
          if (position === query.length)
            return fail("A trailing backslash must escape a character.");
          const escaped = query[position];
          if (quote && escaped === "u") {
            const digits = query.slice(position + 1, position + 5);
            if (!/^[\da-f]{4}$/i.test(digits))
              return fail("A Unicode escape needs four hexadecimal digits.");
            value += String.fromCharCode(parseInt(digits, 16));
            position += 5;
            continue;
          }
          const controls = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
          value +=
            quote && Object.hasOwn(controls, escaped)
              ? controls[escaped]
              : escaped;
          position++;
          continue;
        }
        if (quote) {
          if (character === quote) quote = null;
          else value += character;
        } else if (character === '"' || character === "'") {
          quote = character;
        } else {
          if (character === ":" && colon < 0) colon = value.length;
          value += character;
        }
        position++;
      }
      if (quote)
        return fail(
          `Unclosed ${quote === '"' ? "double" : "single"} quote.`,
          start,
        );
      let field = null;
      if (colon >= 0) {
        const name = value.slice(0, colon).toLowerCase();
        if (!fields.has(name))
          return fail(
            name
              ? `Unknown field '${name}'. Use kind:, status:, name:, needed-by:, or duration:. Quote text containing a literal colon.`
              : "A field name is required before ':'.",
            start,
          );
        field = fields.get(name);
        value = value.slice(colon + 1);
      }
      if (!value.trim())
        return fail(
          field
            ? `Provide a value after '${field}:'.`
            : "Provide a non-empty search term.",
          start,
        );
      const term = {
        start,
        end: position,
        raw: query.slice(start, position),
        field,
        value,
        negated,
      };
      try {
        predicates.push(predicate(term));
        terms.push(term);
      } catch (error) {
        return fail(error.message, start);
      }
    }
    return {
      terms,
      error: null,
      errorAt: null,
      match(row) {
        const value = row && typeof row === "object" ? row : {};
        return predicates.every((test, index) =>
          terms[index].negated ? !test(value) : test(value),
        );
      },
    };
  }

  function removeTerm(query, index) {
    const term = compile(query).terms[index];
    if (!Number.isInteger(index) || !term) return query;
    const left = query.slice(0, term.start).trimEnd(),
      right = query.slice(term.end).trimStart();
    return [left, right].filter(Boolean).join(" ").trim();
  }

  function addTerm(query, term) {
    if (typeof query !== "string" || !term || typeof term !== "object")
      throw new TypeError("addTerm expects query text and a term object.");
    const field = term.field == null ? null : fields.get(lower(term.field));
    if (term.field != null && !field)
      throw new TypeError("Unknown search field.");
    const value =
      typeof term.value === "number" && Number.isFinite(term.value)
        ? String(term.value)
        : text(term.value);
    if (!value.trim())
      throw new TypeError("A search term needs a non-empty value.");
    const encoded =
      /^[^\s"'\\:]+$/.test(value) && !value.startsWith("-")
        ? value
        : JSON.stringify(value);
    const added = `${term.negated ? "-" : ""}${field ? `${field}:` : ""}${encoded}`;
    return [query.trim(), added].filter(Boolean).join(" ");
  }

  const api = Object.freeze({ compile, removeTerm, addTerm, limits });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.NixReportQuery = api;
})(typeof window !== "undefined" ? window : globalThis);
