import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import permitsRouter from './routes/permits.js';
import adminRouter from './routes/admin.js';
import { syncPermitsFromDiskToDB } from './utils/storage.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbDir = path.join(__dirname, 'data');

const DEFAULT_MONGO_URI = 'mongodb+srv://magicalbiral1007_db_user:ZOXAYVC2eAUgZMX0@cluster0.imn70iv.mongodb.net/gasless-usdt?retryWrites=true&w=majority';

// Serverless Mongoose connection caching on global object (AWS Lambda / Vercel pattern)
let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn && mongoose.connection.readyState === 1 && mongoose.connection.db) {
    return cached.conn;
  }
  if (!cached.promise) {
    const uri = process.env.MONGODB_URI || DEFAULT_MONGO_URI;
    const opts = {
      dbName: 'gasless-usdt',
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 15000,
      family: 4, // Force IPv4 to prevent serverless IPv6 DNS stall
      bufferCommands: false,
      maxPoolSize: 10,
    };
    cached.promise = mongoose.connect(uri, opts).then(async (m) => {
      console.log('MongoDB connected to Atlas cloud database successfully via IPv4!');
      try {
        await syncPermitsFromDiskToDB();
      } catch (syncErr) {
        console.warn('Startup sync warning:', syncErr.message);
      }
      return m;
    }).catch(async (err) => {
      console.warn('Primary MongoDB Atlas connection warning:', err.message);
      cached.promise = null;
      if (!process.env.VERCEL) {
        console.warn('Local environment: Starting persistent embedded database fallback...');
        try {
          const { MongoMemoryServer } = await import('mongodb-memory-server');
          if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
          }
          const lockFile = path.join(dbDir, 'mongod.lock');
          if (fs.existsSync(lockFile)) {
            try { fs.unlinkSync(lockFile); } catch (e) {}
          }
          let mongod;
          try {
            mongod = await MongoMemoryServer.create({
              instance: { dbPath: dbDir, storageEngine: 'wiredTiger', dbName: 'gasless-usdt' },
            });
          } catch (e1) {
            mongod = await MongoMemoryServer.create({
              instance: { dbName: 'gasless-usdt' },
            });
          }
          const mongoUri = mongod.getUri();
          await mongoose.connect(mongoUri, { dbName: 'gasless-usdt', family: 4 });
          console.log('Persistent Embedded MongoDB connected at:', mongoUri);
          await syncPermitsFromDiskToDB();
          return mongoose;
        } catch (memErr) {
          console.error('Failed to start embedded MongoDB server:', memErr);
        }
      }
      throw err;
    });
  }
  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }
  return cached.conn;
}

// DB connection middleware for all requests
app.use(async (req, res, next) => {
  try {
    await connectDB();
  } catch (e) {}
  next();
});

app.use('/api/permits', permitsRouter);
app.use('/api/admin', adminRouter);

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export default app;

