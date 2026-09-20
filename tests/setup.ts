import { afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Admin from '../src/models/Admin';

// These must be set before app.ts runs dotenv.config() — dotenv never overrides
// existing env vars, so these values win over whatever sits in .env
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

// Vitest awaits this module (top-level await) before loading the test files,
// so the in-memory DB is connected before any route touches the models
const mongoServer = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongoServer.getUri('coovi-test');
await mongoose.connect(process.env.MONGODB_URI);

// Each test file gets a fresh module registry → its own memory server and empty DB
await Admin.deleteMany({});
await Admin.create({
  email: 'testadmin@coovi.com',
  passwordHash: await bcrypt.hash('testpass123', 10),
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
