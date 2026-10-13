import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger';
import { VideoProcessingJobModel } from '../models/VideoProcessingJob';
import { EpisodeModel } from '../models/Episode';
import { MediaFileModel } from '../models/MediaFile';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';

const WORKSPACE_MARKER = '.tataiya-video-job.json';
const HOSTNAME = os.hostname();

export function getVideoTempRoot(): string {
  return path.resolve(process.env.VIDEO_TEMP_DIR || path.join(os.tmpdir(), 'tataiya-video-processing'));
}

export function getVideoJobLimits() {
  return {
    maxConcurrentJobs: Math.max(1, Number(process.env.VIDEO_MAX_CONCURRENT_JOBS) || 1),
    minFreeBytes: Math.max(256 * 1024 * 1024, Number(process.env.VIDEO_MIN_FREE_DISK_BYTES) || 2 * 1024 * 1024 * 1024),
    minJobDiskBytes: Math.max(1024 * 1024 * 1024, Number(process.env.VIDEO_MIN_JOB_DISK_BYTES) || 10 * 1024 * 1024 * 1024),
    minMemoryPerJobBytes: Math.max(512 * 1024 * 1024, Number(process.env.VIDEO_MIN_MEMORY_PER_JOB_BYTES) || 3 * 1024 * 1024 * 1024),
    cleanupAgeMs: Math.max(60 * 60 * 1000, Number(process.env.VIDEO_TEMP_TTL_HOURS || 24) * 60 * 60 * 1000),
  };
}

export async function getAvailableVideoJobConcurrency(): Promise<number> {
  const limits = getVideoJobLimits();
  const root = getVideoTempRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const stats = await fs.promises.statfs(root);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const diskSlots = Math.floor(Math.max(0, freeBytes - limits.minFreeBytes) / limits.minJobDiskBytes);
  const memorySlots = Math.floor(os.freemem() / limits.minMemoryPerJobBytes);
  return Math.max(0, Math.min(limits.maxConcurrentJobs, diskSlots, memorySlots));
}

export function estimateHlsOutputBytes(
  durationSeconds: number,
  renditions: ReadonlyArray<{ bitrate: string | number; audioBitrate?: string | number }>,
  safetyFactor = 1.3
): number {
  const bitrate = (value: string | number | undefined) => {
    if (value === undefined) return 0;
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?)([kmg])?$/i);
    if (!match) return 0;
    const multiplier = match[2]?.toLowerCase() === 'g' ? 1_000_000_000 : match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
    return Number(match[1]) * multiplier;
  };
  const bitsPerSecond = renditions.reduce((sum, rendition) => sum + bitrate(rendition.bitrate) + bitrate(rendition.audioBitrate), 0);
  return Math.ceil(Math.max(0, durationSeconds) * bitsPerSecond / 8 * safetyFactor);
}

export async function assertVideoDiskCapacity(requiredBytes = 0, root = getVideoTempRoot()): Promise<{ freeBytes: number; requiredBytes: number }> {
  await fs.promises.mkdir(root, { recursive: true });
  const stats = await fs.promises.statfs(root);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const threshold = getVideoJobLimits().minFreeBytes + Math.max(0, requiredBytes);
  if (freeBytes < threshold) {
    throw new Error(`Insufficient temporary disk space: ${freeBytes} bytes free, ${threshold} bytes required.`);
  }
  return { freeBytes, requiredBytes: threshold };
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

export async function createVideoWorkspace(jobId: string) {
  const root = getVideoTempRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'job';
  const workspace = path.join(root, `${safeJobId}-${crypto.randomUUID()}`);
  await fs.promises.mkdir(workspace, { recursive: false, mode: 0o700 });
  const markerPath = path.join(workspace, WORKSPACE_MARKER);
  const startedAt = Date.now();
  const heartbeat = async () => {
    await fs.promises.writeFile(markerPath, JSON.stringify({ jobId, pid: process.pid, hostname: HOSTNAME, startedAt, heartbeatAt: Date.now() }), { mode: 0o600 });
  };
  await heartbeat();
  const timer = setInterval(() => { void heartbeat().catch((error) => logger.warn({ error, jobId }, 'Video workspace heartbeat failed')); }, 60_000);
  timer.unref();

  return {
    path: workspace,
    cleanup: async () => {
      clearInterval(timer);
      const bytes = await getDirectoryBytes(workspace);
      await fs.promises.rm(workspace, { recursive: true, force: true });
      logger.info({ jobId, workspace, temporaryBytes: bytes, cleanup: 'removed' }, 'Video job workspace cleaned');
      return bytes;
    },
  };
}

async function getDirectoryBytes(root: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      const fullPath = path.join(root, entry.name);
      total += entry.isDirectory() ? await getDirectoryBytes(fullPath) : (await fs.promises.stat(fullPath)).size;
    }
  } catch {}
  return total;
}

