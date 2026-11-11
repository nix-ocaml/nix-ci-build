"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const query = require("./query.js");

const row = {
  kind: "build",
  state: "built",
  name: "curl-8.11.0",
  neededBy: ["packages.piaf", "packages.cohttp_lwt_unix"],
  seconds: 125,
  search: "curl-8.11.0 /nix/store/hash-curl.drv buildPhase",
};

function valid(source) {
  const compiled = query.compile(source);
  assert.equal(compiled.error, null, source);
  return compiled;
}

test("empty queries leave all rows visible, including untimed packages", () => {
  const compiled = valid(" \t\n");
  assert.equal(compiled.terms.length, 0);
  assert.equal(compiled.match(row), true);
  assert.equal(compiled.match({}), true);
  assert.equal(compiled.match(null), true);
});

test("free words are literal case-insensitive AND conditions across searchable data", () => {
  assert.equal(valid("CURL buildPhase piaf").match(row), true);
  assert.equal(valid("curl unrelated").match(row), false);
  assert.equal(valid(".*").match(row), false);
  assert.equal(valid(".*").match({ name: "literal .* package" }), true);
  assert.equal(
    valid("piaf").match({ neededBy: [null, 42, "packages.piaf"] }),
    true,
  );
});

test("quoted phrases preserve spaces and literal field punctuation", () => {
  const phrase = valid('name:"curl library" "https://cache.invalid"');
  assert.equal(
    phrase.match({ name: "curl library", search: "https://cache.invalid" }),
    true,
  );
  assert.equal(
    phrase.match({
      name: "curl shared library",
      search: "https://cache.invalid",
    }),
    false,
  );
  assert.equal(valid("'status:failed'").terms[0].field, null);
  assert.equal(
    valid("name:'curl library'").match({ name: "CURL LIBRARY" }),
    true,
  );
  assert.equal(
    valid("https\\://cache.invalid").match({ search: "https://cache.invalid" }),
    true,
  );
});

test("field clauses and leading negation compose with free text", () => {
  const compiled = valid(
    "curl kind:build -status:failed needed-by:piaf duration:>=2m",
  );
  assert.equal(compiled.match(row), true);
  for (const changed of [
    { kind: "download" },
    { state: "failed" },
    { neededBy: ["other"] },
    { seconds: 119.9 },
  ])
    assert.equal(
      compiled.match({ ...row, ...changed }),
      false,
      JSON.stringify(changed),
    );
  assert.equal(
    valid('-"curl library"').match({ name: "curl shared library" }),
    true,
  );
  assert.equal(valid('-"curl library"').match({ name: "curl library" }), false);
  assert.equal(valid("-needed-by:piaf").match(row), false);
});

test("field aliases preserve canonical terms and distinct state semantics", () => {
  const compiled = valid("STATE:BUILT consumer:PIAF");
  assert.deepEqual(
    compiled.terms.map((term) => term.field),
    ["status", "needed-by"],
  );
  assert.equal(compiled.match(row), true);
  assert.equal(valid("kind:sync").match({ kind: "upload" }), true);
  assert.equal(valid("kind:cache-sync").match({ kind: "upload" }), true);
  assert.equal(valid("status:canceled").match({ state: "cancelled" }), true);
  assert.equal(valid("status:failed").match({ state: "error" }), true);
  assert.equal(valid("status:failed").match({ state: "blocked" }), false);
  assert.equal(valid("status:blocked").match({ state: "blocked" }), true);
  assert.equal(valid("status:warning").match({ state: "warning" }), true);
  assert.equal(valid("status:warn").match({ state: "warning" }), true);
});

test("built includes successful build lanes without treating cached or uploaded roots as builds", () => {
  const built = valid("status:built");
  for (const state of ["built", "completed", "success", "finished"]) {
    assert.equal(built.match({ kind: "build", state }), true, state);
  }
  for (const state of [
    "cached",
    "uploaded",
    "imported",
    "failed",
    "building",
  ]) {
    assert.equal(built.match({ kind: "build", state }), false, state);
  }
  assert.equal(built.match({ kind: "upload", state: "completed" }), false);
  assert.equal(built.match({ kind: "request", state: "built" }), true);
  for (const state of [
    "built",
    "cached",
    "uploaded",
    "imported",
    "completed",
  ]) {
    assert.equal(valid("status:success").match({ state }), true, state);
    assert.equal(valid("status:completed").match({ state }), true, state);
  }
});

test("active status follows final row state, including cancellation", () => {
  const active = valid("status:active");
  for (const state of [
    "queued",
    "submitted",
    "building",
    "downloading",
    "waiting",
    "uploading",
    "importing",
  ]) {
    assert.equal(active.match({ state }), true, state);
  }
  for (const state of ["cancelled", "failed", "built", "cached", "finished"]) {
    assert.equal(active.match({ state, open: true }), false, state);
  }
});

test("duration comparisons honor all units, decimals, equality, and zero", () => {
  const cases = [
    ["duration:>2m", 120.001, true],
    ["duration:>2m", 120, false],
    ["duration:>=2m", 120, true],
    ["duration:<1h", 3600, false],
    ["duration:<=.5h", 1800, true],
    ["duration:=250ms", 0.25, true],
    ["duration:250MS", 0.25, true],
    ["duration:1.5m", 90, true],
    ["duration:30", 30, true],
    ["duration:0s", 0, true],
    ["duration:<=0", 0, true],
    ["duration:>0", 0, false],
    ['duration:">= 2 m"', 120, true],
    ["-duration:>2m", 121, false],
  ];
  for (const [source, seconds, expected] of cases) {
    assert.equal(
      valid(source).match({ seconds }),
      expected,
      `${source}, ${seconds}`,
    );
  }
  const term = valid("duration:>=2m").terms[0];
  assert.equal(term.operator, ">=");
  assert.equal(term.seconds, 120);
});

