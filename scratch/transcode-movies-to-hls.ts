import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * Create HLS for every published movie that still plays a raw MP4.
 * ffmpeg reads the S3 URL directly; output goes to uploads/hls/movies/{id}/
 * and is served via nginx at /uploads/hls/movies/{id}/master.m3u8.
 *
 * Usage:
 *   cd ~/tataiya-api-server
 *   nohup npx tsx scratch/transcode-movies-to-hls.ts > hls-transcode.log 2>&1 &
 *   tail -f hls-transcode.log
 */
async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);

  // Import AFTER mongoose connects (models register on the default connection)
  const { MovieModel } = await import('../src/models/Movie');
  const { processMovieHls } = await import('../src/services/videoProcessor');

  const movies = await MovieModel.find({
    $and: [
      { $or: [{ hlsUrl: { $not: /\.m3u8/ } }, { hlsUrl: { $in: [null, ''] } }] },
      {
        $or: [
          { hlsUrl: /\.(mp4|mkv|mov|webm|m4v)/i },
          { videoUrl: /\.(mp4|mkv|mov|webm|m4v)/i },
          { sourceVideoUrl: /\.(mp4|mkv|mov|webm|m4v)/i },
        ],
      },
    ],
  })
    .select('title hlsUrl videoUrl sourceVideoUrl processingStatus')
    .lean();

  console.log(`Found ${movies.length} movie(s) without HLS`);

  for (const m of movies) {
    const src = [m.sourceVideoUrl, m.videoUrl, m.hlsUrl].find(
      (u: any) => typeof u === 'string' && u.trim() && !u.startsWith('blob:') && !/\.m3u8/i.test(u)
    );
    if (!src) {
      console.log(`— skip "${m.title}" (no usable source video)`);
      continue;
    }
    console.log(`▶ Transcoding "${m.title}" from ${src}`);
    const started = Date.now();
    // processMovieHls updates the movie doc itself (hlsUrl, videoQualities, processingStatus)
    await processMovieHls(m._id, src);
    const fresh = await MovieModel.findById(m._id).select('processingStatus hlsUrl processingError').lean();
    const mins = Math.round((Date.now() - started) / 60000);
    if (fresh?.processingStatus === 'ready' && /\.m3u8/i.test(String(fresh.hlsUrl))) {
      console.log(`  ✓ done in ${mins}min → ${fresh.hlsUrl}`);
    } else {
      console.log(`  ✗ failed in ${mins}min: ${fresh?.processingError || 'unknown error'}`);
    }
  }

  await mongoose.disconnect();
  console.log('All done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
