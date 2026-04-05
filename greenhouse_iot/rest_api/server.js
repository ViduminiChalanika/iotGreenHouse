/**
 * Method A: ESP32 POST /api/telemetry → MongoDB Atlas.
 * Run: copy .env.example to .env, npm install, npm start
 * Deploy: Railway, Render, Fly.io, etc. (set env vars there)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "greenhouse";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "readings";
const MONGODB_CONTROLS_COLLECTION =
  process.env.MONGODB_CONTROLS_COLLECTION || "device_controls";
const API_KEY = process.env.API_KEY;

if (!MONGODB_URI || !API_KEY) {
  console.error("Set MONGODB_URI and API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

let mongoClient;
let collection;
let controlsCollection;

function defaultControls(deviceId) {
  return {
    deviceId,
    autoFan: true,
    autoPump: true,
    autoLight: false,
    fanManual: false,
    pumpManual: false,
    lightManual: false,
    fanOverride: null,
    pumpOverride: null,
    lightOverride: null,
  };
}

/** Plain JSON only — no Mongo _id/ObjectId (ESP32 ArduinoJson rejects extended types). */
function toControlJson(deviceId, doc) {
  const d = defaultControls(deviceId);
  if (!doc) return d;
  return {
    deviceId,
    autoFan: doc.autoFan !== undefined ? !!doc.autoFan : d.autoFan,
    autoPump: doc.autoPump !== undefined ? !!doc.autoPump : d.autoPump,
    autoLight: doc.autoLight !== undefined ? !!doc.autoLight : d.autoLight,
    fanManual: doc.fanManual !== undefined ? !!doc.fanManual : d.fanManual,
    pumpManual: doc.pumpManual !== undefined ? !!doc.pumpManual : d.pumpManual,
    lightManual: doc.lightManual !== undefined ? !!doc.lightManual : d.lightManual,
    fanOverride: doc.fanOverride === null || doc.fanOverride === undefined ? null : !!doc.fanOverride,
    pumpOverride: doc.pumpOverride === null || doc.pumpOverride === undefined ? null : !!doc.pumpOverride,
    lightOverride: doc.lightOverride === null || doc.lightOverride === undefined ? null : !!doc.lightOverride,
  };
}

