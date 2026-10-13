import os from 'node:os';
import { Types } from 'mongoose';
import { EpisodeModel } from '../models/Episode';
import { MediaFileModel } from '../models/MediaFile';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { VideoProcessingJobModel, VideoJobEntityType, IVideoProcessingJob } from '../models/VideoProcessingJob';
import { abortStaleSpacesMultipartUploads, ensureVideoSourceInSpaces, getHlsPublicBaseUrl, requireSpacesSettings } from '../lib/s3';
import { cleanupLegacyVideoArtifacts, cleanupStaleVideoWorkspaces, getAvailableVideoJobConcurrency, getVideoJobLimits } from '../lib/videoJobRuntime';
import { logger } from '../lib/logger';

const LEASE_MS = Math.max(60_000, Number(process.env.VIDEO_JOB_LEASE_MS) || 5 * 60_000);
const POLL_MS = Math.max(500, Number(process.env.VIDEO_JOB_POLL_MS) || 3_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.VIDEO_JOB_MAX_ATTEMPTS) || 5);
const RETRY_BASE_MS = Math.max(1_000, Number(process.env.VIDEO_JOB_RETRY_BASE_MS) || 30_000);
const LEASE_OWNER = `${os.hostname()}:${process.pid}`;

export function calculateVideoJobRetryDelay(attempt: number, baseMs = RETRY_BASE_MS, maxMs = 30 * 60_000): number {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
}

let pollingTimer: NodeJS.Timeout | undefined;
let maintenanceTimer: NodeJS.Timeout | undefined;
let pumpPromise: Promise<void> | undefined;
let activeJobs = 0;

const entityModels = {
  mediaFile: MediaFileModel,
  movie: MovieModel,
  tvShow: TVShowModel,
  episode: EpisodeModel,
} as const;

