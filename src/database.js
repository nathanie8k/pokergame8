// JSON-file based persistence for player accounts and admin settings.
// Uses a simple in-memory cache and serializes writes to avoid corruption.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

let dataCache = null;
let writeChain = Promise.resolve();

function defaultData() {
  return {
    players: {},            // name -> { id, name, points, created }
    adminPassword: 'admin123',
    settings: { startingStack: 1000 },
  };
}

async function loadData() {
  if (dataCache) return dataCache;
  try {
    const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
    dataCache = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      dataCache = defaultData();
    } else {
      throw err;
    }
  }
  // Backfill any missing keys
  if (!dataCache.players)        dataCache.players = {};
  if (!dataCache.adminPassword)  dataCache.adminPassword = 'admin123';
  if (!dataCache.settings)       dataCache.settings = { startingStack: 1000 };
  return dataCache;
}

async function saveData() {
  const snapshot = JSON.stringify(dataCache, null, 2);
  writeChain = writeChain.then(() =>
    fs.promises.writeFile(DATA_FILE, snapshot, 'utf8')
  );
  await writeChain;
}

async function getPlayer(name) {
  if (!name) return null;
  const data = await loadData();
  return data.players[name] || null;
}

async function getOrCreatePlayer(name, opts = {}) {
  const data = await loadData();
  const existing = data.players[name];
  if (existing) return existing;
  const player = {
    id: opts.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) + '-' + crypto.randomBytes(2).toString('hex'),
    name,
    points: typeof opts.points === 'number' ? opts.points : (data.settings.startingStack || 1000),
    created: Date.now(),
  };
  data.players[name] = player;
  await saveData();
  return player;
}

async function setPoints(name, points) {
  const data = await loadData();
  if (!data.players[name]) return null;
  data.players[name].points = Math.max(0, Math.floor(points));
  data.players[name].updated = Date.now();
  await saveData();
  return data.players[name];
}

async function addPoints(name, delta) {
  const data = await loadData();
  if (!data.players[name]) return null;
  const current = data.players[name].points || 0;
  data.players[name].points = Math.max(0, current + Math.floor(delta));
  data.players[name].updated = Date.now();
  await saveData();
  return data.players[name];
}

async function getAllPlayers() {
  const data = await loadData();
  return Object.values(data.players);
}

async function deletePlayer(name) {
  const data = await loadData();
  if (!data.players[name]) return false;
  delete data.players[name];
  await saveData();
  return true;
}

async function checkAdminPassword(password) {
  const data = await loadData();
  return data.adminPassword === password;
}

async function setAdminPassword(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    throw new Error('Password too short');
  }
  const data = await loadData();
  data.adminPassword = newPassword;
  await saveData();
  return data.adminPassword;
}

async function getStartingStack() {
  const data = await loadData();
  return data.settings.startingStack || 1000;
}

async function setStartingStack(amount) {
  const data = await loadData();
  data.settings.startingStack = Math.max(1, Math.floor(amount));
  await saveData();
  return data.settings.startingStack;
}

module.exports = {
  loadData,
  saveData,
  getPlayer,
  getOrCreatePlayer,
  setPoints,
  addPoints,
  getAllPlayers,
  deletePlayer,
  checkAdminPassword,
  setAdminPassword,
  getStartingStack,
  setStartingStack,
};