test("missing and non-finite duration values never count as measured zero", () => {
  const zero = valid("duration:<=0");
  for (const seconds of [undefined, null, "0", NaN, Infinity, -Infinity, -1]) {
    assert.equal(zero.match({ seconds }), false, String(seconds));
  }
  assert.equal(valid("-duration:>1m").match({ seconds: null }), true);
});

test("invalid fields, values, quoting, and durations report useful errors and match nothing", () => {
  const cases = [
    ["author:me", /Unknown field/],
    ["__proto__:x", /Unknown field/],
    [":curl", /field name/],
    ["name:", /value/],
    ["kind: build", /value/],
    ["kind:banana", /Unknown kind/],
    ["status:bananas", /Unknown status/],
    ['name:"curl', /Unclosed double quote/],
    ["'curl", /Unclosed single quote/],
    ["curl\\", /backslash/],
    ['name:"\\u12"', /Unicode escape/],
    ["-", /non-empty/],
    ['""', /non-empty/],
    ['name:" "', /value/],
    ["duration:-2m", /Invalid duration/],
    ["duration:NaN", /Invalid duration/],
    ["duration:Infinity", /Invalid duration/],
    ["duration:1e3s", /Invalid duration/],
    ["duration:==2m", /Invalid duration/],
    ["duration:=>2m", /Invalid duration/],
    ["duration:2days", /Invalid duration/],
    ["duration:1m30s", /Invalid duration/],
    ["duration:> 2m", /Invalid duration/],
    ["duration:" + "9".repeat(400) + "h", /too large/],
  ];
  for (const [source, message] of cases) {
    const compiled = query.compile(source);
    assert.match(compiled.error, message, source);
    assert.equal(compiled.match(row), false, source);
    assert.equal(Number.isInteger(compiled.errorAt), true, source);
  }
  assert.match(query.compile(null).error, /text/);
});

test("term positions retain the original syntax for chips and individual removal", () => {
  const source = '  kind:build\tname:"curl library"   -consumer:piaf  ';
  const terms = valid(source).terms;
  assert.deepEqual(
    terms.map((term) => term.raw),
    ["kind:build", 'name:"curl library"', "-consumer:piaf"],
  );
  for (const term of terms)
    assert.equal(source.slice(term.start, term.end), term.raw);
  assert.equal(terms[2].negated, true);
  assert.equal(
    query.removeTerm(source, 0),
    'name:"curl library"   -consumer:piaf',
  );
  assert.equal(query.removeTerm(source, 1), "kind:build -consumer:piaf");
  assert.equal(query.removeTerm(source, 2), 'kind:build\tname:"curl library"');
  assert.equal(query.removeTerm(source, -1), source);
  assert.equal(query.removeTerm(source, 30), source);
  assert.equal(query.removeTerm('name:"🐫 library"', 0), "");
});

test("an incomplete final term does not hide earlier editable clauses", () => {
  const source = 'kind:build name:"curl';
  const compiled = query.compile(source);
  assert.match(compiled.error, /Unclosed/);
  assert.equal(compiled.errorAt, 11);
  assert.equal(compiled.terms.length, 1);
  assert.equal(query.removeTerm(source, 0), 'name:"curl');
});

test("facet helpers round-trip literal values without turning them into query syntax", () => {
  const values = [
    "curl library",
    'curl "quoted" library',
    "status:failed",
    "-curl",
    "path\\with\\slashes",
    "line\nbreak",
    "tab\tvalue",
    "null\u0000value",
    "🐫 library",
    "</script><script>throw 1</script>",
  ];
  for (const value of values) {
    const added = query.addTerm("", { field: "name", value });
    const compiled = valid(added);
    assert.equal(compiled.terms.length, 1, value);
    assert.equal(compiled.terms[0].value, value, value);
    assert.equal(compiled.match({ name: value }), true, value);
    const free = valid(query.addTerm("", { value }));
    assert.equal(free.terms[0].field, null);
    assert.equal(free.match({ search: value }), true, value);
  }
  assert.equal(
    query.addTerm("kind:build  ", {
      field: "consumer",
      value: "piaf",
      negated: true,
    }),
    "kind:build -needed-by:piaf",
  );
  assert.equal(
    valid(query.addTerm("", { field: "duration", value: 0 })).match({
      seconds: 0,
    }),
    true,
  );
  assert.throws(
    () => query.addTerm("", { field: "unknown", value: "x" }),
    /Unknown/,
  );
  assert.throws(() => query.addTerm("", { value: "" }), /non-empty/);
});

test("query size and term limits bound parser and per-row work", () => {
  assert.equal(valid("x".repeat(query.limits.characters)).terms.length, 1);
  assert.match(
    query.compile("x".repeat(query.limits.characters + 1)).error,
    /too long/,
  );
  assert.equal(
    valid(Array(query.limits.terms).fill("curl").join(" ")).match(row),
    true,
  );
  assert.match(
    query.compile(
      Array(query.limits.terms + 1)
        .fill("curl")
        .join(" "),
    ).error,
    /Too many/,
  );
});

test("the same standalone file exposes its browser API without Node or a network", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "query.js"), "utf8"),
    sandbox,
  );
  assert.equal(typeof sandbox.window.NixReportQuery.compile, "function");
  assert.equal(
    sandbox.window.NixReportQuery.compile("kind:build").match(row),
    true,
  );
  assert.equal(
    sandbox.window.NixReportQuery.compile("constructor:x").match(row),
    false,
  );
});
