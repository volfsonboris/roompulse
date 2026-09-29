import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.js";

const token = () => randomBytes(32).toString("hex");

async function start(dataFile, rateLimit = false) {
  const server = createApp({ dataFile, rateLimit });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function request(app, path, { method = "GET", body, auth, headers = {} } = {}) {
  const response = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

async function fixture(t, rateLimit = false) {
  const folder = mkdtempSync(join(tmpdir(), "roompulse-test-"));
  const dataFile = join(folder, "sessions.json");
  const app = await start(dataFile, rateLimit);
  t.after(async () => { await app.close(); rmSync(folder, { recursive: true }); });
  return { app, dataFile };
}

async function session(app, title = "A better presentation") {
  const result = await request(app, "/api/sessions", { method: "POST", body: { title } });
  assert.equal(result.status, 201);
  return { ...result.data, path: `/api/sessions/${result.data.id}` };
}

test("serves the app and local assets without exposing data or server source", async (t) => {
  const { app } = await fixture(t);
  for (const path of ["/", "/app.js", "/styles.css", `/join/${"a".repeat(24)}`, `/presenter/${"b".repeat(24)}`]) {
    const response = await fetch(app.url + path);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  for (const path of ["/server.js", "/data/sessions.json", "/package.json", "/missing"]) {
    assert.equal((await fetch(app.url + path)).status, 404);
  }
});

test("creates isolated sessions and protects presenter results and closing", async (t) => {
  const { app, dataFile } = await fixture(t);
  const first = await session(app, "  Team update  ");
  const second = await session(app);
  assert.equal(first.presenterToken.length, 64);
  const publicResult = await request(app, first.path);
  assert.deepEqual(publicResult.data, { title: "Team update", closed: false });
  for (const auth of [undefined, "wrong", second.presenterToken]) {
    assert.equal((await request(app, `${first.path}/dashboard`, { auth })).status, 403);
    assert.equal((await request(app, `${first.path}/close`, { method: "POST", auth, body: {} })).status, 403);
  }
  const dashboard = await request(app, `${first.path}/dashboard`, { auth: first.presenterToken });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.responses, 0);
  assert.ok(!readFileSync(dataFile, "utf8").includes(first.presenterToken));
  assert.equal((await request(app, `/api/sessions/${"0".repeat(24)}`)).status, 404);
});

test("tracks latest signals, concurrent audience writes, anonymous feedback and idempotent retries", async (t) => {
  const { app } = await fixture(t);
  const room = await session(app);
  const people = [token(), token(), token()];
  const results = await Promise.all(people.map((participantToken, index) =>
    request(app, `${room.path}/signal`, { method: "POST", body: { participantToken, signal: ["green", "yellow", "red"][index] } })));
  results.forEach((result) => assert.equal(result.status, 200));
  await request(app, `${room.path}/signal`, { method: "POST", body: { participantToken: people[0], signal: "red" } });
  await request(app, `${room.path}/signal`, { method: "POST", body: { participantToken: people[0], signal: "red" } });
  const message = { participantToken: people[0], message: "<script>alert('not HTML')</script> \u{1F44B}", messageId: token() };
  assert.equal((await request(app, `${room.path}/feedback`, { method: "POST", body: message })).status, 200);
  assert.equal((await request(app, `${room.path}/feedback`, { method: "POST", body: message })).status, 200);
  assert.equal((await request(app, `${room.path}/feedback`, { method: "POST", body: { ...message, message: "changed" } })).status, 409);
  const dashboard = (await request(app, `${room.path}/dashboard`, { auth: room.presenterToken })).data;
  assert.deepEqual(dashboard.counts, { green: 0, yellow: 1, red: 2 });
  assert.equal(dashboard.participants, 3);
  assert.equal(dashboard.responses, 3);
  assert.equal(dashboard.feedback.length, 1);
  assert.equal(dashboard.feedback[0].message, message.message);
  assert.deepEqual(Object.keys(dashboard.feedback[0]).sort(), ["createdAt", "id", "message"]);
  const own = (await request(app, `${room.path}/state`, { auth: people[0] })).data;
  assert.deepEqual(own, { title: room.title ?? "A better presentation", closed: false, signal: "red" });
  assert.equal((await request(app, `${room.path}/state`)).status, 400);
  assert.equal((await request(app, `${room.path}/state`, { auth: token() })).data.signal, null);
});

test("counts feedback-only participants separately from signals and isolates rooms", async (t) => {
  const { app } = await fixture(t);
  const room = await session(app);
  const other = await session(app);
  await request(app, `${room.path}/feedback`, {
    method: "POST", body: { participantToken: token(), messageId: token(), message: "Could you share the slides?" }
  });
  const snapshot = (await request(app, `${room.path}/dashboard`, { auth: room.presenterToken })).data;
  assert.equal(snapshot.participants, 1);
  assert.equal(snapshot.responses, 0);
  assert.equal(snapshot.feedback.length, 1);
  assert.equal((await request(app, `${other.path}/dashboard`, { auth: other.presenterToken })).data.participants, 0);
});

test("validates input, blocks cross-origin writes and limits feedback", async (t) => {
  const { app } = await fixture(t);
  for (const title of [" ", "a".repeat(101), 123, null]) {
    assert.equal((await request(app, "/api/sessions", { method: "POST", body: { title } })).status, 400);
  }
  assert.equal((await request(app, "/api/sessions", { method: "POST", body: { title: "x" }, headers: { Origin: "https://other.test" } })).status, 403);
  const malformed = await fetch(`${app.url}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  await malformed.text();
  const noJson = await fetch(`${app.url}/api/sessions`, { method: "POST", body: "{}" });
  assert.equal(noJson.status, 415);
  await noJson.text();
  const tooLarge = await request(app, "/api/sessions", { method: "POST", body: { title: "x".repeat(9000) } });
  assert.equal(tooLarge.status, 413);
  const room = await session(app);
  const participantToken = token();
  for (const body of [{ participantToken, signal: "blue" }, { participantToken: "bad", signal: "green" }]) {
    assert.equal((await request(app, `${room.path}/signal`, { method: "POST", body })).status, 400);
  }
  for (const message of [" ", "a".repeat(1001), 42]) {
    assert.equal((await request(app, `${room.path}/feedback`, { method: "POST", body: { participantToken, messageId: token(), message } })).status, 400);
  }
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await request(app, `${room.path}/feedback`, { method: "POST", body: { participantToken, messageId: token(), message: `Thought ${i}` } })).status, 200);
  }
  assert.equal((await request(app, `${room.path}/feedback`, { method: "POST", body: { participantToken, messageId: token(), message: "One too many" } })).status, 409);
});

test("persists data across server restart and permanently closes sessions", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "roompulse-restart-"));
  const dataFile = join(folder, "sessions.json");
  let app = await start(dataFile);
  t.after(async () => { await app.close(); rmSync(folder, { recursive: true }); });
  const room = await session(app);
  const participantToken = token();
  await request(app, `${room.path}/signal`, { method: "POST", body: { participantToken, signal: "green" } });
  await app.close();
  app = await start(dataFile);
  assert.equal((await request(app, `${room.path}/dashboard`, { auth: room.presenterToken })).data.counts.green, 1);
  assert.equal((await request(app, `${room.path}/close`, { method: "POST", auth: room.presenterToken, body: {} })).status, 200);
  for (const [action, body] of [
    ["signal", { participantToken, signal: "yellow" }],
    ["feedback", { participantToken, message: "Late", messageId: token() }]
  ]) {
    assert.equal((await request(app, `${room.path}/${action}`, { method: "POST", body })).status, 409);
  }
  await app.close();
  app = await start(dataFile);
  assert.equal((await request(app, room.path)).data.closed, true);
  const final = (await request(app, `${room.path}/dashboard`, { auth: room.presenterToken })).data;
  assert.equal(final.counts.green, 1);
  assert.equal(final.closed, true);
});

test("refuses corrupted storage rather than discarding existing sessions", () => {
  const folder = mkdtempSync(join(tmpdir(), "roompulse-corrupt-"));
  const dataFile = join(folder, "sessions.json");
  try {
    writeFileSync(dataFile, "not JSON");
    assert.throws(() => createApp({ dataFile }));
    assert.equal(readFileSync(dataFile, "utf8"), "not JSON");
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test("rate limits session creation", async (t) => {
  const { app } = await fixture(t, true);
  for (let i = 0; i < 10; i += 1) await session(app);
  assert.equal((await request(app, "/api/sessions", { method: "POST", body: { title: "Too many" } })).status, 429);
});
