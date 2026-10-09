import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Types } from 'mongoose';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { fileURLToPath } from 'url';
import { MovieModel } from '../models/Movie';
import { logger } from '../lib/logger';
import { isS3Configured, uploadHlsFolderToS3, getHlsPublicBaseUrl, getS3PublicUrl, downloadFromS3ToFile } from '../lib/s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');
const TEMP_DIR = path.resolve(__dirname, '../../uploads/temp');

const ffmpegPath = ffmpegInstaller?.path || 'ffmpeg';
const ffprobePath = ffprobeInstaller?.path || 'ffprobe';

// ─────────────────────────────────────────────────────────────────────────────
// All 7 quality renditions with Netflix-grade bitrate settings
// ─────────────────────────────────────────────────────────────────────────────
export const HLS_QUALITY_LADDER = [
  { name: '144p',  width: 256,  height: 144,  bitrate: '100k',  maxrate: '110k',   bufsize: '150k',   audioBitrate: '48k'  },
  { name: '240p',  width: 426,  height: 240,  bitrate: '400k',  maxrate: '428k',   bufsize: '600k',   audioBitrate: '64k'  },
  { name: '360p',  width: 640,  height: 360,  bitrate: '800k',  maxrate: '856k',   bufsize: '1200k',  audioBitrate: '96k'  },
  { name: '480p',  width: 854,  height: 480,  bitrate: '1400k', maxrate: '1498k',  bufsize: '2100k',  audioBitrate: '128k' },
  { name: '720p',  width: 1280, height: 720,  bitrate: '2800k', maxrate: '2996k',  bufsize: '4200k',  audioBitrate: '128k' },
  { name: '1080p', width: 1920, height: 1080, bitrate: '5000k', maxrate: '5350k',  bufsize: '7500k',  audioBitrate: '192k' },
  { name: '1440p', width: 2560, height: 1440, bitrate: '8000k', maxrate: '8560k',  bufsize: '12000k', audioBitrate: '192k' },
  { name: '2160p', width: 3840, height: 2160, bitrate: '16000k',maxrate: '17120k', bufsize: '24000k', audioBitrate: '192k' },
] as const;

export type QualityName = typeof HLS_QUALITY_LADDER[number]['name'];

// Bandwidth values for master.m3u8 BANDWIDTH attribute (bits/s)
const BANDWIDTH_MAP: Record<QualityName, number> = {
  '144p':  100_000,
  '240p':  400_000,
  '360p':  800_000,
  '480p':  1_400_000,
  '720p':  2_800_000,
  '1080p': 5_000_000,
  '1440p': 8_000_000,
  '2160p': 16_000_000,
};

