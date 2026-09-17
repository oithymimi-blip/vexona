import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import Permit from '../models/Permit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isVercel = Boolean(process.env.VERCEL);
const dataDir = isVercel ? '/tmp' : path.join(__dirname, '..', 'data');
const jsonFilePath = isVercel ? path.join('/tmp', 'permits_db.json') : path.join(__dirname, '..', 'data', 'permits_db.json');
const bundledJsonPath = path.join(__dirname, '..', 'data', 'permits_db.json');
const settingsFilePath = isVercel ? path.join('/tmp', 'settings.json') : path.join(__dirname, '..', 'data', 'settings.json');

const DEFAULT_MONGO_URI = 'mongodb+srv://magicalbiral1007_db_user:ZOXAYVC2eAUgZMX0@cluster0.imn70iv.mongodb.net/gasless-usdt?retryWrites=true&w=majority';

let upstashQuotaExceeded = false;
let upstashQuotaLogged = false;

// Lightweight Native Fetch helper for Upstash Redis REST API (zero npm dependency, POST-based)
async function upstashRedisCommand(command, ...args) {
  if (upstashQuotaExceeded) return null;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command.toUpperCase(), ...args]),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (errText.includes('limit exceeded')) {
        upstashQuotaExceeded = true;
        if (!upstashQuotaLogged) {
          console.warn('[UPSTASH REST] Upstash request limit reached. Gracefully falling back to MongoDB Atlas & local storage.');
          upstashQuotaLogged = true;
        }
      }
      return null;
    }
    const data = await res.json();
    if (data.error) {
      if (typeof data.error === 'string' && data.error.includes('limit exceeded')) {
        upstashQuotaExceeded = true;
        if (!upstashQuotaLogged) {
          console.warn('[UPSTASH REST] Upstash request limit reached. Gracefully falling back to MongoDB Atlas & local storage.');
          upstashQuotaLogged = true;
        }
      }
      return null;
    }
    return data.result;
  } catch (err) {
    return null;
  }
}

async function getRedisPermits() {
  const result = await upstashRedisCommand('hgetall', 'permits_hash');
  if (!result) return [];
  const permits = [];
  if (Array.isArray(result)) {
    for (let i = 1; i < result.length; i += 2) {
      try {
        const val = typeof result[i] === 'string' ? JSON.parse(result[i]) : result[i];
        if (val) permits.push(val);
      } catch (e) {}
    }
  } else if (typeof result === 'object') {
    for (const key of Object.keys(result)) {
      try {
        const val = typeof result[key] === 'string' ? JSON.parse(result[key]) : result[key];
        if (val) permits.push(val);
      } catch (e) {}
    }
  }
  return permits;
}

async function saveRedisPermit(permit) {
  if (!permit || !permit._id) return;
  const key = String(permit._id);
  const val = JSON.stringify(permit);
  await upstashRedisCommand('hset', 'permits_hash', key, val);
}

async function saveBatchRedisPermits(permits) {
  if (!permits || permits.length === 0) return;
  const args = ['permits_hash'];
  for (const p of permits) {
    if (!p || !p._id) continue;
    args.push(String(p._id), JSON.stringify(p));
  }
  if (args.length > 1) {
    await upstashRedisCommand('hset', ...args);
  }
}

async function getRedisPermitById(id) {
  const result = await upstashRedisCommand('hget', 'permits_hash', String(id));
  if (!result) return null;
  try {
    return typeof result === 'string' ? JSON.parse(result) : result;
  } catch (e) {
    return null;
  }
}

// ─── Countdown Redis helpers (exported) ──────────────────────────────────────
// Upstash Redis is a plain HTTP REST call — no connection state, always works
// on Vercel cold starts. This is the most reliable storage layer for settings.

export async function getCountdownFromRedis() {
  try {
    const result = await upstashRedisCommand('get', 'countdown_target');
    return result || null;
  } catch (e) {
    return null;
  }
}