function sourceKeyFromUrl(sourceUrl: string): string | undefined {
  if (!sourceUrl) return undefined;
  if (!/^https?:\/\//i.test(sourceUrl)) {
    const key = sourceUrl.replace(/^\/+/, '').replace(/^uploads\//, '');
    return key.startsWith('media/') ? key : undefined;
  }
  return undefined;
}

export async function enqueueVideoProcessingJob(
  entityType: VideoJobEntityType,
  entityId: Types.ObjectId | string,
  sourceUrl: string,
  sourceKey = sourceKeyFromUrl(sourceUrl),
  options: { transcodeRequired?: boolean; hlsOnly?: boolean } = {},
): Promise<IVideoProcessingJob> {
  await requireSpacesSettings();
  const id = new Types.ObjectId(entityId);
  const existing = await VideoProcessingJobModel.findOne({ entityType, entityId: id });
  if (existing && ['processing', 'uploading'].includes(existing.status) && existing.leaseExpiresAt && existing.leaseExpiresAt > new Date()) {
    return existing;
  }
  if (existing?.status === 'queued' && existing.sourceUrl === sourceUrl) return existing;
  const transcodeRequired = options.transcodeRequired ?? true;

  const update = {
    $set: {
      sourceUrl,
      sourceKey,
      transcodeRequired,
      hlsOnly: options.hlsOnly ?? false,
      status: 'queued',
      maxAttempts: MAX_ATTEMPTS,
      nextAttemptAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: null,
      lastError: null,
      temporaryBytes: 0,
      uploadedBytes: 0,
      ...(existing && ['completed', 'failed'].includes(existing.status) ? { attempts: 0 } : {}),
    },
    $setOnInsert: { attempts: 0 },
  };

  try {
    const job = await VideoProcessingJobModel.findOneAndUpdate(
      { entityType, entityId: id },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    void pumpVideoProcessingQueue();
    return job!;
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const job = await VideoProcessingJobModel.findOne({ entityType, entityId: id });
    if (!job) throw error;
    return job;
  }
}

export async function markVideoJobUploading(jobId: Types.ObjectId | string, uploadedBytes?: number): Promise<void> {
  await VideoProcessingJobModel.findOneAndUpdate(
    { _id: jobId, leaseOwner: LEASE_OWNER },
    { $set: { status: 'uploading', ...(uploadedBytes !== undefined ? { uploadedBytes } : {}) } }
  );
}

export async function assertVideoJobLease(jobId: Types.ObjectId | string): Promise<void> {
  if (!await ownsVideoJobLease(jobId)) throw new Error(`Video job lease lost before publication: ${jobId}`);
}

export async function ownsVideoJobLease(jobId: Types.ObjectId | string): Promise<boolean> {
  const active = await VideoProcessingJobModel.exists({
    _id: jobId,
    leaseOwner: LEASE_OWNER,
    status: { $in: ['processing', 'uploading'] },
    leaseExpiresAt: { $gt: new Date() },
  });
  return !!active;
}

async function setEntityStatus(job: IVideoProcessingJob, status: 'queued' | 'processing' | 'ready' | 'failed', error?: string) {
  const Model = entityModels[job.entityType] as any;
  const fields = job.entityType === 'mediaFile'
    ? { hlsStatus: status === 'ready' ? 'completed' : status === 'queued' ? 'pending' : status, hlsError: error || null }
    : { processingStatus: status, processingError: error || null };
  await Model.findByIdAndUpdate(job.entityId, { $set: fields });
}

export async function recoverExpiredVideoJobs(now = new Date(), model: any = VideoProcessingJobModel): Promise<number> {
  const expiredLease = { status: { $in: ['processing', 'uploading'] }, $or: [{ leaseExpiresAt: { $lte: now } }, { leaseExpiresAt: { $exists: false } }] };
  const exhausted = await model.updateMany(
    { ...expiredLease, attempts: { $gte: MAX_ATTEMPTS } },
    { $set: { status: 'failed', leaseOwner: null, leaseExpiresAt: null, lastError: 'Worker lease expired after the retry limit.' } }
  );
  const requeued = await model.updateMany(
    { ...expiredLease, $and: [{ $or: [{ attempts: { $lt: MAX_ATTEMPTS } }, { attempts: { $exists: false } }] }] },
    { $set: { status: 'queued', nextAttemptAt: now, leaseOwner: null, leaseExpiresAt: null } }
  );
  const recovered = (exhausted.modifiedCount || 0) + (requeued.modifiedCount || 0);
  if (recovered) logger.warn({ requeuedJobs: requeued.modifiedCount || 0, failedJobs: exhausted.modifiedCount || 0 }, 'Recovered expired video-processing leases');
  return recovered;
}

async function claimJob(): Promise<IVideoProcessingJob | null> {
  const now = new Date();
  return VideoProcessingJobModel.findOneAndUpdate(
    { status: 'queued', nextAttemptAt: { $lte: now } },
    {
      $set: { status: 'processing', leaseOwner: LEASE_OWNER, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), startedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, new: true }
  );
}

async function runJob(job: IVideoProcessingJob): Promise<void> {
  const leaseHeartbeat = setInterval(() => {
    void VideoProcessingJobModel.updateOne(
      { _id: job._id, leaseOwner: LEASE_OWNER, status: { $in: ['processing', 'uploading'] } },
      { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }
    ).catch((error) => logger.error({ error, jobId: job._id }, 'Video job lease heartbeat failed'));
  }, Math.max(10_000, Math.floor(LEASE_MS / 3)));
  leaseHeartbeat.unref();

  try {
    const EntityModel = entityModels[job.entityType] as any;
    const entity = await EntityModel.findById(job.entityId).lean();
    if (!entity) throw new Error(`Video job target not found: ${job.entityType}/${job.entityId}`);
    if (job.hlsOnly) {
      await setEntityStatus(job, 'processing');
      const { migrateLegacyHlsToSpaces } = await import('./legacyHlsMigration');
      await migrateLegacyHlsToSpaces(job.entityType, job.entityId.toString(), job.sourceUrl, job._id.toString());
      await assertVideoJobLease(job._id);
      await VideoProcessingJobModel.findByIdAndUpdate(job._id, {
        $set: { status: 'completed', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null },
      });
      return;
    }
    const source = await ensureVideoSourceInSpaces(
      job.sourceUrl || entity.sourceVideoUrl || entity.videoUrl || entity.filePath || entity.url,
      job.entityType,
      job.entityId.toString(),
      job.sourceKey || entity.sourceVideoKey || entity.s3Key
    );
    const sourceFields = job.entityType === 'mediaFile'
      ? { s3Key: source.key, filePath: source.key, url: source.url, storageType: 'spaces' }
      : { sourceVideoKey: source.key, sourceVideoUrl: source.url, videoUrl: source.url };
    await EntityModel.findByIdAndUpdate(job.entityId, { $set: sourceFields });
    await VideoProcessingJobModel.findByIdAndUpdate(job._id, {
      $set: { sourceKey: source.key, sourceUrl: source.url },
    });

    if (source.legacyLocalPath) {
      try {
        await import('node:fs/promises').then(({ unlink }) => unlink(source.legacyLocalPath!));
        logger.info({ jobId: job._id, sourceKey: source.key, legacyLocalPath: source.legacyLocalPath, bytes: source.size }, 'Removed legacy local original after Spaces verification');
      } catch (cleanupError: any) {
        if (cleanupError?.code !== 'ENOENT') logger.warn({ cleanupError, jobId: job._id, legacyLocalPath: source.legacyLocalPath }, 'Could not remove migrated legacy original');
      }
    }

    if (!job.transcodeRequired) {
      await setEntityStatus(job, 'ready');
      await VideoProcessingJobModel.findByIdAndUpdate(job._id, {
        $set: { status: 'completed', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null },
      });
      logger.info({ jobId: job._id, entityType: job.entityType, entityId: job.entityId, sourceKey: source.key }, 'Legacy original migrated to Spaces without retranscoding verified HLS');
      return;
    }

    await setEntityStatus(job, 'processing');
    if (job.entityType === 'mediaFile') {
      const { runTranscodeToHls } = await import('../lib/hlsTranscoder');
      await runTranscodeToHls(job.entityId.toString(), source.url, 'spaces', job._id.toString());
    } else {
      const processor = await import('./videoProcessor');
      if (job.entityType === 'movie') await processor.processMovieHls(job.entityId, source.url, job._id.toString());
      else if (job.entityType === 'tvShow') await processor.processTVShowHls(job.entityId, source.url, job._id.toString());
      else await processor.processEpisodeHls(job.entityId, source.url, job._id.toString());
    }
    await assertVideoJobLease(job._id);
    await VideoProcessingJobModel.findByIdAndUpdate(job._id, {
      $set: { status: 'completed', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null },
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    const retry = job.attempts < job.maxAttempts;
    const delay = calculateVideoJobRetryDelay(job.attempts);
    const nextStatus = retry ? 'queued' : 'failed';
    await VideoProcessingJobModel.findByIdAndUpdate(job._id, {
      $set: {
        status: nextStatus,
        nextAttemptAt: new Date(Date.now() + delay),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: message.slice(0, 1000),
      },
    });
    await setEntityStatus(job, retry ? 'queued' : 'failed', message.slice(0, 1000));
    logger.error({ error, jobId: job._id, entityType: job.entityType, entityId: job.entityId, attempt: job.attempts, retry, retryDelayMs: delay }, 'Video processing job failed');
  } finally {
    clearInterval(leaseHeartbeat);
  }
}

export async function pumpVideoProcessingQueue(): Promise<void> {
  if (pumpPromise) return pumpPromise;
  pumpPromise = (async () => {
    const concurrency = await getAvailableVideoJobConcurrency();
    if (!concurrency) {
      logger.warn({ limits: getVideoJobLimits() }, 'Video queue paused until memory and disk headroom are available');
      return;
    }
    while (activeJobs < concurrency) {
      const job = await claimJob();
      if (!job) break;
      activeJobs++;
      void runJob(job).finally(() => {
        activeJobs--;
        void pumpVideoProcessingQueue();
      });
    }
  })().finally(() => { pumpPromise = undefined; });
  return pumpPromise;
}

export async function startVideoProcessingWorker(): Promise<void> {
  if (pollingTimer) return;
  await requireSpacesSettings();
  await VideoProcessingJobModel.createIndexes();
  await recoverExpiredVideoJobs();
  await enqueueLegacyQueuedJobs();
  await cleanupStaleVideoWorkspaces();
  await cleanupLegacyVideoArtifacts();
  await abortStaleSpacesMultipartUploads();
  pollingTimer = setInterval(() => {
    void recoverExpiredVideoJobs().then(() => pumpVideoProcessingQueue()).catch((error) => {
      logger.error({ error }, 'Video queue poll failed');
    });
    void cleanupStaleVideoWorkspaces().catch((error) => logger.error({ error }, 'Stale workspace cleanup failed'));
  }, POLL_MS);
  pollingTimer.unref();
  maintenanceTimer = setInterval(() => {
    void Promise.all([
      cleanupStaleVideoWorkspaces(),
      cleanupLegacyVideoArtifacts(),
      abortStaleSpacesMultipartUploads(),
    ]).catch((error) => logger.error({ error }, 'Video storage maintenance failed'));
  }, 6 * 60 * 60 * 1000);
  maintenanceTimer.unref();
  void pumpVideoProcessingQueue();
  logger.info({ owner: LEASE_OWNER, concurrency: getVideoJobLimits().maxConcurrentJobs }, 'Persistent video-processing worker started');
}

async function enqueueLegacyQueuedJobs(): Promise<void> {
  const pending: Array<{ entityType: VideoJobEntityType; entity: any; source: string; hlsUrl?: string }> = [];
  const [mediaFiles, movies, shows, episodes] = await Promise.all([
    MediaFileModel.find({ fileType: /^video\//, $or: [{ storageType: { $ne: 'spaces' } }, { hlsStatus: { $in: ['pending', 'processing'] } }, { s3Key: { $exists: false } }, { hlsMasterPlaylistUrl: /^\/?uploads\/hls\// }] }).lean(),
    MovieModel.find({ $or: [{ $and: [{ $or: [{ sourceVideoUrl: { $exists: true, $nin: [null, ''] } }, { videoUrl: { $exists: true, $nin: [null, ''] } }] }, { $or: [{ sourceVideoKey: { $exists: false } }, { sourceVideoKey: null }, { sourceVideoKey: '' }, { processingStatus: { $in: ['queued', 'processing'] } }] }] }, { hlsUrl: /^\/?uploads\/hls\// }] }).lean(),
    TVShowModel.find({ $or: [{ $and: [{ $or: [{ sourceVideoUrl: { $exists: true, $nin: [null, ''] } }, { videoUrl: { $exists: true, $nin: [null, ''] } }] }, { $or: [{ sourceVideoKey: { $exists: false } }, { sourceVideoKey: null }, { sourceVideoKey: '' }, { processingStatus: { $in: ['queued', 'processing'] } }] }] }, { hlsUrl: /^\/?uploads\/hls\// }] }).lean(),
    EpisodeModel.find({ $or: [{ $and: [{ $or: [{ sourceVideoUrl: { $exists: true, $nin: [null, ''] } }, { videoUrl: { $exists: true, $nin: [null, ''] } }] }, { $or: [{ sourceVideoKey: { $exists: false } }, { sourceVideoKey: null }, { sourceVideoKey: '' }, { processingStatus: { $in: ['queued', 'processing'] } }] }] }, { hlsUrl: /^\/?uploads\/hls\// }] }).lean(),
  ]);
  for (const entity of mediaFiles) pending.push({ entityType: 'mediaFile', entity, source: entity.url || entity.filePath || entity.s3Key, hlsUrl: entity.hlsMasterPlaylistUrl });
  for (const entity of movies) pending.push({ entityType: 'movie', entity, source: entity.sourceVideoKey || entity.sourceVideoUrl || entity.videoUrl || entity.hlsUrl, hlsUrl: entity.hlsUrl });
  for (const entity of shows) pending.push({ entityType: 'tvShow', entity, source: entity.sourceVideoKey || entity.sourceVideoUrl || entity.videoUrl || entity.hlsUrl, hlsUrl: entity.hlsUrl });
  for (const entity of episodes) pending.push({ entityType: 'episode', entity, source: entity.sourceVideoKey || entity.sourceVideoUrl || entity.videoUrl || entity.hlsUrl, hlsUrl: entity.hlsUrl });

  const spacesHlsBase = await getHlsPublicBaseUrl();
  const existingHlsIsInSpaces = (url?: string) => !!url && (url.startsWith(`${spacesHlsBase}/`) || url.startsWith('hls/'));

  for (const { entityType, entity, source, hlsUrl } of pending) {
    if (!source) continue;
    const hlsOnly = /\.m3u8(?:[?#]|$)/i.test(String(source));
    if (hlsOnly) {
      await enqueueVideoProcessingJob(entityType, entity._id, String(source), undefined, { transcodeRequired: false, hlsOnly: true });
      continue;
    }
    await enqueueVideoProcessingJob(entityType, entity._id, String(source), entity.sourceVideoKey || entity.s3Key, {
      transcodeRequired: !existingHlsIsInSpaces(hlsUrl),
    });
  }
  if (pending.length) logger.info({ scanned: pending.length }, 'Scanned legacy video processing states for recovery');
}