export async function cleanupStaleVideoWorkspaces(now = Date.now()): Promise<{ removed: number; bytes: number; skippedActive: number }> {
  const root = getVideoTempRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const ttl = getVideoJobLimits().cleanupAgeMs;
  let removed = 0;
  let bytes = 0;
  let skippedActive = 0;

  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspace = path.resolve(root, entry.name);
    if (path.dirname(workspace) !== root) continue;
    const markerPath = path.join(workspace, WORKSPACE_MARKER);
    let marker: any;
    try {
      marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'));
    } catch {
      const stat = await fs.promises.stat(workspace).catch(() => null);
      if (!stat || now - stat.mtimeMs < ttl) continue;
      const dirBytes = await getDirectoryBytes(workspace);
      await fs.promises.rm(workspace, { recursive: true, force: true });
      removed++;
      bytes += dirBytes;
      continue;
    }

    const age = now - Number(marker.heartbeatAt || marker.startedAt || 0);
    if (marker.hostname === HOSTNAME && pidIsAlive(Number(marker.pid))) {
      skippedActive++;
      continue;
    }
    if (age < ttl) continue;

    const dirBytes = await getDirectoryBytes(workspace);
    await fs.promises.rm(workspace, { recursive: true, force: true });
    removed++;
    bytes += dirBytes;
  }

  logger.info({ root, removed, removedBytes: bytes, skippedActive }, 'Stale video workspace cleanup completed');
  return { removed, bytes, skippedActive };
}

async function getTreeSummary(root: string): Promise<{ bytes: number; newestMtime: number; files: string[] }> {
  let bytes = 0;
  let newestMtime = 0;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(fullPath);
        bytes += stat.size;
        newestMtime = Math.max(newestMtime, stat.mtimeMs);
        files.push(fullPath);
      }
    }
  };
  await walk(root);
  return { bytes, newestMtime, files };
}

let openFilesCache: Set<string> | null = null;

async function isOpenByAnyProcess(filePath: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (openFilesCache) return openFilesCache.has(filePath);
  openFilesCache = new Set<string>();
  let pids: string[];
  try {
    pids = (await fs.promises.readdir('/proc')).filter((name) => /^\d+$/.test(name));
  } catch {
    openFilesCache.add('*');
    return true;
  }
  for (const pid of pids) {
    let descriptors: string[];
    try {
      descriptors = await fs.promises.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const openPath = await fs.promises.readlink(`/proc/${pid}/fd/${descriptor}`);
        if (openPath.startsWith('/')) openFilesCache.add(openPath.replace(/ \(deleted\)$/, ''));
      } catch {}
    }
  }
  return openFilesCache.has('*') || openFilesCache.has(filePath);
}

