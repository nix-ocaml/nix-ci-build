import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Opt in after `npm run build`; PLAYWRIGHT_MODULE may point to an existing local
// installation. This test neither installs a browser nor opens external services.
test(
  "live explorer preserves selection through SSE updates and shows separate workflow evidence",
  { skip: !process.env.NIX_LIVE_BROWSER_TESTS, timeout: 60000 },
  async () => {
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE
        ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
        : "playwright"
    );
    const now = Math.floor(Date.now() / 1000),
      runId = "github:nix-ocaml/nix-overlays:1234:1";
    const job = (id, kind, needs, status, start, finish) => ({
      id,
      key: `invocation-${id}`,
      attemptId: "attempt-a",
      name: id,
      groupId: id,
      kind,
      needs,
      status,
      startedAt: start,
      finishedAt: finish,
      plannedAt: now - 130,
      lastEventAt: finish || now,
      heartbeatAt: now,
      system: "x86_64-linux",
      matrix:
        kind === "package"
          ? { ocaml: "5.4", target: id.includes("musl") ? "musl" : "native" }
          : {},
      metrics: {
        built: status === "success" ? 1 : 0,
        cached: 25,
        downloads: 3,
      },
      phases: [],
    });
    const jobs = [
      job("plan", "plan", [], "success", now - 120, now - 100),
      job("shared-topkg", "shared", ["plan"], "success", now - 99, now - 70),
      job("native-5.4", "package", ["shared-topkg"], "running", now - 68, null),
      job("musl-5.4", "package", ["shared-topkg"], "planned", null, null),
    ];
    jobs[3].key = "planned:musl-5.4";
    let revision = 1;
    const run = {
      id: runId,
      repository: "nix-ocaml/nix-overlays",
      workflow: "Build package sets",
      branch: "live-build-visualizer",
      commitSha: "aa11bb22cc33dd44",
      pullRequest: 2800,
      runNumber: 1234,
      runAttempt: 1,
      status: "running",
      startedAt: now - 120,
      updatedAt: now,
      url: "https://github.com/nix-ocaml/nix-overlays/actions/runs/1234",
      counts: { total: 4, success: 2, running: 1, planned: 1 },
      github: {
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/nix-ocaml/nix-overlays/actions/runs/1234",
      },
    };
    const activities = [
      {
        id: "build-fmt",
        jobKey: "invocation-native-5.4",
        jobId: "native-5.4",
        attemptId: "attempt-a",
        kind: "build",
        name: "ocaml-fmt-0.10.0",
        status: "building",
        startedAt: now - 50,
        finishedAt: null,
        drvPath: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ocaml-fmt.drv",
        phase: "buildPhase",
      },
      {
        id: "cached-compiler",
        jobKey: "invocation-native-5.4",
        jobId: "native-5.4",
        attemptId: "attempt-a",
        kind: "request",
        name: "ocaml-5.4.0",
        status: "cached",
        startedAt: null,
        finishedAt: null,
      },
      {
        id: "download",
        jobKey: "invocation-native-5.4",
        jobId: "native-5.4",
        attemptId: "attempt-a",
        kind: "download",
        name: "libpq",
        status: "success",
        startedAt: now - 64,
        finishedAt: now - 55,
        durationSeconds: 9,
      },
    ];
    const githubJobs = [
      {
        id: 500,
        checkRunId: 600,
        name: "Upload reports",
        status: "completed",
        conclusion: "failure",
        runnerName: "ubuntu-24.04",
        startedAt: (now - 60) * 1000,
        completedAt: (now - 10) * 1000,
        steps: [
          {
            number: 1,
            name: "Upload artifact",
            status: "completed",
            conclusion: "failure",
            startedAt: (now - 60) * 1000,
            completedAt: (now - 10) * 1000,
          },
        ],
      },
    ];
    const streams = new Set();
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/api/session") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            mode: "local",
            user: null,
            connections: [],
            signInUrl: null,
            installUrl: null,
          }),
        );
        return;
      }
      if (url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.write(
          `event: ready\ndata: ${JSON.stringify({ revision })}\n\n`,
        );
        streams.add(response);
        request.on("close", () => streams.delete(response));
        return;
      }
      if (url.pathname === "/api/runs") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            now: Date.now() / 1000,
            revision,
            runs: [run],
          }),
        );
        return;
      }
      if (url.pathname.startsWith("/api/runs/")) {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            now: Date.now() / 1000,
            revision,
            run,
            jobs,
            activities,
            githubJobs,
            diagnostics: [],
          }),
        );
        return;
      }
      const filename =
        url.pathname === "/app.js"
          ? "app.js"
          : url.pathname === "/app.css"
            ? "app.css"
            : "index.html";
      response.setHeader(
        "Content-Type",
        filename.endsWith(".js")
          ? "text/javascript"
          : filename.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      try {
        response.end(
          await readFile(new URL(`../dist/${filename}`, import.meta.url)),
        );
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_BINARY
        ? { executablePath: process.env.CHROME_BINARY }
        : {}),
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1100 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage(),
        errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          !request.url().startsWith(origin) &&
          !request.url().startsWith("data:")
        )
          external.push(request.url());
      });
      await page.goto(`${origin}/runs/${encodeURIComponent(runId)}`);
      await page
        .getByRole("heading", { name: /Build package sets.*1234/ })
        .waitFor();
      await page
        .getByRole("button", {
          name: "Inspect native-5.4: Running",
          exact: true,
        })
        .click();
      await page.locator(".wf-bar").first().waitFor();
      await page.locator(".wf-bar").first().click();
      await page.locator(".activity-inspector").waitFor();
      await page
        .getByRole("textbox", { name: "Search package activity" })
        .fill("kind:build");
      assert.equal(await page.locator(".wf-row").count(), 1);
      jobs.push(
        job("native-5.5", "package", ["shared-topkg"], "planned", null, null),
      );
      run.counts.total = 5;
      revision++;
      for (const stream of streams)
        stream.write(
          `event: invalidate\ndata: ${JSON.stringify({ revision, runId })}\n\n`,
        );
      await page
        .getByRole("button", {
          name: "Inspect native-5.5: Planned",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Search package activity" })
          .inputValue(),
        "kind:build",
      );
      assert.ok(
        new URL(page.url()).searchParams.get("job") === "invocation-native-5.4",
      );
      await page
        .getByRole("button", {
          name: "Inspect musl-5.4: Planned",
          exact: true,
        })
        .click();
      await page
        .locator('.job-detail[aria-label="Job details: musl-5.4"]')
        .waitFor();
      assert.equal(
        new URL(page.url()).searchParams.get("job"),
        "planned:musl-5.4",
      );
      const plannedHistoryLength = await page.evaluate(() => history.length);
      jobs[3] = {
        ...jobs[3],
        key: "invocation-musl-5.4",
        status: "running",
        startedAt: now - 5,
      };
      revision++;
      for (const stream of streams)
        stream.write(
          `event: invalidate\ndata: ${JSON.stringify({ revision, runId })}\n\n`,
        );
      await page
        .getByRole("button", {
          name: "Inspect musl-5.4: Running",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .locator('.job-detail[aria-label="Job details: musl-5.4"]')
          .count(),
        1,
        "the selected planned job remains open when its invocation registers",
      );
      await page.waitForURL(
        (url) => url.searchParams.get("job") === "invocation-musl-5.4",
      );
      assert.equal(
        await page.evaluate(() => history.length),
        plannedHistoryLength,
        "registration updates the current history entry",
      );
      assert.equal(
        await page.locator(".job-card.selected").getAttribute("data-job-key"),
        "invocation-musl-5.4",
      );
      await page
        .getByRole("button", {
          name: "Inspect native-5.4: Running",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "Activity table", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Search package activity" })
        .fill("status:cached");
      await page
        .getByRole("cell", { name: "ocaml-5.4.0", exact: true })
        .waitFor();
      assert.ok(
        (await page.locator(".activity-table").innerText()).includes("—"),
      );
      await page
        .getByRole("textbox", { name: "Search package activity" })
        .fill("status:cached duration:0");
      await page
        .getByText("No activities match this query.", { exact: true })
        .waitFor();
      await page.getByRole("tab", { name: /Workflow steps/i }).click();
      await page.getByText("Upload artifact", { exact: true }).waitFor();
      assert.ok(
        (await page.locator(".workflow-job-context").innerText()).includes(
          "No matching build invocation",
        ),
      );
      await page.getByRole("button", { name: "Dark", exact: true }).click();
      assert.ok(
        (await page.locator("body").getAttribute("class")).includes(
          "dark-mode",
        ),
      );
      await page.getByRole("button", { name: "Light", exact: true }).click();
      await page.getByRole("tab", { name: /Pipeline/i }).click();
      await page
        .getByRole("button", { name: "Waterfall", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Search package activity" })
        .fill("");
      await page.screenshot({
        path: process.env.NIX_LIVE_SCREENSHOT || "/tmp/nix-ci-live-desktop.png",
        fullPage: true,
      });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(80);
        const dimensions = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert.ok(
          dimensions.scroll <= dimensions.width,
          `viewport ${width} overflowed to ${dimensions.scroll}`,
        );
      }
      await page.screenshot({
        path: "/tmp/nix-ci-live-mobile.png",
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      await browser.close();
      for (const stream of streams) stream.end();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
