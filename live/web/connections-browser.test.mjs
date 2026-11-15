import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

test(
  "GitHub sessions, workspace access, discovery before telemetry, and connection management",
  { skip: !process.env.NIX_LIVE_BROWSER_TESTS, timeout: 60000 },
  async () => {
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE
        ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
        : "playwright"
    );
    const screenshotDir =
      process.env.NIX_LIVE_SERVICE_SCREENSHOTS ||
      "/tmp/nix-ci-github-service-01a1b78b";
    await mkdir(screenshotDir, { recursive: true });
    const now = Date.now() / 1000;
    let signedIn = false,
      csrf = "csrf-initial",
      refreshCount = 0,
      runsRequests = 0,
      streamRequests = 0,
      personalResponseStatus = 0;
    const mutationTokens = [],
      streams = new Set();
    let connections = [
      {
        installationId: 10,
        account: { id: 1, login: "alice", type: "User", avatarUrl: null },
        repositories: [{ id: 100, fullName: "alice/toolbox", private: true }],
      },
      {
        installationId: 20,
        account: {
          id: 2,
          login: "nix-ocaml",
          type: "Organization",
          avatarUrl: null,
        },
        repositories: [
          { id: 200, fullName: "nix-ocaml/nix-overlays", private: false },
          { id: 201, fullName: "nix-ocaml/nix-ci-build", private: false },
        ],
      },
    ];
    const run = (id, repository, repositoryId, title, offset) => ({
      id,
      repository,
      repositoryId,
      workflow: title,
      branch: "master",
      status: "failed",
      reportedStatus: "unknown",
      workflowStatus: "failed",
      telemetryStatus: "not_reported",
      invocationCount: 0,
      startedAt: now - 60 + offset,
      finishedAt: now - 10 + offset,
      updatedAt: now,
      runAttempt: 1,
      counts: { total: 0 },
      url: `https://github.com/${repository}/actions/runs/123`,
      github: {
        status: "completed",
        conclusion: "failure",
        url: `https://github.com/${repository}/actions/runs/123`,
      },
    });
    const teamRun = run(
      "github:nix-ocaml/nix-overlays:123:1",
      "nix-ocaml/nix-overlays",
      200,
      "OCaml package sets",
      0,
    );
    const personalRun = run(
      "github:alice/toolbox:456:1",
      "alice/toolbox",
      100,
      "Personal build",
      -10,
    );
    const runs = [teamRun, personalRun];
    const session = () => ({
      mode: "github",
      user: signedIn
        ? { id: 1, login: "alice", name: "Alice Example", avatarUrl: null }
        : null,
      connections: signedIn ? connections : [],
      signInUrl: "/auth/github",
      installUrl: signedIn
        ? "https://github.com/apps/build-observatory/installations/new"
        : null,
      ...(signedIn ? { csrfToken: csrf } : {}),
    });
    const send = (response, value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/api/session") return send(response, session());
      if (url.pathname === "/auth/github") {
        signedIn = true;
        response.writeHead(302, {
          Location: url.searchParams.get("returnTo") || "/",
        });
        response.end();
        return;
      }
      if (
        url.pathname === "/api/connections/refresh" ||
        url.pathname === "/auth/logout"
      ) {
        mutationTokens.push(request.headers["x-csrf-token"]);
        if (!signedIn) return send(response, {}, 401);
        if (
          request.method !== "POST" ||
          request.headers["x-csrf-token"] !== csrf
        )
          return send(response, {}, 403);
        if (url.pathname === "/auth/logout") {
          signedIn = false;
          return send(response, { ok: true });
        }
        refreshCount++;
        csrf = "csrf-refreshed";
        connections = [
          ...connections,
          {
            installationId: 30,
            account: { id: 3, login: "melange-re", type: "Organization" },
            repositories: [
              { id: 300, fullName: "melange-re/melange", private: false },
            ],
          },
        ];
        return send(response, session());
      }
      if (url.pathname === "/api/runs") {
        runsRequests++;
        return signedIn
          ? send(response, {
              schemaVersion: 1,
              revision: 1,
              now: Date.now() / 1000,
              runs: runs.filter((item) =>
                connections.some((connection) =>
                  connection.repositories.some(
                    (repository) => repository.id === item.repositoryId,
                  ),
                ),
              ),
            })
          : send(response, {}, 401);
      }
      if (url.pathname.startsWith("/api/runs/")) {
        if (!signedIn) return send(response, {}, 401);
        const selected = runs.find(
          (item) =>
            item.id ===
            decodeURIComponent(url.pathname.slice("/api/runs/".length)),
        );
        if (!selected) return send(response, {}, 404);
        if (selected.id === personalRun.id && personalResponseStatus)
          return send(response, {}, personalResponseStatus);
        return send(response, {
          schemaVersion: 1,
          revision: 1,
          now: Date.now() / 1000,
          run: selected,
          jobs: [],
          activities: [],
          diagnostics: [],
          githubJobs: [
            {
              id: 900,
              checkRunId: 901,
              name: "Runner setup",
              status: "completed",
              conclusion: "failure",
              startedAt: (now - 60) * 1000,
              completedAt: (now - 10) * 1000,
              steps: [
                {
                  number: 1,
                  name: "Check out source",
                  status: "completed",
                  conclusion: "failure",
                  startedAt: (now - 60) * 1000,
                  completedAt: (now - 10) * 1000,
                },
              ],
            },
          ],
        });
      }
      if (url.pathname === "/api/events") {
        streamRequests++;
        if (!signedIn) return send(response, {}, 401);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.write('event: ready\ndata: {"revision":1}\n\n');
        streams.add(response);
        request.on("close", () => streams.delete(response));
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
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1050 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const path = `/runs/${encodeURIComponent(teamRun.id)}`;
      await page.goto(origin + path + "?auth_error=github");
      await page.getByRole("link", { name: "Continue with GitHub" }).waitFor();
      assert.equal(runsRequests, 0);
      assert.equal(streamRequests, 0);
      await page
        .getByRole("alert")
        .filter({ hasText: "GitHub sign-in could not be completed" })
        .waitFor();
      const signInHref = new URL(
        await page
          .getByRole("link", { name: "Continue with GitHub" })
          .getAttribute("href"),
        origin,
      );
      assert.equal(signInHref.searchParams.get("returnTo"), path);
      await page.screenshot({
        path: `${screenshotDir}/sign-in-error.png`,
        fullPage: true,
      });
      await page.goto(origin + path);
      await page.getByRole("link", { name: "Continue with GitHub" }).waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
      await page.screenshot({
        path: `${screenshotDir}/sign-in.png`,
        fullPage: true,
      });
      await page.getByRole("link", { name: "Continue with GitHub" }).click();
      await page
        .getByRole("heading", { name: "OCaml package sets", exact: true })
        .waitFor();
      await page
        .getByRole("heading", {
          name: "Workflow finished without build reports",
          exact: true,
        })
        .waitFor();
      await page.getByText("Check out source", { exact: true }).waitFor();
      assert.equal(
        await page.locator(".run-heading-status").innerText(),
        "WORKFLOW\nFAILED\nGitHub Actions",
      );
      assert.equal(
        await page.locator(".workflow-evidence").innerText(),
        "No build reports received\nInspect workflow steps",
      );
      assert.ok(
        (await page.locator(".workflow-metrics").innerText()).includes(
          "Build reports\nNone received\nNo build reports received",
        ),
      );
      assert.equal(await page.locator(".run-list-item").count(), 2);
      await page.screenshot({
        path: `${screenshotDir}/webhook-run.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Connections", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Your GitHub connections", exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).pathname, "/connections");
      assert.equal(await page.locator(".connection-card").count(), 2);
      await page
        .getByRole("button", { name: "Refresh connections", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "melange-re", exact: true })
        .waitFor();
      assert.equal(refreshCount, 1);
      assert.equal(mutationTokens[0], "csrf-initial");
      await page.screenshot({
        path: `${screenshotDir}/connections.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Dark", exact: true }).click();
      assert.ok(
        (await page.locator("body").getAttribute("class")).includes(
          "dark-mode",
        ),
      );
      await page.screenshot({
        path: `${screenshotDir}/connections-dark.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Light", exact: true }).click();
      await page
        .getByRole("button", { name: "alice/toolbox", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Personal build", exact: true })
        .waitFor();
      assert.equal(await page.locator(".run-list-item").count(), 1);
      assert.equal(new URL(page.url()).searchParams.get("workspace"), "10");
      assert.equal(
        new URL(page.url()).searchParams.get("repository"),
        "alice/toolbox",
      );
      await page.reload();
      await page
        .getByRole("heading", { name: "Personal build", exact: true })
        .waitFor();
      assert.equal(await page.locator(".run-list-item").count(), 1);
      // A temporary outage preserves the snapshot; a subsequent denial removes it
      // and refreshes repository access without an access event from the stream.
      personalResponseStatus = 503;
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await page
        .getByText("Build updates are temporarily unavailable.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByRole("heading", { name: "Personal build", exact: true })
          .count(),
        1,
      );
      personalResponseStatus = 403;
      connections = connections.filter(
        (connection) => connection.installationId !== 10,
      );
      const refreshedAccess = page.waitForResponse((response) =>
        response.url().endsWith("/api/session"),
      );
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await refreshedAccess;
      await page
        .getByText("You no longer have access to this run.", {
          exact: true,
        })
        .waitFor();
      await page.locator(".run-heading").waitFor({ state: "hidden" });
      assert.equal(await page.locator(".run-list-item").count(), 0);
      await page.locator(".account-menu > summary").click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByRole("link", { name: "Continue with GitHub" }).waitFor();
      assert.equal(mutationTokens[1], "csrf-refreshed");
      const signedOutStreams = streamRequests;
      await page.waitForTimeout(400);
      assert.equal(streamRequests, signedOutStreams);
      await page.getByRole("link", { name: "Continue with GitHub" }).click();
      await page
        .getByRole("button", { name: "Connections", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Connections", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "melange-re", exact: true })
        .waitFor();
      connections = connections.filter(
        (connection) => connection.installationId !== 30,
      );
      for (const stream of streams) stream.write("event: access\ndata: {}\n\n");
      await page
        .getByRole("heading", { name: "melange-re", exact: true })
        .waitFor({ state: "hidden" });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(60);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth),
          width,
        );
      }
      await page.screenshot({
        path: `${screenshotDir}/connections-mobile.png`,
        fullPage: true,
      });
      signedIn = false;
      for (const stream of streams) {
        stream.write("event: auth\ndata: {}\n\n");
        stream.end();
      }
      await page
        .getByText(
          "Your session has expired. Sign in again to continue where you left off.",
          { exact: true },
        )
        .waitFor();
      assert.equal(await page.locator(".run-list-item").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      for (const stream of streams) stream.end();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
