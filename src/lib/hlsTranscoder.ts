import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MediaFileModel, IHlsQuality } from '../models/MediaFile';
import { logger } from './logger';
import {
  ensureVideoSourceInSpaces,
  requireSpacesSettings,
  downloadFromS3ToFile,
  uploadHlsFolderToS3,
  getHlsPublicBaseUrl,
  deleteS3Prefix,
  validateHlsPackage,
} from './s3';
import { probeVideo, extractPosterFrame, sanitizeFfmpegError } from './videoProbe';
import { assertVideoDiskCapacity, createVideoWorkspace, estimateHlsOutputBytes } from './videoJobRuntime';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const QUALITY_PRESETS = [
  { quality: '360p', height: 360, bitrate: 800 },
  { quality: '480p', height: 480, bitrate: 1200 },
  { quality: '720p', height: 720, bitrate: 2500 },
  { quality: '1080p', height: 1080, bitrate: 4500 },
];

/** Keep local EC2 transcodes fast — fewer ladders for big files */
function pickLocalPresets(sourceHeight: number, fileSize = 0) {
  // Very large files: single ladder only (EC2 cannot finish multi-quality in time)
  if (fileSize >= 400 * 1024 * 1024) {
    const h = Math.min(720, Math.max(360, sourceHeight || 720));
    const match = QUALITY_PRESETS.find((p) => p.height === 720) || QUALITY_PRESETS[QUALITY_PRESETS.length - 1];
    return [{ ...match, height: Math.min(match.height, h) }];
  }
  const applicable = QUALITY_PRESETS.filter((p) => p.height <= Math.max(sourceHeight || 720, 360));
  if (applicable.length <= 3) return applicable.length ? applicable : [QUALITY_PRESETS[0]];
  return [
    applicable.find((p) => p.quality === '480p') || applicable[Math.floor(applicable.length / 2)],
    applicable.find((p) => p.quality === '720p') || applicable[applicable.length - 2],
    applicable[applicable.length - 1],
  ].filter(Boolean) as typeof QUALITY_PRESETS;
}

export const getVideoInfo = (filePath: string): Promise<{ duration: number; width: number; height: number }> => {
  return probeVideo(filePath).then((r) => ({
    duration: r.duration,
    width: r.width,
    height: r.height,
  }));
};

/**
 * Probe duration / resolution / codec and extract a poster frame ASAP
 * (before full HLS finishes) so the movie form can auto-fill.
 */
export async function enrichVideoMetadata(mediaFileId: string): Promise<void> {
  const mediaFile = await MediaFileModel.findById(mediaFileId);
  if (!mediaFile) return;

  const workspace = await createVideoWorkspace(`metadata-${mediaFileId}`);
  try {
    const source = await ensureVideoSourceInSpaces(mediaFile.s3Key || mediaFile.filePath || mediaFile.url, 'mediaFile', mediaFileId, mediaFile.s3Key);
    const localSource = path.join(workspace.path, `source${path.extname(source.key) || '.mp4'}`);
    await assertVideoDiskCapacity(source.size * 2, workspace.path);
    await downloadFromS3ToFile(source.key, localSource);
    const info = await probeVideo(localSource);
    mediaFile.duration = info.duration;
    (mediaFile as any).width = info.width;
    (mediaFile as any).height = info.height;
    (mediaFile as any).codec = info.codec;
    (mediaFile as any).bitrate = info.bitrate;
    (mediaFile as any).fps = info.fps;
    mediaFile.s3Key = source.key;
    mediaFile.filePath = source.key;
    mediaFile.url = source.url;
    mediaFile.storageType = 'spaces';

    if (!(mediaFile as any).posterFrameUrl) {
      const poster = await extractPosterFrame(localSource, mediaFileId, info.duration);
      if (poster) (mediaFile as any).posterFrameUrl = poster;
    }

    await mediaFile.save();
    logger.info(
      { mediaFileId, duration: info.duration, width: info.width, height: info.height },
      'Video metadata enriched for auto-fill'
    );
  } catch (err) {
    logger.warn({ err: sanitizeFfmpegError(err), mediaFileId }, 'Video metadata enrich failed');
  } finally {
    await workspace.cleanup();
  }
}

