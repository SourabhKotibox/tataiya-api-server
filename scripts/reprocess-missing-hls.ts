/**
 * Queue HLS for every movie, TV show, episode, trailer, and library video
 * that is not already a remote playlist, then optionally drain the queue.
 *
 * The API process also runs this worker. On a small disk, stop the API worker
 * first (or leave VIDEO_MAX_CONCURRENT_JOBS=1) so two ffmpeg processes do not
 * fill the disk.
 *
 *   npx tsx scripts/reprocess-missing-hls.ts
 *   npx tsx scripts/reprocess-missing-hls.ts --run
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { VideoProcessingJobModel } from '../src/models/VideoProcessingJob';
import { enqueueMissingHlsJobs, startVideoProcessingWorker } from '../src/services/videoProcessingQueue';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

const runInline = process.argv.includes('--run');

await mongoose.connect(uri);
const counts = await enqueueMissingHlsJobs({ retryFailed: true });
console.log(JSON.stringify({ queued: counts, inline: runInline }, null, 2));

if (!runInline) {
  console.log('Jobs are queued. The running API worker will transcode them into DigitalOcean Spaces.');
  console.log('To process in this process until the queue is empty: npx tsx scripts/reprocess-missing-hls.ts --run');
  await mongoose.disconnect();
  process.exit(0);
}

await startVideoProcessingWorker();
const timeoutMs = Number(process.env.VIDEO_BATCH_TIMEOUT_MS || 0);
const started = Date.now();
while (true) {
  const remaining = await VideoProcessingJobModel.countDocuments({ status: { $in: ['queued', 'processing', 'uploading'] } });
  const failed = await VideoProcessingJobModel.countDocuments({ status: 'failed' });
  console.log(`[${new Date().toISOString()}] remaining=${remaining} failed=${failed}`);
  if (remaining === 0) break;
  if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
    console.error('Timed out with jobs still running');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

await mongoose.disconnect();
process.exit(0);
