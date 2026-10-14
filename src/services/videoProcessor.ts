import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Types } from 'mongoose';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { MovieModel } from '../models/Movie';
import { logger } from '../lib/logger';
import { deleteS3Prefix, downloadFromS3ToFile, ensureVideoSourceInSpaces, getHlsPublicBaseUrl, requireSpacesSettings, uploadHlsFolderToS3, validateHlsPackage } from '../lib/s3';
import { assertVideoDiskCapacity, createVideoWorkspace, estimateHlsOutputBytes } from '../lib/videoJobRuntime';

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

const runCommandWithProgress = (
  command: string,
  args: string[],
  onProgress?: (data: { timeSeconds: number; speed?: string }) => void
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onProgress) {
        const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
        const speedMatch = text.match(/speed=\s*([\d\.]+x)/);
        if (timeMatch) {
          const hours = parseFloat(timeMatch[1]);
          const mins = parseFloat(timeMatch[2]);
          const secs = parseFloat(timeMatch[3]);
          const totalSecs = hours * 3600 + mins * 60 + secs;
          onProgress({ timeSeconds: totalSecs, speed: speedMatch ? speedMatch[1] : undefined });
        }
      }
    });
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
  return matches;
};

// ─────────────────────────────────────────────────────────────────────────────
// Core HLS Transcoder — Single-pass multi-variant FFmpeg (local storage)
// ─────────────────────────────────────────────────────────────────────────────
export const transcodeHlsMultiResolution = async (options: {
  id: string;
  sourceVideoUrl: string;
  sourceVideoKey?: string;
  jobId?: string;
  startSeconds?: number;
  duration?: number;
  folderType?: 'movies' | 'episodes' | 'tvshows';
  onProgress?: (progress: number, step: string, etaSeconds?: number | null) => Promise<void> | void;
}) => {
  const { id, sourceVideoUrl, startSeconds, duration, folderType = 'movies', onProgress } = options;
  await requireSpacesSettings();
  await onProgress?.(5, 'Preparing source video...', null);
  const source = await ensureVideoSourceInSpaces(sourceVideoUrl, folderType, id, options.sourceVideoKey);
  const workspace = await createVideoWorkspace(`${folderType}-${id}-${options.jobId || Date.now()}`);
  const tempSourcePath = path.join(workspace.path, `source${path.extname(source.key) || '.mp4'}`);
  const hlsFolder = path.join(workspace.path, 'hls');
  const s3Prefix = `hls/${folderType}/${id}/${options.jobId || Date.now()}`;
  try {
    await assertVideoDiskCapacity(source.size * 2, workspace.path);
    await onProgress?.(8, 'Downloading source video...', null);
    await downloadFromS3ToFile(source.key, tempSourcePath);
    await fs.promises.mkdir(hlsFolder, { recursive: true });

    // ── Detect source resolution & duration ────────────────────────────────
    await onProgress?.(10, 'Analyzing video resolution & duration...', null);
    const [sourceRes, detectedDurationSeconds] = await Promise.all([
      probeResolution(tempSourcePath),
      probeDuration(tempSourcePath),
    ]);
    const sourceHeight = sourceRes?.height ?? 1080;
    const qualities = filterQualitiesByResolution(sourceHeight);
    const estimatedHlsBytes = estimateHlsOutputBytes(detectedDurationSeconds || 0, qualities.map((quality) => ({ bitrate: quality.bitrate, audioBitrate: quality.audioBitrate })));
    await assertVideoDiskCapacity(estimatedHlsBytes, workspace.path);
    logger.info(
      { id, sourceHeight, detectedDurationSeconds, qualityCount: qualities.length, mode: 'sequential-safe' },
      'Starting HLS transcoding'
    );

    const hlsResult = await transcodeHlsSequential({
      startSeconds,
      duration: duration || detectedDurationSeconds || undefined,
      totalDuration: detectedDurationSeconds || duration || 60,
      qualities,
      hlsFolder,
      ffmpegInput: tempSourcePath,
      movieId: id,
      folderType,
      s3Prefix,
      jobId: options.jobId || id,
      onProgress,
    });

    return {
      ...hlsResult,
      detectedDurationSeconds,
      sourceVideoKey: source.key,
      sourceVideoUrl: source.url,
    };
  } catch (error) {
    await deleteS3Prefix(s3Prefix).catch((cleanupError) => logger.error({ cleanupError, id, s3Prefix }, 'Failed to remove partial HLS upload'));
    throw error;
  } finally {
    await workspace.cleanup();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Sequential (one quality at a time — required on low-RAM EC2 to avoid OOM)
// ─────────────────────────────────────────────────────────────────────────────
const transcodeHlsSequential = async (opts: {
  startSeconds?: number;
  duration?: number;
  totalDuration?: number;
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>;
  hlsFolder: string;
  ffmpegInput: string;
  movieId: string;
  folderType?: 'movies' | 'episodes' | 'tvshows';
  s3Prefix: string;
  jobId: string;
  onProgress?: (progress: number, step: string, etaSeconds?: number | null) => Promise<void> | void;
}) => {
  const { startSeconds, duration, totalDuration = 60, qualities, hlsFolder, ffmpegInput, movieId, folderType = 'movies', s3Prefix, jobId, onProgress } = opts;
  const startTime = Date.now();
  const Q = qualities.length;

  for (let qIdx = 0; qIdx < Q; qIdx++) {
    const q = qualities[qIdx];
    const qFolder = path.join(hlsFolder, q.name);
    ensureDir(qFolder);

    const basePercent = 10 + (qIdx / Q) * 70;
    const qWeight = 70 / Q;

    await onProgress?.(
      Math.round(basePercent),
      `Transcoding ${q.name} (${qIdx + 1}/${Q})...`,
      null
    );

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

    await runCommandWithProgress(ffmpegPath, args, (prog) => {
      const progressInQ = Math.min(0.98, prog.timeSeconds / Math.max(1, totalDuration));
      const overall = Math.min(80, Math.round(basePercent + progressInQ * qWeight));
      const elapsed = (Date.now() - startTime) / 1000;
      let eta: number | null = null;
      if (overall > 5 && elapsed > 2) {
        const estTotal = (elapsed / overall) * 100;
        eta = Math.max(1, Math.round(estTotal - elapsed));
      }
      void onProgress?.(overall, `Transcoding ${q.name} (${qIdx + 1}/${Q})...`, eta);
    });
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
    (q as any).folderSize = folderSize; // attach size for later

  }

  // Rebuild master.m3u8
  await onProgress?.(81, 'Generating master playlist...', null);
  writeMasterPlaylist(hlsFolder, qualities);
  const out = await buildSpacesHlsOutput({
    qualities,
    hlsFolder,
    s3Prefix,
    jobId,
    onUploadProgress: (uploaded, total) => {
      const uploadPercent = Math.min(98, Math.round(82 + (uploaded / Math.max(1, total)) * 16));
      const elapsed = (Date.now() - startTime) / 1000;
      const eta = uploadPercent > 10 && elapsed > 2 ? Math.max(1, Math.round(((elapsed / uploadPercent) * 100) - elapsed)) : null;
      void onProgress?.(uploadPercent, `Uploading HLS files (${uploaded}/${total})...`, eta);
    },
  });
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

const buildSpacesHlsOutput = async (opts: {
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>;
  hlsFolder: string;
  s3Prefix: string;
  jobId: string;
  onUploadProgress?: (uploaded: number, total: number) => void;
}) => {
  const { qualities, hlsFolder, s3Prefix, jobId, onUploadProgress } = opts;
  const relativeFiles: string[] = [];
  const collectFiles = (directory: string, base = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(base, entry.name);
      if (entry.isDirectory()) collectFiles(path.join(directory, entry.name), relative);
      else if (entry.isFile()) relativeFiles.push(relative);
    }
  };
  collectFiles(hlsFolder);
  validateEpisodeHlsOutput(hlsFolder, qualities);
  validateHlsPackage(hlsFolder, relativeFiles);
  const queue = await import('./videoProcessingQueue');
  await queue.markVideoJobUploading(jobId);
  const uploadedCount = await uploadHlsFolderToS3(hlsFolder, s3Prefix, {
    onProgress: (uploaded, total) => {
      if (onUploadProgress) onUploadProgress(uploaded, total);
    },
  });
  if (uploadedCount !== relativeFiles.length) {
    throw new Error(`Partial HLS package upload: ${uploadedCount}/${relativeFiles.length} objects verified`);
  }
  const baseUrl = await getHlsPublicBaseUrl();
  const masterUrl = `${baseUrl}/${s3Prefix}/master.m3u8`;
  const renditions = qualities.map((q) => ({
    quality: q.name as QualityName,
    url: `${baseUrl}/${s3Prefix}/${q.name}/playlist.m3u8`,
    size: (q as any).folderSize || getFolderSize(path.join(hlsFolder, q.name)),
  }));
  return { masterUrl, renditions };
};

// ─────────────────────────────────────────────────────────────────────────────
// Public processors — Movies
// ─────────────────────────────────────────────────────────────────────────────
export const processMovieHls = async (movieId: Types.ObjectId | string, sourceVideoUrl: string, jobId = movieId.toString()) => {
  try {
    // Never accept a trailer as the movie source
    if (/trailer/i.test(sourceVideoUrl)) {
      throw new Error(`Refusing to build movie HLS from trailer URL: ${sourceVideoUrl}`);
    }

    await MovieModel.findByIdAndUpdate(movieId, { processingStatus: 'processing' });

    const result = await transcodeHlsMultiResolution({
      id: movieId.toString(),
      sourceVideoUrl,
      sourceVideoKey: (await MovieModel.findById(movieId).select('sourceVideoKey').lean() as any)?.sourceVideoKey,
      jobId,
    });

    const existing = await MovieModel.findById(movieId).select('trailerUrl').lean();
    const trailer = String((existing as any)?.trailerUrl || '');
    if (trailer && sourceVideoUrl.trim() === trailer.trim()) {
      throw new Error('Refusing to overwrite movie with trailer URL');
    }

    const queue = await import('./videoProcessingQueue');
    await queue.assertVideoJobLease(jobId);

    await MovieModel.findByIdAndUpdate(movieId, {
      hlsUrl:          result.hlsUrl,
      videoUrl:        result.sourceVideoUrl,
      sourceVideoUrl:  result.sourceVideoUrl,
      sourceVideoKey:  result.sourceVideoKey,
      videoQualities:  result.videoQualities,
      status:          'published',
      processingStatus:'ready',
      processingError: null,
    });

    logger.info({ movieId, hlsUrl: result.hlsUrl }, 'Movie HLS processing complete');
  } catch (error: any) {
    logger.error({ error, movieId }, 'Error processing movie HLS');
    const queue = await import('./videoProcessingQueue');
    if (await queue.ownsVideoJobLease(jobId).catch(() => false)) {
      await MovieModel.findByIdAndUpdate(movieId, { processingStatus: 'failed', processingError: error.message });
    }
    throw error;
  }
};

export const processMovieInBackground = (
  movieId: Types.ObjectId | string,
  sourceVideoUrl: string
) => {
  void import('./videoProcessingQueue')
    .then(({ enqueueVideoProcessingJob }) => enqueueVideoProcessingJob('movie', movieId, sourceVideoUrl))
    .catch((error) => logger.error({ error, movieId }, 'Failed to persist movie HLS job'));
};

export const processEpisodeHls = async (episodeId: Types.ObjectId | string, sourceVideoUrl: string, jobId = episodeId.toString()) => {
  try {
    const { EpisodeModel } = await import('../models/Episode');
    await EpisodeModel.findByIdAndUpdate(episodeId, {
      processingStatus: 'processing',
      processingProgress: 2,
      processingStep: 'Initializing...',
      processingEtaSeconds: null,
      processingStartedAt: new Date(),
      processingError: null,
    });

    let lastProgressUpdate = 0;
    const progressHandler = async (progress: number, step: string, etaSeconds?: number | null) => {
      const now = Date.now();
      if (progress < 100 && now - lastProgressUpdate < 800) return;
      lastProgressUpdate = now;
      try {
        await EpisodeModel.findByIdAndUpdate(episodeId, {
          $set: {
            processingProgress: Math.min(100, Math.max(0, progress)),
            processingStep: step,
            processingEtaSeconds: etaSeconds ?? null,
          },
        });
      } catch {}
    };

    const result = await transcodeHlsMultiResolution({
      id: episodeId.toString(),
      sourceVideoUrl,
      sourceVideoKey: (await EpisodeModel.findById(episodeId).select('sourceVideoKey').lean() as any)?.sourceVideoKey,
      jobId,
      folderType: 'episodes', // Isolated from movies
      onProgress: progressHandler,
    });

    // Build the update object — always set hlsUrl + status
    const episodeUpdate: any = {
      hlsUrl:           result.hlsUrl,
      sourceVideoUrl:   result.sourceVideoUrl,
      sourceVideoKey:   result.sourceVideoKey,
      videoUrl:         result.sourceVideoUrl,
      videoQualities:   result.videoQualities,
      processingStatus: 'ready',
      processingProgress: 100,
      processingStep:   'Ready',
      processingEtaSeconds: 0,
      processingError:  null,
    };

    // Replace missing or legacy-default durations with the probed source duration.
    if (result.detectedDurationSeconds && result.detectedDurationSeconds > 0) {
      const existing = await EpisodeModel.findById(episodeId).select('duration').lean();
      if (!existing?.duration || existing.duration === 0 || existing.duration === 2700) {
        episodeUpdate.duration = result.detectedDurationSeconds;
        logger.info(
          { episodeId, detectedDurationSeconds: result.detectedDurationSeconds },
          'Auto-saved episode duration from ffprobe'
        );
      }
    }

    const queue = await import('./videoProcessingQueue');
    await queue.assertVideoJobLease(jobId);
    await EpisodeModel.findByIdAndUpdate(episodeId, episodeUpdate);

    logger.info({ episodeId, hlsUrl: result.hlsUrl }, 'Episode HLS processing complete');
  } catch (error: any) {
    logger.error({ episodeId, error }, 'Episode HLS processing failed');
    const queue = await import('./videoProcessingQueue');
    if (await queue.ownsVideoJobLease(jobId).catch(() => false)) {
      const { EpisodeModel } = await import('../models/Episode');
      await EpisodeModel.findByIdAndUpdate(episodeId, {
        processingStatus: 'failed',
        processingProgress: 0,
        processingStep: 'Failed',
        processingEtaSeconds: null,
        processingError: error.message || 'Unknown processing error',
      });
    }
    throw error;
  }
};


export const processEpisodeInBackground = (
  episodeId: Types.ObjectId | string,
  sourceVideoUrl: string
) => {
  void import('./videoProcessingQueue')
    .then(({ enqueueVideoProcessingJob }) => enqueueVideoProcessingJob('episode', episodeId, sourceVideoUrl))
    .catch((error) => logger.error({ error, episodeId }, 'Failed to persist episode HLS job'));
};

export const processTVShowHls = async (tvShowId: Types.ObjectId | string, sourceVideoUrl: string, jobId = tvShowId.toString()) => {
  try {
    const { TVShowModel } = await import('../models/TVShow');
    await TVShowModel.findByIdAndUpdate(tvShowId, { processingStatus: 'processing' });

    const result = await transcodeHlsMultiResolution({
      id: tvShowId.toString(),
      sourceVideoUrl,
      sourceVideoKey: (await TVShowModel.findById(tvShowId).select('sourceVideoKey').lean() as any)?.sourceVideoKey,
      jobId,
      folderType: 'tvshows',
    });

    const queue = await import('./videoProcessingQueue');
    await queue.assertVideoJobLease(jobId);
    await TVShowModel.findByIdAndUpdate(tvShowId, {
      hlsUrl: result.hlsUrl,
      videoUrl: result.sourceVideoUrl,
      sourceVideoUrl: result.sourceVideoUrl,
      sourceVideoKey: result.sourceVideoKey,
      videoQualities: result.videoQualities,
      processingStatus: 'ready',
      processingError: null,
    });

    logger.info({ tvShowId, hlsUrl: result.hlsUrl }, 'TV show HLS processing complete');
  } catch (error: any) {
    logger.error({ error, tvShowId }, 'Error processing TV show HLS');
    const queue = await import('./videoProcessingQueue');
    if (await queue.ownsVideoJobLease(jobId).catch(() => false)) {
      const { TVShowModel } = await import('../models/TVShow');
      await TVShowModel.findByIdAndUpdate(tvShowId, { processingStatus: 'failed', processingError: error.message });
    }
    throw error;
  }
};

export const processTVShowInBackground = (tvShowId: Types.ObjectId | string, sourceVideoUrl: string) => {
  void import('./videoProcessingQueue')
    .then(({ enqueueVideoProcessingJob }) => enqueueVideoProcessingJob('tvShow', tvShowId, sourceVideoUrl))
    .catch((error) => logger.error({ error, tvShowId }, 'Failed to persist TV-show HLS job'));
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
  const doc = await (Model as any).findById(id).lean();
  return doc;
};