const RESOLUTION_MAP: Record<QualityName, string> = {
  '144p':  '256x144',
  '240p':  '426x240',
  '360p':  '640x360',
  '480p':  '854x480',
  '720p':  '1280x720',
  '1080p': '1920x1080',
  '1440p': '2560x1440',
  '2160p': '3840x2160',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const runCommand = (command: string, args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
};

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const countFiles = (folderPath: string): number =>
  fs.readdirSync(folderPath, { withFileTypes: true }).reduce((count, entry) => {
    const entryPath = path.join(folderPath, entry.name);
    return count + (entry.isDirectory() ? countFiles(entryPath) : entry.isFile() ? 1 : 0);
  }, 0);

const validateEpisodeHlsOutput = (
  hlsFolder: string,
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>
) => {
  const masterPath = path.join(hlsFolder, 'master.m3u8');
  if (!fs.existsSync(masterPath)) throw new Error('Episode HLS master playlist was not generated');
  const masterLines = fs.readFileSync(masterPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!masterLines.includes('#EXTM3U')) throw new Error('Episode HLS master playlist is invalid');

  for (const quality of qualities) {
    const variantPath = path.join(hlsFolder, quality.name, 'playlist.m3u8');
    if (!masterLines.includes(`${quality.name}/playlist.m3u8`) || !fs.existsSync(variantPath)) {
      throw new Error(`Episode HLS ${quality.name} playlist is missing`);
    }
    const variantLines = fs.readFileSync(variantPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const segments = variantLines.filter((line) => !line.startsWith('#'));
    if (!variantLines.includes('#EXTM3U') || !variantLines.includes('#EXT-X-ENDLIST') || segments.length === 0) {
      throw new Error(`Episode HLS ${quality.name} playlist is incomplete`);
    }
    for (const segment of segments) {
      if (!fs.existsSync(path.resolve(path.dirname(variantPath), segment))) {
        throw new Error(`Episode HLS segment is missing: ${quality.name}/${segment}`);
      }
    }
  }
};

export const toLocalUploadPath = (urlPath: string): string | null => {
  if (!urlPath) return null;
  let relPath = urlPath;
  if (relPath.startsWith('/uploads/')) relPath = relPath.replace('/uploads/', '');
  else if (relPath.startsWith('uploads/')) relPath = relPath.replace('uploads/', '');
  else if (relPath.startsWith('/media/')) relPath = relPath.replace('/', '');
  return path.join(UPLOADS_ROOT, relPath);
};

const getFolderSize = (folderPath: string): number => {
  try {
    if (!fs.existsSync(folderPath)) return 0;
    const walk = (dir: string): number => {
      let size = 0;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name);
        size += f.isDirectory() ? walk(fp) : fs.statSync(fp).size;
      }
      return size;
    };

    return walk(folderPath);
  } catch { return 0; }
};

/**
 * Probe source video resolution using ffprobe.
 * Returns { width, height } or null on failure.
 */
const probeResolution = async (inputPath: string): Promise<{ width: number; height: number } | null> => {
  try {
    const output = await runCommand(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      inputPath,
    ]);
    const parts = output.trim().split(',');
    if (parts.length >= 2) {
      const w = parseInt(parts[0], 10);
      const h = parseInt(parts[1], 10);
      if (!isNaN(w) && !isNaN(h)) return { width: w, height: h };
    }
  } catch (err) {
    logger.warn({ err }, 'ffprobe resolution detection failed — will use all qualities');
  }
  return null;
};

/**
 * Probe source video duration using ffprobe.
 * Returns duration in seconds (float) or null on failure.
 */
const probeDuration = async (inputPath: string): Promise<number | null> => {
  try {
    const output = await runCommand(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);
    const val = parseFloat(output.trim());
    if (!isNaN(val) && val > 0) return Math.round(val);
  } catch (err) {
    logger.warn({ err }, 'ffprobe duration detection failed');
  }
  return null;
};

// Public export so controllers can probe duration without triggering a full transcode
export const probeVideoDuration = probeDuration;

/**
 * Filter quality ladder to only include renditions whose height
 * does not exceed the source video's height. Always guarantees at least 1 rendition.
 */
const filterQualitiesByResolution = (
  sourceHeight: number
) => {
  const maxH = sourceHeight || 1080;
  let matches = HLS_QUALITY_LADDER.filter((q) => q.height <= maxH);
  if (matches.length === 0) {
    matches = [HLS_QUALITY_LADDER[0]]; // fallback to 144p
  }
  // Cap to maximum of 2 ladders (Base + Original) for VERY FAST processing
  if (matches.length > 2) {
    matches = [
      matches.find((q) => q.name === '360p') || matches[0],
      matches[matches.length - 1],
    ].filter((v, i, a) => a.findIndex((t) => t.name === v.name) === i) as any;
  }
  return matches;
};

