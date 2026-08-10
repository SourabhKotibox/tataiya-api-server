import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tataiya';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const plans = [
    { name: 'Basic', duration: 'Month', durationValue: 1, price: 30, discount: 0, totalPrice: 30, status: true, description: 'Basic plan — ₹30 for 1 month.', level: 1 },
    { name: 'Standard', duration: 'Months', durationValue: 3, price: 78, discount: 10, totalPrice: 78, status: true, description: 'Standard plan — ₹78 for 3 months.', level: 2 },
    { name: 'Premium', duration: 'Months', durationValue: 6, price: 150, discount: 17, totalPrice: 150, status: true, description: 'Premium plan — ₹150 for 6 months.', level: 3 },
    { name: 'VIP', duration: 'Months', durationValue: 12, price: 300, discount: 25, totalPrice: 300, status: true, description: 'VIP plan — ₹300 for 12 months.', level: 4 },
  ];

  for (const p of plans) {
    await db.collection('subscriptionplans').updateOne(
      { name: p.name },
      {
        $set: {
          ...p,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
  }

  const all = await db.collection('subscriptionplans').find({}).toArray();
  console.log('Active plans:', all.map((p: any) => ({ name: p.name, price: p.price, totalPrice: p.totalPrice, duration: p.duration, durationValue: p.durationValue })));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
