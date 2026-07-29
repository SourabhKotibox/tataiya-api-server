import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * Create / repair HLS for movies.
 * - Never uses trailer files
 * - Repairs movies whose videoUrl/sourceVideoUrl/hls was polluted with trailer
 * - Finds real movie file from media library (largest non-trailer video)
 *
 * Usage:
 *   pkill -f transcode-movies-to-hls || true
 *   cd ~/tataiya-api-server && git pull
 *   nohup npx tsx scratch/transcode-movies-to-hls.ts > hls-transcode.log 2>&1 &
 *   tail -f hls-transcode.log
 */

const isTrailerLike = (url: string, trailerUrl?: string | null) => {
  if (!url) return false;
  if (trailerUrl && url.trim() === String(trailerUrl).trim()) return true;
  const fileName = (url.split('?')[0].split('/').pop() || '').toLowerCase();
  return /trailer/.test(fileName);
};

const isMp4Like = (u: any) =>
  typeof u === 'string' &&
  u.trim() &&
  !u.startsWith('blob:') &&
  !/\.m3u8(\?|#|$)/i.test(u) &&
  /\.(mp4|mkv|mov|webm|m4v)(\?|#|$)/i.test(u);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;

  const { MovieModel } = await import('../src/models/Movie');
  const { processMovieHls } = await import('../src/services/videoProcessor');

  /** Largest non-trailer video linked to this movie (or matching title keywords) */
  const findLibraryVideo = async (movie: any): Promise<string | null> => {
    const movieId = movie._id;
    const titleBits = String(movie.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w: string) => w.length > 2)
      .slice(0, 4);

    // 1) Files explicitly linked to this movie
    let files = await db
      .collection('mediafiles')
      .find({
        sourceId: movieId,
        $or: [{ fileType: /^video/i }, { name: /\.(mp4|mkv|mov|webm|m4v)$/i }],
        name: { $not: /trailer/i },
      })
      .project({ url: 1, filePath: 1, size: 1, name: 1, s3Key: 1 })
      .sort({ size: -1 })
      .toArray();

    // 2) Fallback: search by filename containing title words, exclude trailer
    if (!files.length && titleBits.length) {
      const nameRegex = new RegExp(titleBits.join('|'), 'i');
      files = await db
        .collection('mediafiles')
        .find({
          $or: [{ fileType: /^video/i }, { name: /\.(mp4|mkv|mov|webm|m4v)$/i }],
          name: { $regex: nameRegex, $not: /trailer/i },
        })
        .project({ url: 1, filePath: 1, size: 1, name: 1, s3Key: 1 })
        .sort({ size: -1 })
        .limit(5)
        .toArray();
    }

    const f: any = files[0];
    if (!f) return null;
    return f.url || (f.s3Key ? `https://tatiyatv.s3.eu-north-1.amazonaws.com/${f.s3Key}` : null) || f.filePath || null;
  };

  const polluted = await MovieModel.find({
    $or: [
      // No HLS yet
      { hlsUrl: { $not: /\.m3u8/ } },
      { hlsUrl: { $in: [null, ''] } },
      // HLS exists but movie fields point at trailer
      { videoUrl: /trailer/i },
      { sourceVideoUrl: /trailer/i },
      { $expr: { $and: [{ $ne: ['$trailerUrl', null] }, { $eq: ['$videoUrl', '$trailerUrl'] }] } },
      { $expr: { $and: [{ $ne: ['$trailerUrl', null] }, { $eq: ['$sourceVideoUrl', '$trailerUrl'] }] } },
    ],
  })
    .select('title hlsUrl videoUrl sourceVideoUrl trailerUrl processingStatus')
    .lean();

  const seen = new Set<string>();
  const queue = polluted.filter((m: any) => {
    const id = String(m._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  console.log(`Found ${queue.length} movie(s) to process/repair`);

  for (const m of queue as any[]) {
    const trailerPolluted =
      isTrailerLike(String(m.videoUrl || ''), m.trailerUrl) ||
      isTrailerLike(String(m.sourceVideoUrl || ''), m.trailerUrl) ||
      (m.hlsUrl && /\.m3u8/i.test(m.hlsUrl) && isTrailerLike(String(m.videoUrl || ''), m.trailerUrl));

    let src = [m.videoUrl, m.sourceVideoUrl, m.hlsUrl].find(
      (u: any) => isMp4Like(u) && !isTrailerLike(u, m.trailerUrl)
    );

    if (!src || trailerPolluted) {
      src = await findLibraryVideo(m);
      if (src && isTrailerLike(src, m.trailerUrl)) src = null;
    }

    if (!src) {
      console.log(`— SKIP "${m.title}": no non-trailer movie file found. Re-select the movie MP4 in admin and save.`);
      continue;
    }

    // Clear polluted trailer HLS so we don't keep serving the trailer stream
    if (trailerPolluted || (m.hlsUrl && isTrailerLike(String(m.videoUrl || ''), m.trailerUrl))) {
      console.log(`  ↺ Clearing trailer-polluted HLS for "${m.title}"`);
      await MovieModel.findByIdAndUpdate(m._id, {
        $set: {
          hlsUrl: '',
          videoQualities: [],
          videoUrl: src,
          sourceVideoUrl: src,
          processingStatus: 'queued',
          processingError: null,
        },
      });
    }

    console.log(`▶ Transcoding "${m.title}" from ${src}`);
    const started = Date.now();
    await processMovieHls(m._id, src);
    const fresh = await MovieModel.findById(m._id)
      .select('processingStatus hlsUrl processingError videoUrl')
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
