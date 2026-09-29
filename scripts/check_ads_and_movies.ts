import mongoose from 'mongoose';

async function checkAds() {
  await mongoose.connect('mongodb://localhost:27017/tataiya');
  console.log('=== ADS IN DATABASE ===');
  const ads = await mongoose.connection.db.collection('ads').find({}).toArray();
  console.log(JSON.stringify(ads, null, 2));

  console.log('\n=== MOVIES IN DATABASE ===');
  const movies = await mongoose.connection.db.collection('movies').find({}).toArray();
  console.log(movies.map(m => ({
    id: m._id.toString(),
    title: m.title,
    planRequired: m.planRequired,
    isPremium: m.isPremium,
    isExclusive: m.isExclusive,
    featured: m.featured,
    trending: m.trending,
    trailerUrl: m.trailerUrl,
    hlsUrl: m.hlsUrl,
    videoUrl: m.videoUrl,
  })));

  await mongoose.disconnect();
}
checkAds().catch(console.error);
