const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HA_BASE_URL = process.env.HA_BASE_URL || "";
const HA_TOKEN = process.env.HA_TOKEN || "";
const HA_SENSOR_ENTITY_ID = process.env.HA_SENSOR_ENTITY_ID || "";
const HA_AC_OUTPUT_ENTITY_ID = process.env.HA_AC_OUTPUT_ENTITY_ID || "";
const DEBUG_HA = String(process.env.DEBUG_HA || "").toLowerCase() === "true";
const POLL_SECONDS = Math.max(5, Number(process.env.POLL_SECONDS || 10));
const COST_RATE_USD_PER_KWH = Number(process.env.COST_RATE_USD_PER_KWH || 0.33);
const HISTORY_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.HISTORY_RETENTION_DAYS || 30)
);

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");

let history = [];
let latestReading = null;
let latestHaDebug = {};
const clients = new Set();

function redactToken(token) {
  if (!token) return "<missing>";
  if (token.length < 12) return "<redacted>";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function debugLogHa(message, extra = null) {
  if (!DEBUG_HA) return;
  const prefix = "[HA DEBUG]";
  if (extra === null) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function purgeOldHistory(records) {
  const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return records.filter((r) => Number(r.timestamp) >= cutoff);
}

async function loadHistory() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const raw = await fsp.readFile(HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      history = [];
      return;
    }
    history = purgeOldHistory(
      parsed.filter(
        (r) => r && Number.isFinite(Number(r.timestamp)) && Number.isFinite(Number(r.watts))
      )
    );
  } catch (err) {
    history = [];
  }
}

async function saveHistory() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(HISTORY_PATH, JSON.stringify(history), "utf8");
}

function pushToClients(payload) {
  const event = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(event);
  }
}

function parseWatts(rawState) {
  const watts = Number(rawState);
  if (!Number.isFinite(watts)) return null;
  return watts;
}

function computeTodaySummary() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const startOfDay = now.getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

  const todayPoints = history
    .filter((p) => p.timestamp >= startOfDay && p.timestamp < endOfDay)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (todayPoints.length === 0) {
    return {
      dayStart: startOfDay,
      kwh: 0,
      costUsd: 0,
      rateUsdPerKwh: COST_RATE_USD_PER_KWH,
      peakWatts: latestReading?.watts ?? 0
    };
  }

  let wattHours = 0;
  for (let i = 1; i < todayPoints.length; i += 1) {
    const prev = todayPoints[i - 1];
    const cur = todayPoints[i];
    const dtHours = (cur.timestamp - prev.timestamp) / (60 * 60 * 1000);
    if (dtHours <= 0) continue;
    const avgWatts = (prev.watts + cur.watts) / 2;
    wattHours += avgWatts * dtHours;
  }

  const kwh = wattHours / 1000;
  const peakWatts = todayPoints.reduce((max, p) => Math.max(max, p.watts), 0);

  return {
    dayStart: startOfDay,
    kwh,
    costUsd: kwh * COST_RATE_USD_PER_KWH,
    rateUsdPerKwh: COST_RATE_USD_PER_KWH,
    peakWatts: Math.max(peakWatts, latestReading?.watts ?? 0)
  };
}

async function fetchSensorWatts(entityId) {
  const endpoint = `${HA_BASE_URL.replace(/\/$/, "")}/api/states/${entityId}`;
  latestHaDebug[entityId] = {
    at: Date.now(),
    endpoint,
    sensor: entityId,
    tokenPreview: redactToken(HA_TOKEN)
  };
  debugLogHa(`Requesting Home Assistant state for ${entityId}`, latestHaDebug[entityId]);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const responseBody = await response.text();
      latestHaDebug[entityId] = {
        ...latestHaDebug[entityId],
        status: response.status,
        bodyPreview: responseBody.slice(0, 500)
      };
      debugLogHa(`Non-OK response for ${entityId}`, latestHaDebug[entityId]);
      return {
        ok: false,
        error: `Home Assistant returned ${response.status} for ${entityId}`,
        status: response.status,
        body: responseBody.slice(0, 500)
      };
    }

    const payload = await response.json();
    const watts = parseWatts(payload?.state);
    if (watts === null) {
      return {
        ok: false,
        error: `Sensor ${entityId} state "${payload?.state}" is not a number`
      };
    }

    return { ok: true, watts };
  } catch (err) {
    latestHaDebug[entityId] = {
      ...latestHaDebug[entityId],
      transportError: err.message || "Unknown transport error"
    };
    debugLogHa(`Transport error for ${entityId}`, latestHaDebug[entityId]);
    return { ok: false, error: err.message || "Unknown Home Assistant error" };
  }
}

