import mongoose from 'mongoose';
import dns from 'dns';

// Use system DNS resolver instead of Node's default
dns.setDefaultResultOrder('ipv4first');

let connection$: Promise<typeof mongoose> | null = null;

const _connectToDatabase = async (): Promise<typeof mongoose> => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not defined');
  }

  const connection = await mongoose.connect(uri, {
    appName: 'coovi-api',
    serverSelectionTimeoutMS: 10000,
    family: 4, // Force IPv4
  });

  console.log('✅ MongoDB connected successfully');
  console.log(`📦 Database: ${mongoose.connection.name}`);

  return connection;
};

export const connectToDatabase = (): Promise<typeof mongoose> => {
  connection$ ??= _connectToDatabase();
  return connection$;
};

export const closeDatabaseConnection = async (): Promise<void> => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
    console.log('📦 Database connection closed');
  }
};