async function connectMongo() {
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  collection = mongoClient.db(MONGODB_DB).collection(MONGODB_COLLECTION);
  controlsCollection = mongoClient.db(MONGODB_DB).collection(MONGODB_CONTROLS_COLLECTION);
  await collection.createIndex({ ts: -1 });
  await collection.createIndex({ deviceId: 1, ts: -1 });
  await controlsCollection.createIndex({ deviceId: 1 }, { unique: true });
  console.log(`MongoDB: ${MONGODB_DB}.${MONGODB_COLLECTION}`);
  console.log(`MongoDB controls: ${MONGODB_DB}.${MONGODB_CONTROLS_COLLECTION}`);
}

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"];
  if (k !== API_KEY) {
    console.warn(
      "[telemetry] 401 — x-api-key does not match API_KEY in .env (check ESP32 secrets.h)"
    );
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/telemetry", requireApiKey, async (req, res) => {
  try {
    const doc = { ...req.body, receivedAt: new Date() };
    if (doc.ts == null) doc.ts = Date.now();
    const r = await collection.insertOne(doc);
    console.log(
      "[telemetry] inserted id=%s deviceId=%s",
      r.insertedId,
      doc.deviceId ?? "?"
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/readings", requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const deviceId = req.query.deviceId;
    const q = deviceId ? { deviceId } : {};
    const rows = await collection.find(q).sort({ ts: -1 }).limit(limit).toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Latest control document for ESP + dashboard (manual / auto / overrides). */
app.get("/api/control/:deviceId", requireApiKey, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const cur = await controlsCollection.findOne({ deviceId });
    res.json(toControlJson(deviceId, cur));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/control/:deviceId", requireApiKey, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const patch = req.body && typeof req.body === "object" ? req.body : {};
    const cur = await controlsCollection.findOne({ deviceId });
    let next = toControlJson(deviceId, cur);

    if (patch.autoFan !== undefined) {
      next.autoFan = !!patch.autoFan;
      next.fanOverride = null;
    }
    if (patch.autoPump !== undefined) {
      next.autoPump = !!patch.autoPump;
      next.pumpOverride = null;
    }
    if (patch.autoLight !== undefined) {
      next.autoLight = !!patch.autoLight;
      next.lightOverride = null;
    }
    if (typeof patch.fanManual === "boolean") next.fanManual = patch.fanManual;
    if (typeof patch.pumpManual === "boolean") next.pumpManual = patch.pumpManual;
    if (typeof patch.lightManual === "boolean") next.lightManual = patch.lightManual;
    if (patch.fanOverride !== undefined) {
      next.fanOverride = patch.fanOverride === null ? null : !!patch.fanOverride;
    }
    if (patch.pumpOverride !== undefined) {
      next.pumpOverride = patch.pumpOverride === null ? null : !!patch.pumpOverride;
    }
    if (patch.lightOverride !== undefined) {
      next.lightOverride = patch.lightOverride === null ? null : !!patch.lightOverride;
    }

    await controlsCollection.updateOne({ deviceId }, { $set: next }, { upsert: true });
    res.json(next);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Explicit on/off (easier than toggle). Body: { fan?: boolean, pump?: boolean, light?: boolean } */
app.post("/api/control/:deviceId/command", requireApiKey, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { fan, pump, light } = req.body || {};
    const cur = await controlsCollection.findOne({ deviceId });
    const base = toControlJson(deviceId, cur);

    if (typeof fan === "boolean") {
      if (base.autoFan) base.fanOverride = fan;
      else base.fanManual = fan;
    }
    if (typeof pump === "boolean") {
      if (base.autoPump) base.pumpOverride = pump;
      else base.pumpManual = pump;
    }
    if (typeof light === "boolean") {
      if (base.autoLight) base.lightOverride = light;
      else base.lightManual = light;
    }

    await controlsCollection.updateOne({ deviceId }, { $set: base }, { upsert: true });
    res.json(base);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Toggle fan, pump, or lights: if auto is on, sets override; if manual mode, flips manual target. */
app.post("/api/control/:deviceId/toggle", requireApiKey, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const target = req.body?.target;
    if (target !== "fan" && target !== "pump" && target !== "light") {
      return res.status(400).json({ error: "body.target must be 'fan', 'pump', or 'light'" });
    }

    const latest = await collection.findOne({ deviceId }, { sort: { ts: -1 } });
    const cur = await controlsCollection.findOne({ deviceId });
    const base = toControlJson(deviceId, cur);

    if (target === "fan") {
      const fanOn = latest?.fanOn === true;
      if (base.autoFan) base.fanOverride = !fanOn;
      else base.fanManual = !fanOn;
    } else if (target === "pump") {
      const pumpOn = latest?.pumpOn === true;
      if (base.autoPump) base.pumpOverride = !pumpOn;
      else base.pumpManual = !pumpOn;
    } else {
      const lightOn = latest?.lightOn === true;
      if (base.autoLight) base.lightOverride = !lightOn;
      else base.lightManual = !lightOn;
    }

    await controlsCollection.updateOne({ deviceId }, { $set: base }, { upsert: true });
    res.json(base);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const dashboardDist = path.join(__dirname, "..", "dashboard", "dist");
if (fs.existsSync(path.join(dashboardDist, "index.html"))) {
  app.use(express.static(dashboardDist));
  console.log("Serving dashboard from", dashboardDist);
}

connectMongo()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Listening on http://0.0.0.0:${PORT} (LAN: http://<this-PC-IPv4>:${PORT})`);
    });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

process.on("SIGINT", async () => {
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