async function fetchFromHomeAssistant() {
  if (!HA_BASE_URL || !HA_TOKEN || !HA_SENSOR_ENTITY_ID) {
    return {
      ok: false,
      error:
        "Missing HA_BASE_URL, HA_TOKEN, or HA_SENSOR_ENTITY_ID environment variables"
    };
  }

  const solarResult = await fetchSensorWatts(HA_SENSOR_ENTITY_ID);
  if (!solarResult.ok) {
    return solarResult;
  }

  const reading = {
    timestamp: Date.now(),
    watts: solarResult.watts,
    source: HA_SENSOR_ENTITY_ID
  };

  if (HA_AC_OUTPUT_ENTITY_ID) {
    const acResult = await fetchSensorWatts(HA_AC_OUTPUT_ENTITY_ID);
    if (acResult.ok) {
      reading.acWatts = acResult.watts;
      reading.acSource = HA_AC_OUTPUT_ENTITY_ID;
    } else {
      reading.acError = acResult.error;
    }
  }

  return { ok: true, reading };
}

async function pollAndStore() {
  const result = await fetchFromHomeAssistant();
  if (!result.ok) {
    latestReading = {
      timestamp: Date.now(),
      watts: latestReading?.watts ?? 0,
      source: HA_SENSOR_ENTITY_ID || "unknown",
      error: result.error
    };
    pushToClients({ type: "status", data: latestReading, todaySummary: computeTodaySummary() });
    return;
  }

  latestReading = result.reading;
  history.push(latestReading);
  history = purgeOldHistory(history);

  try {
    await saveHistory();
  } catch (err) {
    latestReading.error = `Failed to write history: ${err.message}`;
  }

  pushToClients({ type: "reading", data: latestReading, todaySummary: computeTodaySummary() });
}

function handleApi(req, res, pathname) {
  if (pathname === "/api/current") {
    sendJson(res, 200, {
      current: latestReading,
      pollSeconds: POLL_SECONDS,
      todaySummary: computeTodaySummary()
    });
    return true;
  }

  if (pathname === "/api/history") {
    sendJson(res, 200, {
      points: history,
      retentionDays: HISTORY_RETENTION_DAYS
    });
    return true;
  }

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      configured: Boolean(HA_BASE_URL && HA_TOKEN && HA_SENSOR_ENTITY_ID),
      acConfigured: Boolean(HA_AC_OUTPUT_ENTITY_ID),
      clients: clients.size
    });
    return true;
  }

  if (pathname === "/api/debug/ha") {
    sendJson(res, 200, {
      debugEnabled: DEBUG_HA,
      latestHaDebug
    });
    return true;
  }

  if (pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write("retry: 3000\n\n");
    clients.add(res);

    if (latestReading) {
      res.write(
        `data: ${JSON.stringify({
          type: "reading",
          data: latestReading,
          todaySummary: computeTodaySummary()
        })}\n\n`
      );
    }

    req.on("close", () => {
      clients.delete(res);
    });
    return true;
  }

  return false;
}

function handleStatic(req, res, pathname) {
  if (pathname === "/") {
    sendFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (pathname === "/app.js") {
    sendFile(res, path.join(PUBLIC_DIR, "app.js"), "application/javascript; charset=utf-8");
    return;
  }

  if (pathname === "/styles.css") {
    sendFile(res, path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8");
    return;
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  const contentTypes = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  };
  if (contentTypes[ext]) {
    sendFile(res, fullPath, contentTypes[ext]);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function main() {
  await loadHistory();
  latestReading = history[history.length - 1] || null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === "GET" && handleApi(req, res, pathname)) return;
    if (req.method === "GET") return handleStatic(req, res, pathname);

    sendJson(res, 405, { error: "Method not allowed" });
  });

  server.listen(PORT, () => {
    console.log(`Solar dashboard is running on http://localhost:${PORT}`);
    if (!HA_BASE_URL || !HA_TOKEN || !HA_SENSOR_ENTITY_ID) {
      console.log("Configure HA_BASE_URL, HA_TOKEN, and HA_SENSOR_ENTITY_ID to enable data.");
    }
  });

  pollAndStore();
  setInterval(pollAndStore, POLL_SECONDS * 1000);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
