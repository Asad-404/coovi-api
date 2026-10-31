import 'dotenv/config';
import mongoose from 'mongoose';
import { applyOrderNumberChanges, planOrderNumberChanges } from './orderNumberMigration';

// Renumbers existing orders to the 6-character format.
//   pnpm migrate:order-numbers           shows what would change, writes nothing
//   pnpm migrate:order-numbers --apply   makes the change
const run = async () => {
  const apply = process.argv.includes('--apply');

  try {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(process.env.MONGODB_URI);

    const plan = await planOrderNumberChanges();
    console.log(`Database: ${mongoose.connection.name}`);
    console.log(`Orders: ${plan.totalOrders}, to renumber: ${plan.changes.length}`);
    console.log(`Courier payments to update: ${plan.courierPaymentsToUpdate}`);
    plan.changes.forEach((c) => console.log(`  ${c.from} -> ${c.to}`));

    if (plan.freshCodes.length > 0) {
      console.log(`\nThe old number of these orders will stop working on Track Order:`);
      plan.freshCodes.forEach((c) => console.log(`  ${c.from} -> ${c.to}`));
    }

    if (plan.unfinishedBookings.length > 0) {
      console.error(`\nUnfinished Steadfast bookings, settle these before applying:`);
      plan.unfinishedBookings.forEach((n) => console.error(`  ${n}`));
    }

    if (!apply) {
      console.log('\nDry run: nothing was changed. Add --apply to make the change.');
    } else if (plan.unfinishedBookings.length > 0) {
      process.exitCode = 1;
      console.error('\nNothing was changed.');
    } else {
      await applyOrderNumberChanges(plan);
      console.log('\nDone.');
    }
  } catch (error) {
    process.exitCode = 1;
    console.error('Migration failed:', error);
  } finally {
    await mongoose.disconnect();
  }
};

run();