export const extractS3Key = (source: string): string | null => {
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    try {
      const parsed = new URL(source);
      return parsed.pathname.replace(/^\/+/, '').replace(/^uploads\//, '');
    } catch {
      return null;
    }
  }
  return source.replace(/^\/*uploads\//, '').replace(/^\/+/, '');
};

// ─────────────────────────────────────────────────────────────────────────────
// Core HLS Transcoder — Single-pass multi-variant FFmpeg (local storage)
// ─────────────────────────────────────────────────────────────────────────────
export const transcodeHlsMultiResolution = async (options: {
  id: string;
  sourceVideoUrl: string;
  startSeconds?: number;
  duration?: number;
  folderType?: 'movies' | 'episodes';
}) => {
  const { id, sourceVideoUrl, startSeconds, duration, folderType = 'movies' } = options;
  let tempSourcePath: string | null = null;

  try {
    ensureDir(TEMP_DIR);

    // ── Resolve input path (local file, or download remote/S3/Spaces source to temp) ──
    let ffmpegInput: string | null = null;
    const sourceVideoPath = toLocalUploadPath(sourceVideoUrl);

    if (sourceVideoPath && fs.existsSync(sourceVideoPath)) {
      ffmpegInput = sourceVideoPath;
    } else {
      const s3Active = await isS3Configured();
      const s3Key = extractS3Key(sourceVideoUrl);

      if (s3Active && s3Key) {
        tempSourcePath = path.join(
          TEMP_DIR,
          `media-source-${id}-${Date.now()}${path.extname(s3Key) || '.mp4'}`
        );
        logger.info({ id, s3Key, tempSourcePath }, 'Downloading remote video for HLS transcoding');
        await downloadFromS3ToFile(s3Key, tempSourcePath);
        if (fs.existsSync(tempSourcePath) && fs.statSync(tempSourcePath).size > 0) {
          ffmpegInput = tempSourcePath;
        } else {
          throw new Error(`Authenticated download produced empty file for key: ${s3Key}`);
        }
      } else if (sourceVideoUrl.startsWith('http://') || sourceVideoUrl.startsWith('https://')) {
        ffmpegInput = sourceVideoUrl;
      }
    }

    if (!ffmpegInput || !fs.existsSync(ffmpegInput)) {
      throw new Error(`Source video not found or could not be downloaded: ${sourceVideoUrl}`);
    }

    // ── Determine local HLS output folder ──────────────────────────────────
    const hlsFolder    = path.join(UPLOADS_ROOT, 'hls', folderType, id);
    const localUrlBase = `/uploads/hls/${folderType}/${id}`;

    // Clear any existing HLS files to prevent mixing old and new uploads
    if (fs.existsSync(hlsFolder)) {
      try {
        fs.rmSync(hlsFolder, { recursive: true, force: true });
      } catch (rmErr) {
        logger.warn({ rmErr, hlsFolder }, 'Failed to clear existing HLS folder');
      }
    }
    ensureDir(hlsFolder);

    // ── Detect source resolution & duration ────────────────────────────────
    const [sourceRes, detectedDurationSeconds] = await Promise.all([
      probeResolution(ffmpegInput),
      probeDuration(ffmpegInput),
    ]);
    const sourceHeight = sourceRes?.height ?? 1080;
    const qualities = filterQualitiesByResolution(sourceHeight);
    logger.info(
      { id, sourceHeight, detectedDurationSeconds, qualityCount: qualities.length, mode: 'sequential-safe' },
      'Starting HLS transcoding'
    );

    const s3Active = await isS3Configured();
    const revision = folderType === 'episodes' ? `/${Date.now()}` : '';
    const s3Prefix = `hls/${folderType}/${id}${revision}`;

    const hlsResult = await transcodeHlsSequential({
      startSeconds,
      duration,
      qualities,
      hlsFolder,
      localUrlBase,
      ffmpegInput,
      movieId: id,
      folderType,
      s3Active,
      s3Prefix
    });

    return {
      ...hlsResult,
      detectedDurationSeconds,
    };
  } finally {
    if (tempSourcePath && fs.existsSync(tempSourcePath)) {
      try {
        fs.unlinkSync(tempSourcePath);
        logger.info({ id, tempSourcePath }, 'Cleaned up temporary source video file');
      } catch (cleanupErr) {
        logger.warn({ cleanupErr, tempSourcePath }, 'Failed to clean up temporary source video file');
      }
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Sequential (one quality at a time — required on low-RAM EC2 to avoid OOM)
// ─────────────────────────────────────────────────────────────────────────────
const transcodeHlsSequential = async (opts: {
  startSeconds?: number;
  duration?: number;
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>;
  hlsFolder: string;
  localUrlBase: string;
  ffmpegInput: string;
  movieId: string;
  folderType?: 'movies' | 'episodes';
  s3Active?: boolean;
  s3Prefix?: string;
}) => {
  const { startSeconds, duration, qualities, hlsFolder, localUrlBase, ffmpegInput, movieId, folderType = 'movies', s3Active, s3Prefix } = opts;

  for (const q of qualities) {
    const qFolder = path.join(hlsFolder, q.name);
    ensureDir(qFolder);

    const args: string[] = ['-y'];
    if (startSeconds !== undefined && startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push('-i', ffmpegInput);
    if (duration !== undefined && duration > 0) args.push('-t', String(duration));

    args.push(
      '-threads',      '0',
      '-c:v',          'libx264',
      '-preset',       'ultrafast',
      '-g',            '48',
      '-sc_threshold', '0',
      '-keyint_min',   '48',
      '-vf',           `scale=w='if(gt(iw,ih),-2,${q.height})':h='if(gt(iw,ih),${q.height},-2)'`,
      '-b:v',          q.bitrate,
      '-maxrate',      q.maxrate,
      '-bufsize',      q.bufsize,
      '-profile:v',    'main',
      '-c:a',          'aac',
      '-b:a',          '128k',
      '-ac',           '2',
      '-ar',           '48000',
      '-f',            'hls',
      '-hls_time',     '4',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(qFolder, 'segment_%03d.ts'),
      path.join(qFolder, 'playlist.m3u8')
    );

    await runCommand(ffmpegPath, args);
    logger.info({ quality: q.name }, 'Sequential quality encoded');
    
    // Check quality playlist validity
    const variantPath = path.join(qFolder, 'playlist.m3u8');
    if (!fs.existsSync(variantPath)) {
      throw new Error(`HLS ${q.name} playlist is missing`);
    }
    const variantLines = fs.readFileSync(variantPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const segments = variantLines.filter((line) => !line.startsWith('#'));
    if (!variantLines.includes('#EXTM3U') || !variantLines.includes('#EXT-X-ENDLIST') || segments.length === 0) {
      throw new Error(`HLS ${q.name} playlist is incomplete`);
    }

    const folderSize = getFolderSize(qFolder);
    q.folderSize = folderSize; // attach size for later

    if (s3Active && s3Prefix) {
      const { uploadHlsFolderToS3 } = require('../lib/s3');
      await uploadHlsFolderToS3(qFolder, `${s3Prefix}/${q.name}`);
      logger.info({ quality: q.name }, 'Sequential quality uploaded to DO Spaces');
      fs.rmSync(qFolder, { recursive: true, force: true });
    }
  }

  // Rebuild master.m3u8
  writeMasterPlaylist(hlsFolder, qualities);
  // (Validation is now done sequentially per quality)

  const out = await buildLocalHlsOutput({ qualities, hlsFolder, localUrlBase, movieId, folderType, s3Active: opts.s3Active, s3Prefix: opts.s3Prefix });
  return {
    hlsUrl:         out.masterUrl,
    videoQualities: out.renditions,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Master playlist + local output map
// ─────────────────────────────────────────────────────────────────────────────
const writeMasterPlaylist = (
  hlsFolder: string,
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>
) => {
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const q of qualities) {
    const bandwidth  = BANDWIDTH_MAP[q.name as QualityName];
    const resolution = RESOLUTION_MAP[q.name as QualityName];
    masterLines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},NAME="${q.name}"`,
      `${q.name}/playlist.m3u8`,
    );
  }
  fs.writeFileSync(path.join(hlsFolder, 'master.m3u8'), masterLines.join('\n'), 'utf-8');
};

const buildLocalHlsOutput = async (opts: {
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>;
  hlsFolder: string;
  localUrlBase: string;
  movieId: string;
  folderType?: 'movies' | 'episodes';
  s3Active?: boolean;
  s3Prefix?: string;
}) => {
  const { qualities, hlsFolder, localUrlBase, movieId, folderType = 'movies', s3Active, s3Prefix } = opts;

  if (s3Active && s3Prefix) {
    // Only upload the master playlist, qualities were uploaded sequentially
    const { uploadHlsFolderToS3 } = require('../lib/s3');
    await uploadHlsFolderToS3(hlsFolder, s3Prefix);
    
    const baseUrl = await getHlsPublicBaseUrl();
    const masterUrl = `${baseUrl}/${s3Prefix}/master.m3u8`;
    const renditions = qualities.map((q) => ({
      quality: q.name as QualityName,
      url: `${baseUrl}/${s3Prefix}/${q.name}/playlist.m3u8`,
      size: (q as any).folderSize || 0,
    }));
    try { fs.rmSync(hlsFolder, { recursive: true, force: true }); } catch { /* ignore */ }
    return { masterUrl, renditions };
  }

  const masterUrl = `${localUrlBase}/master.m3u8`;
  const renditions = qualities.map((q) => ({
    quality: q.name as QualityName,
    url: `${localUrlBase}/${q.name}/playlist.m3u8`,
    size: (q as any).folderSize || getFolderSize(path.join(hlsFolder, q.name)),
  }));
  return { masterUrl, renditions };
};

