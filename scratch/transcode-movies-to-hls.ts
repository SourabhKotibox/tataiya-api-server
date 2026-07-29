import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * Create HLS for every movie that still plays a raw MP4.
 * NEVER uses the trailer as the movie source:
 *   - skips any candidate equal to trailerUrl or with "trailer" in the filename
 *   - falls back to the largest linked video in the media library
 * Also re-processes movies whose HLS was wrongly built from a trailer.
 *
 * Usage:
 *   cd ~/tataiya-api-server
 *   nohup npx tsx scratch/transcode-movies-to-hls.ts > hls-transcode.log 2>&1 &
 *   tail -f hls-transcode.log
 */

const isTrailerLike = (url: string, trailerUrl?: string | null) => {
  if (!url) return false;
  if (trailerUrl && url.trim() === String(trailerUrl).trim()) return true;
  const fileName = url.split('/').pop() || '';
  return /trailer/i.test(fileName);
};

const isVideoUrl = (u: any) =>
  typeof u === 'string' && u.trim() && !u.startsWith('blob:') && !/\.m3u8/i.test(u);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;

  const { MovieModel } = await import('../src/models/Movie');
  const { processMovieHls } = await import('../src/services/videoProcessor');

  /** Find the real movie file in the media library (largest non-trailer video linked to this movie) */
  const findLibraryVideo = async (movieId: mongoose.Types.ObjectId): Promise<string | null> => {
    const files = await db
      .collection('mediafiles')
      .find({
        sourceId: movieId,
        $or: [{ fileType: /^video/i }, { name: /\.(mp4|mkv|mov|webm|m4v)$/i }],
        name: { $not: /trailer/i },
      })
      .project({ url: 1, filePath: 1, size: 1, name: 1 })
      .sort({ size: -1 })
      .toArray();
    const f: any = files[0];
    if (!f) return null;
    return f.url || f.filePath || null;
  };

  // 1) Movies without HLS at all
  const withoutHls = await MovieModel.find({
    $or: [{ hlsUrl: { $not: /\.m3u8/ } }, { hlsUrl: { $in: [null, ''] } }],
  })
    .select('title hlsUrl videoUrl sourceVideoUrl trailerUrl processingStatus')
    .lean();

  // 2) Movies whose HLS exists but was built from the TRAILER (videoUrl now = trailer)
  const builtFromTrailer = await MovieModel.find({
    hlsUrl: /\.m3u8/i,
    $expr: { $eq: ['$videoUrl', '$trailerUrl'] },
  })
    .select('title hlsUrl videoUrl sourceVideoUrl trailerUrl processingStatus')
    .lean();

  // Also catch videoUrl with "trailer" in the filename even if not exactly equal
  const builtFromTrailerLoose = await MovieModel.find({
    hlsUrl: /\.m3u8/i,
    videoUrl: /trailer/i,
  })
    .select('title hlsUrl videoUrl sourceVideoUrl trailerUrl processingStatus')
    .lean();

  const seen = new Set<string>();
  const queue: any[] = [];
  for (const m of [...withoutHls, ...builtFromTrailer, ...builtFromTrailerLoose]) {
    const id = String(m._id);
    if (!seen.has(id)) {
      seen.add(id);
      queue.push(m);
    }
  }

  console.log(`Found ${queue.length} movie(s) to process`);

  for (const m of queue) {
    // Choose source: prefer videoUrl, then sourceVideoUrl/hlsUrl — never a trailer
    let src = [m.videoUrl, m.sourceVideoUrl, m.hlsUrl].find(
      (u: any) => isVideoUrl(u) && !isTrailerLike(u, m.trailerUrl)
    );

    if (!src) {
      // DB got polluted with trailer URLs — recover from media library
      src = await findLibraryVideo(m._id);
      if (src && isTrailerLike(src, m.trailerUrl)) src = null;
    }

    if (!src) {
      console.log(`— SKIP "${m.title}": no non-trailer source video found. Re-upload the movie file.`);
      continue;
    }

    console.log(`▶ Transcoding "${m.title}" from ${src}`);
    const started = Date.now();
    await processMovieHls(m._id, src);
    const fresh = await MovieModel.findById(m._id)
      .select('processingStatus hlsUrl processingError')
      .lean();
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
