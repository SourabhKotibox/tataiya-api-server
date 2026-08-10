import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tataiya';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log('db:', db.databaseName);

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

  console.log('Upserted 4 plans: Basic ₹30/1mo, Standard ₹78/3mo, Premium ₹150/6mo, VIP ₹300/12mo');

  const s3Base = 'https://tatiyatv.s3.eu-north-1.amazonaws.com/';
  const banners = await db.collection('banners').find({}).toArray();
  let fixedBanners = 0;
  for (const b of banners) {
    const updates: Record<string, any> = {};
    for (const field of ['imageUrl', 'mobileImageUrl', 'thumbnail'] as const) {
      const v = (b as any)[field];
      if (typeof v === 'string' && v && !v.startsWith('http') && !v.startsWith('/')) {
        updates[field] = s3Base + v.replace(/^uploads\//, '');
      } else if (typeof v === 'string' && /^https?:\/\/(?:www\.)?tataiya\.in\/uploads\/(media\/.+)$/i.test(v)) {
        updates[field] = s3Base + v.replace(/^https?:\/\/(?:www\.)?tataiya\.in\/uploads\//i, '');
      }
    }
    if (!Array.isArray(b.targetPlatforms) || b.targetPlatforms.length === 0) {
      updates.targetPlatforms = ['web', 'mobile'];
    }
    if (Object.keys(updates).length) {
      await db.collection('banners').updateOne({ _id: b._id }, { $set: updates });
      fixedBanners++;
    }
  }

  const allPlans = await db.collection('subscriptionplans').find({}).toArray();
  console.log('plans now:', allPlans.map((p: any) => ({ name: p.name, price: p.price, totalPrice: p.totalPrice, status: p.status })));
  console.log('banners fixed:', fixedBanners);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