// ─────────────────────────────────────────────────────────────────────────────
// Public processors — Movies
// ─────────────────────────────────────────────────────────────────────────────
export const processMovieHls = async (movieId: Types.ObjectId | string, sourceVideoUrl: string) => {
  try {
    // Never accept a trailer as the movie source
    if (/trailer/i.test(sourceVideoUrl)) {
      throw new Error(`Refusing to build movie HLS from trailer URL: ${sourceVideoUrl}`);
    }

    await MovieModel.findByIdAndUpdate(movieId, { processingStatus: 'processing' });

    const result = await transcodeHlsMultiResolution({
      id: movieId.toString(),
      sourceVideoUrl,
    });

    const existing = await MovieModel.findById(movieId).select('trailerUrl').lean();
    const trailer = String((existing as any)?.trailerUrl || '');
    if (trailer && sourceVideoUrl.trim() === trailer.trim()) {
      throw new Error('Refusing to overwrite movie with trailer URL');
    }

    await MovieModel.findByIdAndUpdate(movieId, {
      hlsUrl:          result.hlsUrl,
      videoUrl:        sourceVideoUrl,
      sourceVideoUrl,
      videoQualities:  result.videoQualities,
      status:          'published',
      processingStatus:'ready',
      processingError: null,
    });

    logger.info({ movieId, hlsUrl: result.hlsUrl }, 'Movie HLS processing complete');
  } catch (error: any) {
    logger.error({ error, movieId }, 'Error processing movie HLS');
    await MovieModel.findByIdAndUpdate(movieId, {
      processingStatus: 'failed',
      processingError:  error.message,
    });
  }
};