export async function runTranscodeToHls(
  mediaFileId: string,
  inputFilePath = '',
  _storageType: 'local' | 's3' | 'spaces' = 'spaces',
  jobId = mediaFileId
): Promise<void> {
  const mediaFile = await MediaFileModel.findById(mediaFileId);
  if (!mediaFile) throw new Error('Media file not found');
  await requireSpacesSettings();
  const workspace = await createVideoWorkspace(`media-${mediaFileId}-${jobId}`);
  let s3Prefix: string | undefined;

  try {
    mediaFile.transcoder = 'local';
    mediaFile.hlsStatus = 'processing';
    await mediaFile.save();
    const sourceRef = inputFilePath || mediaFile.s3Key || mediaFile.filePath || mediaFile.url;
    const source = await ensureVideoSourceInSpaces(sourceRef, 'mediaFile', mediaFileId, mediaFile.s3Key);
    const tempSourcePath = path.join(workspace.path, `source${path.extname(source.key) || '.mp4'}`);
    const outputDir = path.join(workspace.path, 'hls');
    await assertVideoDiskCapacity(source.size * 2, workspace.path);
    await downloadFromS3ToFile(source.key, tempSourcePath);
    await fs.promises.mkdir(outputDir, { recursive: true });

    const info = await probeVideo(tempSourcePath);
    mediaFile.duration = info.duration;
    mediaFile.width = info.width;
    mediaFile.height = info.height;
    mediaFile.codec = info.codec;
    mediaFile.bitrate = info.bitrate;
    mediaFile.fps = info.fps;
    if (!mediaFile.posterFrameUrl) {
      const poster = await extractPosterFrame(tempSourcePath, mediaFile._id.toString(), info.duration);
      if (poster) mediaFile.posterFrameUrl = poster;
    }
    await mediaFile.save();

    const applicablePresets = QUALITY_PRESETS.filter((preset) => preset.height <= Math.max(info.height || 360, 360));
    const estimatedHlsBytes = estimateHlsOutputBytes(info.duration, applicablePresets.map((preset) => ({ bitrate: `${preset.bitrate}k`, audioBitrate: '96k' })));
    await assertVideoDiskCapacity(estimatedHlsBytes, workspace.path);
    const qualities: IHlsQuality[] = [];
    const runPreset = async (preset: (typeof QUALITY_PRESETS)[number]) => {
      const qualityDir = path.join(outputDir, preset.quality);
      await fs.promises.mkdir(qualityDir, { recursive: true });
      const playlistPath = path.join(qualityDir, 'index.m3u8');
      const segmentPattern = path.join(qualityDir, 'segment-%03d.ts');

      await new Promise((resolve, reject) => {
        const args = [
          '-y',
          '-i', tempSourcePath,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-threads', '0',
          '-g', '48',
          '-sc_threshold', '0',
          '-keyint_min', '48',
          '-hls_time', '6',
          '-hls_list_size', '0',
          '-hls_segment_filename', segmentPattern,
          '-vf', `scale=-2:${preset.height}`,
          '-b:v', `${preset.bitrate}k`,
          '-maxrate', `${preset.bitrate * 1.5}k`,
          '-bufsize', `${preset.bitrate * 2}k`,
          '-c:a', 'aac',
          '-b:a', '96k',
          '-ac', '2',
          playlistPath,
        ];
        const child = spawn(ffmpegInstaller.path || 'ffmpeg', args);
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve(null);
          else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
        });
      });

      if (!fs.existsSync(playlistPath)) throw new Error(`HLS playlist was not generated for ${preset.quality}`);

      return {
        quality: preset.quality,
        url: '',
        filePath: '',
        bitrate: preset.bitrate,
        resolution: `${Math.round(info.width * (preset.height / (info.height || preset.height)))}x${preset.height}`,
      } as IHlsQuality;
    };

    for (const preset of applicablePresets) qualities.push(await runPreset(preset));

    let masterPlaylistContent = '#EXTM3U\n';
    for (const q of qualities) {
      const preset = applicablePresets.find((p) => p.quality === q.quality);
      if (preset) {
        masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${preset.bitrate * 1000},RESOLUTION=${q.resolution}\n`;
        masterPlaylistContent += `${q.quality}/index.m3u8\n`;
      }
    }

    await fs.promises.writeFile(path.join(outputDir, 'index.m3u8'), masterPlaylistContent, 'utf8');
    const relativeFiles: string[] = [];
    const collectFiles = async (directory: string, base = ''): Promise<void> => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const rel = path.posix.join(base, entry.name);
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await collectFiles(full, rel);
        else if (entry.isFile()) relativeFiles.push(rel);
      }
    };
    await collectFiles(outputDir);
    validateHlsPackage(outputDir, relativeFiles);

    s3Prefix = `hls/media/${mediaFileId}/${jobId}-${Date.now()}`;
    const queue = await import('../services/videoProcessingQueue');
    await queue.markVideoJobUploading(jobId);
    await uploadHlsFolderToS3(outputDir, s3Prefix);
    const hlsBase = await getHlsPublicBaseUrl();
    const masterPlaylistPath = `${hlsBase}/${s3Prefix}/index.m3u8`;
    for (const quality of qualities) {
      quality.url = `${hlsBase}/${s3Prefix}/${quality.quality}/index.m3u8`;
      quality.filePath = quality.url;
    }

    await queue.assertVideoJobLease(jobId);
    mediaFile.isHls = true;
    mediaFile.s3Key = source.key;
    mediaFile.filePath = source.key;
    mediaFile.url = source.url;
    mediaFile.storageType = 'spaces';
    mediaFile.transcoder = 'local';
    mediaFile.hlsMasterPlaylistUrl = masterPlaylistPath;
    mediaFile.hlsMasterPlaylistPath = masterPlaylistPath;
    mediaFile.hlsQualities = qualities;
    mediaFile.hlsStatus = 'completed';
    mediaFile.hlsError = undefined;
    await mediaFile.save();

    if (source.legacyLocalPath) {
      await fs.promises.unlink(source.legacyLocalPath).catch((error) => logger.warn({ error, mediaFileId, path: source.legacyLocalPath }, 'Failed to remove migrated local original'));
    }
    logger.info({ mediaFileId, jobId, hlsPrefix: s3Prefix, qualities: qualities.map((quality) => quality.quality) }, 'Media HLS published and verified in Spaces');
  } catch (error) {
    if (s3Prefix) await deleteS3Prefix(s3Prefix).catch((cleanupError) => logger.error({ cleanupError, s3Prefix, jobId }, 'Could not remove partial HLS prefix'));
    const queue = await import('../services/videoProcessingQueue');
    if (await queue.ownsVideoJobLease(jobId).catch(() => false)) {
      mediaFile.hlsStatus = 'failed';
      mediaFile.hlsError = sanitizeFfmpegError(error);
      await mediaFile.save();
    }
    throw error;
  } finally {
    await workspace.cleanup();
  }
}

export const transcodeToHls = async (
  mediaFileId: string,
  inputFilePath: string,
  _baseUrl: string,
  _storageType: 'local' | 's3' | 'spaces' = 'spaces'
): Promise<void> => {
  const mediaFile = await MediaFileModel.findById(mediaFileId);
  if (!mediaFile) throw new Error('Media file not found');
  const queue = await import('../services/videoProcessingQueue');
  await queue.enqueueVideoProcessingJob('mediaFile', mediaFileId, inputFilePath || mediaFile.s3Key || mediaFile.url, mediaFile.s3Key);
};

export default {
  getVideoInfo,
  transcodeToHls,
  enrichVideoMetadata,
};
