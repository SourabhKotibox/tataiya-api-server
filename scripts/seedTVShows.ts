import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { TVShowModel } from '../src/models/TVShow.js';
import { SeasonModel } from '../src/models/Season.js';
import { EpisodeModel } from '../src/models/Episode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tataiya';

const defaultVideoQualities = [
  { quality: '1080p', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', size: 120000000 },
  { quality: '720p', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', size: 80000000 },
];

const TVSHOWS_TO_CREATE = [
  {
    title: 'Breaking Code',
    description: 'A high school chemistry teacher turned programmer creates the ultimate algorithm.',
    shortDescription: 'From chemistry to code.',
    status: 'published',
    planRequired: 'free',
    totalSeasons: 2,
    genres: [],
    languages: [],
    categories: [],
    posterImage: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=400&auto=format&fit=crop',
    thumbnail: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=400&auto=format&fit=crop',
    bannerImage: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=1200&auto=format&fit=crop',
  },
  {
    title: 'Stranger Bugs',
    description: 'When a young boy discovers a weird glitch in the matrix, strange things happen.',
    shortDescription: 'Glitch in the matrix.',
    status: 'published',
    planRequired: 'premium',
    totalSeasons: 1,
    genres: [],
    languages: [],
    categories: [],
    posterImage: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=400&auto=format&fit=crop',
    thumbnail: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=400&auto=format&fit=crop',
    bannerImage: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=1200&auto=format&fit=crop',
  }
];

const SEASONS = [
  { tvShowIndex: 0, seasonNumber: 1, title: 'Season 1', status: 'published' },
  { tvShowIndex: 0, seasonNumber: 2, title: 'Season 2', status: 'published' },
  { tvShowIndex: 1, seasonNumber: 1, title: 'Season 1', status: 'published' }
];

const EPISODES = [
  { tvShowIndex: 0, season: 1, episode: 1, title: 'The Hello World', processingStatus: 'ready', hlsUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', videoQualities: defaultVideoQualities, thumbnail: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=200&auto=format&fit=crop', isFree: true, isLocked: false },
  { tvShowIndex: 0, season: 1, episode: 2, title: 'Variable Assignments', processingStatus: 'ready', hlsUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', videoQualities: defaultVideoQualities, thumbnail: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=200&auto=format&fit=crop', isFree: true, isLocked: false },
  { tvShowIndex: 0, season: 2, episode: 1, title: 'Callback Hell', processingStatus: 'ready', hlsUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', videoQualities: defaultVideoQualities, thumbnail: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=200&auto=format&fit=crop', isFree: true, isLocked: false },
  { tvShowIndex: 1, season: 1, episode: 1, title: 'The Null Pointer', processingStatus: 'ready', hlsUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', videoQualities: defaultVideoQualities, thumbnail: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=200&auto=format&fit=crop' },
  { tvShowIndex: 1, season: 1, episode: 2, title: 'Segfault', processingStatus: 'ready', hlsUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', videoQualities: defaultVideoQualities, thumbnail: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=200&auto=format&fit=crop' }
];

async function seedTVShows() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const showIds: mongoose.Types.ObjectId[] = [];

  for (const showData of TVSHOWS_TO_CREATE) {
    let show = await TVShowModel.findOne({ title: showData.title });
    if (!show) {
      show = await TVShowModel.create(showData);
      console.log(`✅ Created TV Show: ${show.title}`);
    } else {
      await TVShowModel.updateOne({ _id: show._id }, { $set: showData });
      console.log(`↩ Updated TV Show: ${show.title}`);
    }
    showIds.push(show._id as mongoose.Types.ObjectId);
  }

  for (const seasonData of SEASONS) {
    const showId = showIds[seasonData.tvShowIndex];
    let season = await SeasonModel.findOne({ tvShowId: showId, seasonNumber: seasonData.seasonNumber });
    if (!season) {
      await SeasonModel.create({ ...seasonData, tvShowId: showId });
      console.log(`✅ Created Season ${seasonData.seasonNumber} for show index ${seasonData.tvShowIndex}`);
    } else {
      await SeasonModel.updateOne({ _id: season._id }, { $set: { ...seasonData, tvShowId: showId } });
      console.log(`↩ Updated Season ${seasonData.seasonNumber}`);
    }
  }

  for (const epData of EPISODES) {
    const showId = showIds[epData.tvShowIndex];
    let episode = await EpisodeModel.findOne({ tvShowId: showId, season: epData.season, episode: epData.episode });
    if (!episode) {
      await EpisodeModel.create({ ...epData, tvShowId: showId });
      console.log(`✅ Created Episode ${epData.episode} (Season ${epData.season}) for show index ${epData.tvShowIndex}`);
    } else {
      await EpisodeModel.updateOne({ _id: episode._id }, { $set: { ...epData, tvShowId: showId } });
      console.log(`↩ Updated Episode ${epData.episode}`);
    }
  }

  console.log('🎉 Seeding TV Shows complete!');
  await mongoose.disconnect();
}

seedTVShows().catch(err => {
  console.error('❌ Seeder failed:', err);
  process.exit(1);
});
