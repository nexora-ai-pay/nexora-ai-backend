const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const file = path.join(dataDir, "nexora.json");
const adapter = new JSONFile(file);

const defaultData = {
  users: [],
  deposits: [],
  withdrawals: []
};

const db = new Low(adapter, defaultData);

async function initDatabase() {
  await db.read();

  db.data ||= defaultData;
  db.data.users ||= [];
  db.data.deposits ||= [];
  db.data.withdrawals ||= [];

  await db.write();

  console.log("Nexora AI database initialized successfully.");
}

module.exports = {
  db,
  initDatabase
};