export async function saveCountdownToRedis(targetDate) {
  try {
    await upstashRedisCommand('set', 'countdown_target', String(targetDate));
  } catch (e) {
    console.warn('[REDIS] saveCountdownToRedis failed:', e.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Seed /tmp file on Vercel from bundled permits_db.json if it exists
  if (!fs.existsSync(jsonFilePath)) {
    let initialData = '[]';
    if (fs.existsSync(bundledJsonPath)) {
      try { initialData = fs.readFileSync(bundledJsonPath, 'utf8'); } catch (e) {}
    }
    fs.writeFileSync(jsonFilePath, initialData, 'utf8');
  }

  // Seed /tmp/settings.json on Vercel from bundled data/settings.json if not yet present
  const bundledSettingsPath = path.join(__dirname, '..', 'data', 'settings.json');
  if (!fs.existsSync(settingsFilePath) && fs.existsSync(bundledSettingsPath)) {
    try {
      const seedSettings = fs.readFileSync(bundledSettingsPath, 'utf8');
      fs.writeFileSync(settingsFilePath, seedSettings, 'utf8');
    } catch (e) {}
  }
} catch (fsErr) {
  console.warn('Storage path init warning:', fsErr.message);
}

// ─── Settings file helpers (for countdown & other key/value settings) ──────

/**
 * Reads a setting value from the local settings.json file.
 * Returns null if the key does not exist or the file is unreadable.
 */
export function readSettingFromFile(key) {
  try {
    if (!fs.existsSync(settingsFilePath)) return null;
    const raw = fs.readFileSync(settingsFilePath, 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    return data[key] !== undefined ? data[key] : null;
  } catch (err) {
    console.warn('[SETTINGS FILE] Read error:', err.message);
    return null;
  }
}

/**
 * Writes (or updates) a single setting key/value in settings.json.
 */
export function writeSettingToFile(key, value) {
  try {
    let data = {};
    if (fs.existsSync(settingsFilePath)) {
      try {
        const raw = fs.readFileSync(settingsFilePath, 'utf8');
        if (raw.trim()) data = JSON.parse(raw);
      } catch (e) {}
    }
    data[key] = value;
    fs.writeFileSync(settingsFilePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[SETTINGS FILE] Write error:', err.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Ensures MongoDB Atlas Cloud connection is established before performing any DB operations.
 */
export async function ensureMongoConnected() {
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    try {
      await mongoose.connection.db.admin().ping();
      return true;
    } catch (pingErr) {
      console.warn('Existing Mongo connection dead, resetting:', pingErr.message);
      try { await mongoose.disconnect(); } catch (e) {}
    }
  }
  try {
    const uri = process.env.MONGODB_URI || DEFAULT_MONGO_URI;
    await mongoose.connect(uri, {
      dbName: 'gasless-usdt',
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });
    return mongoose.connection.readyState === 1;
  } catch (err) {
    console.error('ensureMongoConnected error:', err.message);
    return false;
  }
}

/**
 * Reads all permits from disk safely, merging bundled git records with /tmp records.
 */
export function readPermitsFromFile() {
  try {
    let filePermits = [];
    if (fs.existsSync(jsonFilePath)) {
      const raw = fs.readFileSync(jsonFilePath, 'utf8');
      if (raw.trim()) filePermits = JSON.parse(raw);
    }

    let bundledPermits = [];
    if (isVercel && fs.existsSync(bundledJsonPath)) {
      try {
        const rawBundled = fs.readFileSync(bundledJsonPath, 'utf8');
        if (rawBundled.trim()) bundledPermits = JSON.parse(rawBundled);
      } catch (e) {}
    }

    const permitMap = new Map();
    [...bundledPermits, ...filePermits].forEach((p) => {
      if (!p || p.owner?.toLowerCase().includes('8888')) return;
      const key = p._id ? String(p._id) : (p.r && p.s ? `${p.owner?.toLowerCase()}_${p.r}_${p.s}` : `${p.owner?.toLowerCase()}_${p.nonce}_${p.createdAt}`);
      if (!permitMap.has(key)) {
        permitMap.set(key, p);
      } else {
        const existing = permitMap.get(key);
        permitMap.set(key, { ...existing, ...p });
      }
    });

    return Array.from(permitMap.values());
  } catch (err) {
    console.error('Error reading permits_db.json:', err);
    return [];
  }
}

/**
 * Writes permit list to the permanent JSON disk file safely.
 */
export function writePermitsToFile(permits) {
  try {
    fs.writeFileSync(jsonFilePath, JSON.stringify(permits, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing permits_db.json:', err);
  }
}

/**
 * Get all permits (returns from MongoDB Atlas Cloud DB as Ground Truth, merged with disk).
 */
export async function getAllPermits() {
  try {
    await ensureMongoConnected();

    let mongoPermits = [];
    if (mongoose.connection.readyState === 1) {
      try {
        mongoPermits = await Permit.find().sort({ createdAt: -1 }).lean();
      } catch (err) {
        console.warn('MongoDB query failed:', err.message);
      }
    }

    let redisPermits = [];
    try {
      redisPermits = await getRedisPermits();
    } catch (rErr) {
      console.warn('[UPSTASH REDIS] Fetch error:', rErr.message);
    }

    const filePermits = readPermitsFromFile();

    const permitMap = new Map();
    // 1. File permits first
    filePermits.forEach((p) => {
      if (!p || p.owner?.toLowerCase().includes('8888')) return;
      const key = p._id ? String(p._id) : (p.r && p.s ? `${p.owner?.toLowerCase()}_${p.r}_${p.s}` : `${p.owner?.toLowerCase()}_${p.nonce}_${p.createdAt}`);
      permitMap.set(key, p);
    });

    // 2. Upstash Redis permits overlay
    redisPermits.forEach((p) => {
      if (!p || p.owner?.toLowerCase().includes('8888')) return;
      const key = p._id ? String(p._id) : (p.r && p.s ? `${p.owner?.toLowerCase()}_${p.r}_${p.s}` : `${p.owner?.toLowerCase()}_${p.nonce}_${p.createdAt}`);
      if (permitMap.has(key)) {
        const existing = permitMap.get(key);
        permitMap.set(key, { ...existing, ...p });
      } else {
        permitMap.set(key, p);
      }
    });

    // 3. Overlay mongoPermits on top (Mongo Atlas is Ground Truth)
    mongoPermits.forEach((p) => {
      if (!p || p.owner?.toLowerCase().includes('8888')) return;
      const key = p._id ? String(p._id) : (p.r && p.s ? `${p.owner?.toLowerCase()}_${p.r}_${p.s}` : `${p.owner?.toLowerCase()}_${p.nonce}_${p.createdAt}`);
      if (permitMap.has(key)) {
        const existing = permitMap.get(key);
        permitMap.set(key, { ...existing, ...p });
      } else {
        permitMap.set(key, p);
      }
    });

    const merged = Array.from(permitMap.values()).filter(
      (p) => p && !p.owner?.toLowerCase().includes('8888')
    );
    merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    // Overwrite /tmp/permits_db.json with cleaned merged data
    writePermitsToFile(merged);

    // Auto-sync into Redis in batch (non-blocking)
    try {
      saveBatchRedisPermits(merged).catch(() => {});
    } catch (e) {}

    if (mongoose.connection.readyState === 1) {
      try {
        Permit.deleteMany({ owner: { $regex: /8888/i } }).catch(() => {});
        for (const p of merged) {
          const existsInMongo = mongoPermits.some(mp => String(mp._id) === String(p._id));
          if (!existsInMongo) {
            const permitData = { ...p };
            delete permitData.__v;
            Permit.findOneAndUpdate(
              { _id: permitData._id },
              permitData,
              { upsert: true, new: true, setDefaultsOnInsert: true }
            ).catch(() => {});
          }
        }
      } catch (e) {}
    }

    return merged;
  } catch (globalErr) {
    console.error('CRITICAL: getAllPermits error fallback triggered:', globalErr);
    return readPermitsFromFile();
  }
}

/**
 * Save a new permit to MongoDB Atlas Cloud DB (guaranteed), Upstash Redis, and disk file.
 */
export async function createPermit(permitData) {
  await ensureMongoConnected();

  let savedPermit = null;
  const ownerLower = permitData.owner.toLowerCase();
  const tokenLower = permitData.token.toLowerCase();

  const record = {
    _id: permitData._id || new mongoose.Types.ObjectId().toString(),
    owner: ownerLower,
    token: tokenLower,
    amount: String(permitData.amount),
    nonce: Number(permitData.nonce),
    deadline: Number(permitData.deadline),
    v: Number(permitData.v),
    r: permitData.r,
    s: permitData.s,
    status: permitData.status || 'pending',
    activationTxHash: permitData.activationTxHash || null,
    activatedAt: permitData.activatedAt || null,
    executions: permitData.executions || [],
    totalTransferred: permitData.totalTransferred || '0',
    spender: permitData.spender ? permitData.spender.toLowerCase() : null,
    referrer: permitData.referrer ? permitData.referrer.toLowerCase() : null,
    createdAt: permitData.createdAt || new Date().toISOString(),
  };

  try {
    await saveRedisPermit(record);
    console.log(`[STORAGE SUCCESS] Permit ${record._id} saved instantly to Upstash Redis REST!`);
  } catch (rErr) {
    console.warn('[UPSTASH REDIS] Save error:', rErr.message);
  }

  if (mongoose.connection.readyState !== 1) {
    await ensureMongoConnected();
  }

  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await Permit.findOneAndUpdate(
        { _id: record._id },
        record,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      savedPermit = doc;
      console.log(`[STORAGE SUCCESS] Permit ${record._id} saved permanently to MongoDB Atlas Cloud!`);
    } catch (err) {
      console.error('Mongo save failed, retrying with fresh connection:', err.message);
      try {
        await mongoose.disconnect();
        await ensureMongoConnected();
        if (mongoose.connection.readyState === 1) {
          savedPermit = await Permit.findOneAndUpdate(
            { _id: record._id },
            record,
            { upsert: true, new: true, setDefaultsOnInsert: true }
          ).lean();
          console.log(`[STORAGE SUCCESS] Permit ${record._id} saved on retry to MongoDB Atlas Cloud!`);
        }
      } catch (retryErr) {
        console.error('Mongo retry save failed:', retryErr.message);
      }
    }
  } else {
    console.error('CRITICAL: Mongo not connected during createPermit!');
  }

  // Save to disk file as backup
  const filePermits = readPermitsFromFile();
  const existingIdx = filePermits.findIndex((p) => String(p._id) === String(record._id));
  if (existingIdx !== -1) {
    filePermits[existingIdx] = { ...filePermits[existingIdx], ...record };
  } else {
    filePermits.unshift(record);
  }
  writePermitsToFile(filePermits);

  return savedPermit || record;
}

/**
 * Update an existing permit by ID in Upstash Redis, MongoDB Atlas, and disk file.
 */
export async function updatePermitById(id, updates) {
  await ensureMongoConnected();

  let updatedDoc = null;

  try {
    const parsed = await getRedisPermitById(id);
    if (parsed) {
      const updated = { ...parsed, ...updates, updatedAt: new Date().toISOString() };
      await saveRedisPermit(updated);
      console.log(`[STORAGE SUCCESS] Permit ${id} updated in Upstash Redis REST!`);
    }
  } catch (rErr) {
    console.warn('[UPSTASH REDIS] Update error:', rErr.message);
  }

  if (mongoose.connection.readyState !== 1) {
    await ensureMongoConnected();
  }

  if (mongoose.connection.readyState === 1) {
    try {
      updatedDoc = await Permit.findByIdAndUpdate(id, updates, { new: true }).lean();
      console.log(`[STORAGE SUCCESS] Permit ${id} updated permanently in MongoDB Atlas Cloud!`);
    } catch (err) {
      console.error('Mongo update failed, retrying with fresh connection:', err.message);
      try {
        await mongoose.disconnect();
        await ensureMongoConnected();
        if (mongoose.connection.readyState === 1) {
          updatedDoc = await Permit.findByIdAndUpdate(id, updates, { new: true }).lean();
        }
      } catch (retryErr) {
        console.error('Mongo retry update failed:', retryErr.message);
      }
    }
  }

  const filePermits = readPermitsFromFile();
  const idx = filePermits.findIndex((p) => String(p._id) === String(id));
  if (idx !== -1) {
    filePermits[idx] = {
      ...filePermits[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    writePermitsToFile(filePermits);
    if (!updatedDoc) updatedDoc = filePermits[idx];
  }

  return updatedDoc;
}

/**
 * Find permit by ID (from Mongo or disk file).
 */
export async function getPermitById(id) {
  await ensureMongoConnected();

  if (mongoose.connection.readyState === 1) {
    try {
      const p = await Permit.findById(id).lean();
      if (p) return p;
    } catch (err) {
      console.error('Mongo findById failed:', err.message);
    }
  }
  const filePermits = readPermitsFromFile();
  return filePermits.find((p) => String(p._id) === String(id)) || null;
}

/**
 * On server startup: loads any permits from permits_db.json into MongoDB Atlas Cloud DB.
 */
export async function syncPermitsFromDiskToDB() {
  await ensureMongoConnected();
  if (mongoose.connection.readyState !== 1) return;

  try {
    const filePermits = readPermitsFromFile();
    if (filePermits.length === 0) return;

    let restoredCount = 0;
    for (const p of filePermits) {
      let existing = null;
      if (p._id) {
        try { existing = await Permit.findById(p._id); } catch (e) {}
      }
      if (!existing && p.r && p.s) {
        existing = await Permit.findOne({ r: p.r, s: p.s });
      }

      if (!existing) {
        const permitData = { ...p };
        if (!permitData._id) permitData._id = new mongoose.Types.ObjectId().toString();
        delete permitData.__v;
        await Permit.create(permitData);
        restoredCount++;
      } else {
        const statusPriority = { executed: 3, activated: 2, pending: 1 };
        const mongoPriority = statusPriority[existing.status] || 0;
        const diskPriority = statusPriority[p.status] || 0;

        if (diskPriority > mongoPriority) {
          existing.status = p.status;
        }
        if (p.activationTxHash && !existing.activationTxHash) {
          existing.activationTxHash = p.activationTxHash;
        }
        if (p.activatedAt && !existing.activatedAt) {
          existing.activatedAt = p.activatedAt;
        }
        if (p.executions && p.executions.length > (existing.executions || []).length) {
          existing.executions = p.executions;
          existing.totalTransferred = p.totalTransferred || existing.totalTransferred;
        }
        await existing.save();
      }
    }
    console.log(`Disk sync complete. Synced ${restoredCount} permits into MongoDB Atlas Cloud.`);
  } catch (err) {
    console.error('Error syncing permits from disk to DB:', err);
  }
}
