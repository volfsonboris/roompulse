import http from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const signals = new Set(["green", "yellow", "red"]);
const tokenPattern = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });

function readStore(path) {
  if (!existsSync(path)) return { version: 1, sessions: {} };
  const store = JSON.parse(readFileSync(path, "utf8"));
  if (store.version !== 1 || !store.sessions || typeof store.sessions !== "object" || Array.isArray(store.sessions)) {
    throw new Error("Invalid session data file. Restore it from a backup before starting.");
  }
  for (const session of Object.values(store.sessions)) {
    if (!session || typeof session.title !== "string" || !tokenPattern.test(session.presenterHash) ||
        typeof session.closed !== "boolean" || !session.participants ||
        typeof session.participants !== "object" || Array.isArray(session.participants) ||
        !Array.isArray(session.feedback)) {
      throw new Error("Invalid saved session. Restore the data file from a backup before starting.");
    }
  }
  return store;
}

async function readBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw fail(415, "Please send JSON data.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw fail(413, "That request is too large.");
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "The request contains invalid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw fail(400, "Expected a JSON object.");
  return data;
}

function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw fail(400, `${label} must contain between 1 and ${max} characters.`);
  }
  return value.trim();
}

export function createApp({ dataFile = join(root, "data", "sessions.json"), rateLimit = true } = {}) {
  let store = readStore(dataFile);
  const rates = new Map();
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
  ]);

  function save(next) {
    mkdirSync(dirname(dataFile), { recursive: true });
    const temporary = `${dataFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, dataFile);
    store = next;
  }

  function limit(request, isCreate) {
    if (!rateLimit) return;
    const now = Date.now();
    for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
    const key = `${request.socket.remoteAddress}:${isCreate ? "create" : "write"}`;
    if (!rates.has(key)) {
      if (rates.size >= 10000) throw fail(429, "The server is busy. Please try again in a minute.");
      rates.set(key, { count: 0, until: now + 60_000 });
    }
    const rate = rates.get(key);
    rate.count += 1;
    // A room often shares one public IP, so audience writes have a generous limit.
    if (rate.count > (isCreate ? 10 : 3000)) throw fail(429, "Too many requests. Please try again in a minute.");
  }

  function authorize(request, session) {
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!tokenPattern.test(token) ||
        !timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(session.presenterHash, "hex"))) {
      throw fail(403, "This presenter link is invalid. Use the original private presenter link.");
    }
  }

  function summarize(session) {
    const participants = Object.values(session.participants);
    const counts = { green: 0, yellow: 0, red: 0 };
    for (const participant of participants) if (participant.signal) counts[participant.signal] += 1;
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      closed: session.closed,
      participants: participants.length,
      responses: counts.green + counts.yellow + counts.red,
      counts,
      feedback: session.feedback.map(({ id, message, createdAt }) => ({ id, message, createdAt }))
    };
  }

  return http.createServer({ requestTimeout: 10000, headersTimeout: 10000 }, async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader("Cache-Control", "no-store");

    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };

    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;
      if (request.method === "GET" && !path.startsWith("/api/")) {
        const asset = /^\/(?:presenter|join)\/[a-f0-9]{24}\/?$/.test(path) ? assets.get("/") : assets.get(path);
        if (!asset) throw fail(404, "This page could not be found.");
        response.writeHead(200, { "Content-Type": asset[1] });
        response.end(readFileSync(join(root, "public", asset[0])));
        return;
      }

      if (request.method === "POST") {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw fail(403, "Cross-site requests are not allowed.");
        limit(request, path === "/api/sessions");
      }

      if (request.method === "POST" && path === "/api/sessions") {
        const body = await readBody(request);
        const title = text(body.title, "Presentation title", 100);
        if (Object.keys(store.sessions).length >= 500) throw fail(409, "This server has reached its 500-session limit. Contact the host.");
        const id = randomBytes(12).toString("hex");
        const presenterToken = randomBytes(32).toString("hex");
        const next = structuredClone(store);
        next.sessions[id] = {
          id, title, presenterHash: hash(presenterToken), createdAt: new Date().toISOString(),
          closed: false, participants: {}, feedback: []
        };
        save(next);
        json(201, { id, presenterToken });
        return;
      }

      const route = path.match(/^\/api\/sessions\/([a-f0-9]{24})(?:\/(dashboard|state|signal|feedback|close))?$/);
      if (!route) throw fail(404, "This endpoint could not be found.");
      const [, id, action] = route;
      const session = store.sessions[id];
      if (!session) throw fail(404, "This presentation was not found. Please check the link with your presenter.");

      if (request.method === "GET" && !action) {
        json(200, { title: session.title, closed: session.closed });
        return;
      }
      if (request.method === "GET" && action === "dashboard") {
        authorize(request, session);
        json(200, summarize(session));
        return;
      }
      if (request.method === "GET" && action === "state") {
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (!tokenPattern.test(token)) throw fail(400, "Your audience ID is invalid. Please reload the page.");
        json(200, {
          title: session.title, closed: session.closed,
          signal: session.participants[hash(token)]?.signal ?? null
        });
        return;
      }
      if (request.method !== "POST" || !["signal", "feedback", "close"].includes(action)) {
        throw fail(405, "This request method is not supported.");
      }
      if (action === "close") authorize(request, session);
      const body = await readBody(request);

      // Read the latest store after awaiting the body so overlapping writes cannot overwrite each other.
      const current = store.sessions[id];
      if (action !== "close" && current.closed) throw fail(409, "This presentation has ended. Thanks for taking part.");
      const next = structuredClone(store);
      const updated = next.sessions[id];
      if (action === "close") {
        updated.closed = true;
      } else {
        if (typeof body.participantToken !== "string" || !tokenPattern.test(body.participantToken)) {
          throw fail(400, "Your audience ID is invalid. Please reload the page.");
        }
        const participantId = hash(body.participantToken);
        if (!Object.hasOwn(updated.participants, participantId) && Object.keys(updated.participants).length >= 1000) {
          throw fail(409, "This presentation has reached its 1,000-participant limit.");
        }
        const participant = updated.participants[participantId] ?? { signal: null, feedbackCount: 0 };
        if (action === "signal") {
          if (!signals.has(body.signal)) throw fail(400, "Choose green, yellow, or red.");
          participant.signal = body.signal;
        } else {
          const message = text(body.message, "Feedback", 1000);
          if (typeof body.messageId !== "string" || !tokenPattern.test(body.messageId)) throw fail(400, "Feedback ID is invalid.");
          const duplicate = updated.feedback.find((item) => item.id === body.messageId);
          if (duplicate) {
            if (duplicate.participantId !== participantId || duplicate.message !== message) {
              throw fail(409, "This feedback ID was already used. Reload the page before trying again.");
            }
            json(200, { ok: true });
            return;
          }
          if (participant.feedbackCount >= 20 || updated.feedback.length >= 2000) {
            throw fail(409, "The feedback limit for this session has been reached.");
          }
          participant.feedbackCount += 1;
          updated.feedback.push({ id: body.messageId, participantId, message, createdAt: new Date().toISOString() });
        }
        updated.participants[participantId] = participant;
      }
      save(next);
      json(200, { ok: true });
    } catch (error) {
      if (!error.status) console.error("Request failed:", error);
      if (!response.headersSent) json(error.status ?? 500, error.status
        ? { error: error.message }
        : { error: "The server could not save or load your request. Please try again." });
      else response.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createApp({ dataFile: process.env.DATA_FILE ? resolve(process.env.DATA_FILE) : undefined });
  server.on("error", (error) => {
    console.error(`Unable to start Presentation Feedback: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Presentation Feedback is running at http://localhost:${server.address().port}`);
    console.log("For audience access, open this app using this computer's network address or a deployed HTTPS URL.");
  });
}
