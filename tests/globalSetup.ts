import { MongoBinary } from 'mongodb-memory-server';

// Runs once before any test file. Every test file starts its own
// MongoMemoryServer (see setup.ts); on a machine without the MongoDB binary
// (a fresh CI runner) they would all download it at the same time and fail on
// each other's lock file. Fetching it here first means they only reuse it.
export default async function globalSetup() {
  await MongoBinary.getPath();
}