export async function cleanupLegacyVideoArtifacts(now = Date.now()): Promise<{ removed: number; bytes: number; skippedActive: number }> {
  const configuredRoot = process.env.VIDEO_LEGACY_UPLOADS_ROOT;
  const uploadsRoots = configuredRoot
    ? [path.resolve(configuredRoot)]
    : [path.resolve(process.cwd(), 'uploads'), path.resolve(process.cwd(), '..', 'uploads')];
  const ttl = Math.max(24 * 60 * 60 * 1000, Number(process.env.VIDEO_LEGACY_CLEANUP_TTL_HOURS || 72) * 60 * 60 * 1000);
  const activeIds = new Set<string>();
  const [mediaFiles, movies, shows, episodes, jobs, remoteMedia, remoteMovies, remoteShows, remoteEpisodes] = await Promise.all([
    MediaFileModel.find({ hlsStatus: { $in: ['pending', 'processing'] } }).select('_id').lean(),
    MovieModel.find({ processingStatus: { $in: ['queued', 'processing'] } }).select('_id').lean(),
    TVShowModel.find({ processingStatus: { $in: ['queued', 'processing'] } }).select('_id').lean(),
    EpisodeModel.find({ processingStatus: { $in: ['queued', 'processing'] } }).select('_id').lean(),
    VideoProcessingJobModel.find({ status: { $in: ['queued', 'processing', 'uploading'] }, $or: [{ status: 'queued' }, { leaseExpiresAt: { $gt: new Date(now) } }] }).select('entityId').lean(),
    MediaFileModel.find({ hlsStatus: 'completed', hlsMasterPlaylistUrl: /^https?:\/\// }).select('_id').lean(),
    MovieModel.find({ hlsUrl: /^https?:\/\// }).select('_id').lean(),
    TVShowModel.find({ hlsUrl: /^https?:\/\// }).select('_id').lean(),
    EpisodeModel.find({ hlsUrl: /^https?:\/\// }).select('_id').lean(),
  ]);
  for (const doc of [...mediaFiles, ...movies, ...shows, ...episodes, ...jobs]) activeIds.add(String((doc as any)._id || (doc as any).entityId));
  const remoteHlsIds = new Set([...remoteMedia, ...remoteMovies, ...remoteShows, ...remoteEpisodes].map((doc: any) => String(doc._id)));

  let removed = 0;
  let bytes = 0;
  let skippedActive = 0;
  for (const uploadsRoot of new Set(uploadsRoots)) {
    const tempRoot = path.join(uploadsRoot, 'temp');
    const hlsRoot = path.join(uploadsRoot, 'hls');
    const removeIfStale = async (target: string, identity?: string) => {
      const safeTarget = path.resolve(target);
      if (!safeTarget.startsWith(`${uploadsRoot}${path.sep}`)) return;
      if (identity && activeIds.has(identity)) { skippedActive++; return; }
      if (identity && path.resolve(target).includes(`${path.sep}hls${path.sep}`) && !remoteHlsIds.has(identity)) { skippedActive++; return; }
      let summary: Awaited<ReturnType<typeof getTreeSummary>>;
      try { summary = await getTreeSummary(safeTarget); } catch { return; }
      if (summary.newestMtime && now - summary.newestMtime < ttl) return;
      for (const file of summary.files) {
        if (await isOpenByAnyProcess(file)) { skippedActive++; return; }
      }
      await fs.promises.rm(safeTarget, { recursive: true, force: true });
      removed++;
      bytes += summary.bytes;
    };

    if (await fs.promises.stat(tempRoot).catch(() => null)) {
      for (const entry of await fs.promises.readdir(tempRoot, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        await removeIfStale(path.join(tempRoot, entry.name));
      }
    }

    if (await fs.promises.stat(hlsRoot).catch(() => null)) {
      for (const typeEntry of await fs.promises.readdir(hlsRoot, { withFileTypes: true })) {
        if (!typeEntry.isDirectory()) continue;
        const typePath = path.join(hlsRoot, typeEntry.name);
        const isTypedRoot = ['movies', 'episodes', 'tvshows'].includes(typeEntry.name);
        if (isTypedRoot) {
          for (const idEntry of await fs.promises.readdir(typePath, { withFileTypes: true })) {
            if (idEntry.isDirectory()) await removeIfStale(path.join(typePath, idEntry.name), idEntry.name);
          }
        } else {
          await removeIfStale(typePath, typeEntry.name);
        }
      }
    }
  }

  openFilesCache = null;
  if (removed) logger.warn({ uploadsRoots, removed, removedBytes: bytes, skippedActive, ttlMs: ttl }, 'Removed stale legacy video artifacts');
  return { removed, bytes, skippedActive };
}