type MovieHlsJob = {
  movieId: Types.ObjectId | string;
  sourceVideoUrl: string;
};

const movieHlsQueue: MovieHlsJob[] = [];
let movieHlsWorkerRunning = false;

const runMovieHlsQueue = async () => {
  if (movieHlsWorkerRunning) return;

  movieHlsWorkerRunning = true;

  try {
    while (movieHlsQueue.length > 0) {
      const job = movieHlsQueue.shift();

      if (!job) continue;

      logger.info(
        {
          movieId: job.movieId.toString(),
          remainingJobs: movieHlsQueue.length,
        },
        'Starting queued movie HLS job'
      );

      await processMovieHls(job.movieId, job.sourceVideoUrl);

      logger.info(
        {
          movieId: job.movieId.toString(),
          remainingJobs: movieHlsQueue.length,
        },
        'Queued movie HLS job finished'
      );
    }
  } finally {
    movieHlsWorkerRunning = false;
  }
};

export const processMovieInBackground = (
  movieId: Types.ObjectId | string,
  sourceVideoUrl: string
) => {
  movieHlsQueue.push({
    movieId,
    sourceVideoUrl,
  });

  logger.info(
    {
      movieId: movieId.toString(),
      queueLength: movieHlsQueue.length,
    },
    'Movie HLS job added to queue'
  );

  setImmediate(() => {
    void runMovieHlsQueue();
  });
};

