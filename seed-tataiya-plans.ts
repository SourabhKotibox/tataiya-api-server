import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/triple-mindes';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const plans = [
    {
      name: 'Basic',
      duration: 'Monthly',
      durationValue: 30,
      price: 149,
      discount: 0,
      totalPrice: 149,
      status: true,
      description: 'HD streaming on 1 device. Perfect for getting started with Tataiya movies.',
      level: 1,
    },
    {
      name: 'Standard',
      duration: 'Monthly',
      durationValue: 30,
      price: 299,
      discount: 10,
      totalPrice: 269,
      status: true,
      description: 'Full HD, 2 screens, downloads, and ad-light movie streaming.',
      level: 2,
    },
    {
      name: 'Premium',
      duration: 'Monthly',
      durationValue: 30,
      price: 499,
      discount: 15,
      totalPrice: 424,
      status: true,
      description: '4K quality, 4 screens, ad-free, unlimited downloads — the full Tataiya experience.',
      level: 3,
    },
    {
      name: 'Premium Yearly',
      duration: 'Yearly',
      durationValue: 365,
      price: 4999,
      discount: 20,
      totalPrice: 3999,
      status: true,
      description: 'Best value: a full year of Premium Tataiya movies.',
      level: 4,
    },
  ];

  for (const plan of plans) {
    await db.collection('subscriptionplans').updateOne(
      { name: plan.name },
      { $set: { ...plan, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  }

  // Ensure New & Hot has content
  await db.collection('movies').updateMany(
    { status: 'published' },
    { $set: { isNewContent: true } },
    { limit: 12 } as any
  );
  // Mongo updateMany doesn't support limit — mark newest 12 explicitly
  const newest = await db
    .collection('movies')
    .find({ status: 'published' })
    .sort({ createdAt: -1 })
    .limit(12)
    .project({ _id: 1 })
    .toArray();
  if (newest.length) {
    await db.collection('movies').updateMany(
      { _id: { $in: newest.map((m) => m._id) } },
      { $set: { isNewContent: true, trending: true } }
    );
  }

  const planCount = await db.collection('subscriptionplans').countDocuments({ status: true });
  console.log(`Seeded plans. Active plans: ${planCount}`);
  console.log(`Marked ${newest.length} movies as new/trending`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
