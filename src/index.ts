import bcrypt from 'bcryptjs';
import { connectToDatabase, closeDatabaseConnection } from './config/database';
import Admin from './models/Admin';
import app from './app';

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    if (!process.env.JWT_SECRET) {
      console.error('❌ JWT_SECRET is not set in .env');
      process.exit(1);
    }

    await connectToDatabase();

    // Auto-seed the admin account on first run (ADMIN_EMAIL / ADMIN_PASSWORD in .env)
    if ((await Admin.countDocuments()) === 0) {
      if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        await Admin.create({ email: process.env.ADMIN_EMAIL.toLowerCase(), passwordHash });
        console.log(`🌱 Admin account created: ${process.env.ADMIN_EMAIL}`);
      } else {
        console.warn('⚠️  ADMIN_EMAIL / ADMIN_PASSWORD not set in .env — admin login disabled');
      }
    }

    const server = app.listen(PORT, () => {
      console.log(`\n🚀 Server running on port ${PORT}`);
      console.log(`📍 http://localhost:${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log('\n✨ Ready to accept requests!\n');
    });

    const shutdown = async () => {
      console.log('\n🛑 Shutting down...');
      server.close();
      await closeDatabaseConnection();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