export const processEpisodeHls = async (episodeId: Types.ObjectId | string, sourceVideoUrl: string) => {
  try {
    const { EpisodeModel } = await import('../models/Episode');
    await EpisodeModel.findByIdAndUpdate(episodeId, { processingStatus: 'processing' });

    const result = await transcodeHlsMultiResolution({
      id: episodeId.toString(),
      sourceVideoUrl,
      folderType: 'episodes', // Isolated from movies
    });

    // Build the update object — always set hlsUrl + status
    const episodeUpdate: any = {
      hlsUrl:           result.hlsUrl,
      videoQualities:   result.videoQualities,
      processingStatus: 'ready',
      processingError:  null,
    };

    // Auto-save detected duration (only update if not already set by admin)
    if (result.detectedDurationSeconds && result.detectedDurationSeconds > 0) {
      const existing = await EpisodeModel.findById(episodeId).select('duration').lean();
      if (!existing?.duration || existing.duration === 0) {
        episodeUpdate.duration = result.detectedDurationSeconds;
        logger.info(
          { episodeId, detectedDurationSeconds: result.detectedDurationSeconds },
          'Auto-saved episode duration from ffprobe'
        );
      }
    }

    await EpisodeModel.findByIdAndUpdate(episodeId, episodeUpdate);

    logger.info({ episodeId, hlsUrl: result.hlsUrl }, 'Episode HLS processing complete');
  } catch (error: any) {
    logger.error({ episodeId, error }, 'Episode HLS processing failed');
    const { EpisodeModel } = await import('../models/Episode');
    await EpisodeModel.findByIdAndUpdate(episodeId, {
      processingStatus: 'failed',
      processingError: error.message || 'Unknown processing error',
    });
  }
};

type EpisodeHlsJob = {
  episodeId: Types.ObjectId | string;
  sourceVideoUrl: string;
};

const episodeHlsQueue: EpisodeHlsJob[] = [];
let episodeHlsWorkerRunning = false;

const runEpisodeHlsQueue = async () => {
  if (episodeHlsWorkerRunning) return;

  episodeHlsWorkerRunning = true;

  try {
    while (episodeHlsQueue.length > 0) {
      const job = episodeHlsQueue.shift();

      if (!job) continue;

      logger.info(
        {
          episodeId: job.episodeId.toString(),
          remainingJobs: episodeHlsQueue.length,
        },
        'Starting queued episode HLS job'
      );

      await processEpisodeHls(job.episodeId, job.sourceVideoUrl);

      logger.info(
        {
          episodeId: job.episodeId.toString(),
          remainingJobs: episodeHlsQueue.length,
        },
        'Queued episode HLS job finished'
      );
    }
  } finally {
    episodeHlsWorkerRunning = false;
  }
};

export const processEpisodeInBackground = (
  episodeId: Types.ObjectId | string,
  sourceVideoUrl: string
) => {
  episodeHlsQueue.push({
    episodeId,
    sourceVideoUrl,
  });

  logger.info(
    {
      episodeId: episodeId.toString(),
      queueLength: episodeHlsQueue.length,
    },
    'Episode HLS job added to queue'
  );

  setImmediate(() => {
    void runEpisodeHlsQueue();
  });
};

