/**
 * MQTT → MongoDB Atlas bridge (method B).
 * Run: copy .env.example to .env, fill values, then npm install && npm start
 */
require("dotenv").config();
const mqtt = require("mqtt");
const { MongoClient } = require("mongodb");

const MQTT_URL = process.env.MQTT_URL;
const MQTT_USER = process.env.MQTT_USER;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_TOPIC = process.env.MQTT_TOPIC || "greenhouse/telemetry";
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "greenhouse";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "readings";

if (!MQTT_URL || !MONGODB_URI) {
  console.error("Missing MQTT_URL or MONGODB_URI in .env");
  process.exit(1);
}

let mongoClient;
let collection;

async function connectMongo() {
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  collection = mongoClient.db(MONGODB_DB).collection(MONGODB_COLLECTION);
  await collection.createIndex({ ts: -1 });
  await collection.createIndex({ deviceId: 1, ts: -1 });
  console.log(`MongoDB: ${MONGODB_DB}.${MONGODB_COLLECTION}`);
}

const mqttOpts = {
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  reconnectPeriod: 5000,
};

const client = mqtt.connect(MQTT_URL, mqttOpts);

client.on("connect", () => {
  console.log("MQTT connected, subscribing:", MQTT_TOPIC);
  client.subscribe(MQTT_TOPIC, { qos: 1 }, (err) => {
    if (err) console.error("Subscribe error:", err);
  });
});

client.on("message", async (topic, payload) => {
  try {
    const text = payload.toString();
    const doc = JSON.parse(text);
    doc.receivedAt = new Date();
    if (doc.ts == null && doc.time == null) {
      doc.ts = Date.now();
    }
    await collection.insertOne(doc);
    console.log("Stored:", doc.deviceId ?? "?", doc.t, doc.h);
  } catch (e) {
    console.error("Message error:", e.message, payload.toString().slice(0, 200));
  }
});

client.on("error", (err) => console.error("MQTT error:", err));

async function main() {
  await connectMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.on("SIGINT", async () => {
  client.end(true);
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