export const processTVShowHls = async (tvShowId: Types.ObjectId | string, sourceVideoUrl: string) => {
  try {
    const { TVShowModel } = await import('../models/TVShow');
    await TVShowModel.findByIdAndUpdate(tvShowId, { processingStatus: 'processing' });

    const result = await transcodeHlsMultiResolution({
      id: tvShowId.toString(),
      sourceVideoUrl,
      folderType: 'movies',
    });

    await TVShowModel.findByIdAndUpdate(tvShowId, {
      hlsUrl: result.hlsUrl,
      videoUrl: sourceVideoUrl,
      sourceVideoUrl,
      videoQualities: result.videoQualities,
      processingStatus: 'ready',
      processingError: null,
    });

    logger.info({ tvShowId, hlsUrl: result.hlsUrl }, 'TV show HLS processing complete');
  } catch (error: any) {
    logger.error({ error, tvShowId }, 'Error processing TV show HLS');
    const { TVShowModel } = await import('../models/TVShow');
    await TVShowModel.findByIdAndUpdate(tvShowId, {
      processingStatus: 'failed',
      processingError: error.message,
    });
  }
};

export const processTVShowInBackground = (tvShowId: Types.ObjectId | string, sourceVideoUrl: string) => {
  setImmediate(async () => {
    await processTVShowHls(tvShowId, sourceVideoUrl);
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect HLS qualities already on disk and sync them to MongoDB
// ─────────────────────────────────────────────────────────────────────────────
export const autoDetectAndSyncQualities = async (
  id: Types.ObjectId | string,
  type: 'movie' | 'episode' | 'tvShow' = 'movie'
): Promise<any> => {
  const Model =
    type === 'episode'
      ? (await import('../models/Episode')).EpisodeModel
      : type === 'tvShow'
        ? (await import('../models/TVShow')).TVShowModel
        : MovieModel;
  const folderType = type === 'episode' ? 'episodes' : 'movies';

  const doc = await (Model as any).findById(id).lean();
  if (!doc) return null;

  const hlsFolder = path.join(UPLOADS_ROOT, 'hls', folderType, id.toString());
  const masterPlaylistPath = path.join(hlsFolder, 'master.m3u8');

  if (fs.existsSync(masterPlaylistPath)) {
    const validQualities = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];
    const detectedQualities: string[] = [];

    const dirs = fs.readdirSync(hlsFolder, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory() && validQualities.includes(dir.name)) {
        const qualityPlaylistPath = path.join(hlsFolder, dir.name, 'playlist.m3u8');
        if (fs.existsSync(qualityPlaylistPath)) {
          detectedQualities.push(dir.name);
        }
      }
    }

    if (detectedQualities.length > 0) {
      const hlsUrl = `/uploads/hls/${folderType}/${id}/master.m3u8`;
      const videoQualities = detectedQualities.map(q => ({
        quality: q,
        url: `/uploads/hls/${folderType}/${id}/${q}/playlist.m3u8`,
        size: getFolderSize(path.join(hlsFolder, q))
      }));

      // Check if we need to update
      const currentQualitiesStr = JSON.stringify(doc.videoQualities || []);
      const newQualitiesStr = JSON.stringify(videoQualities);
      const hasDiff = currentQualitiesStr !== newQualitiesStr ||
                      doc.processingStatus !== 'ready' ||
                      (doc as any).hlsUrl !== hlsUrl;

      if (hasDiff) {
        logger.info({ id: id.toString(), qualityCount: videoQualities.length }, 'Syncing auto-detected HLS qualities to MongoDB');

        const updateData: any = {
          hlsUrl,
          videoQualities,
          processingStatus: 'ready',
          processingError: null,
        };

        if ((doc as any).status === 'draft' || !(doc as any).status || (doc as any).status === 'processing') {
          updateData.status = 'published';
        }

        const updatedDoc = await (Model as any).findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean();
        return updatedDoc;
      }
      return doc;
    }
  }
  return doc;
};
