/**
 * Probe video metadata + extract a cover frame for movie auto-fill.
 *
 * Important: never ffprobe remote HTTPS URLs with the static @ffprobe-installer
 * binary — it often SIGSEGVs. Always probe a local file (download a range from S3).
 */
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';
import {
  uploadToS3,
  getS3PublicUrl,
  requireSpacesSettings,
} from './s3';
import { createVideoWorkspace } from './videoJobRuntime';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export type VideoProbeResult = {
  duration: number;
  width: number;
  height: number;
  codec?: string;
  bitrate?: number;
  fps?: number;
  audioCodec?: string;
  format?: string;
};

export function sanitizeFfmpegError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Unknown error');
  if (/SIGSEGV|signal 11|segmentation/i.test(raw)) {
    return 'Video probe crashed (ffprobe). File may still play as MP4 — retry HLS or enable AWS MediaConvert.';
  }
  // Drop the huge ffprobe version banner from UI toasts
  const firstLine = raw.split('\n').find((l) => l.trim() && !/^ffprobe version/i.test(l.trim())) || raw;
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, 220);
}

export async function probeVideo(input: string): Promise<VideoProbeResult> {
  if (/^https?:\/\//i.test(input)) {
    throw new Error('Remote URL probe disabled — use a local file path (download from S3 first)');
  }
  if (!fs.existsSync(input)) {
    throw new Error(`Probe input not found: ${input}`);
  }

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(input, (err, metadata) => {
      if (err) return reject(err);
      const video = metadata.streams.find((s) => s.codec_type === 'video');
      const audio = metadata.streams.find((s) => s.codec_type === 'audio');
      if (!video) return reject(new Error('No video stream found'));

      let fps = 0;
      const rate = video.avg_frame_rate || video.r_frame_rate;
      if (rate && rate.includes('/')) {
        const [a, b] = rate.split('/').map(Number);
        if (b) fps = Math.round((a / b) * 100) / 100;
      }

      resolve({
        duration: Math.round(metadata.format?.duration || 0),
        width: video.width || 0,
        height: video.height || 0,
        codec: video.codec_name,
        bitrate: metadata.format?.bit_rate
          ? Math.round(Number(metadata.format.bit_rate) / 1000)
          : undefined,
        fps: fps || undefined,
        audioCodec: audio?.codec_name,
        format: metadata.format?.format_name,
      });
    });
  });
}

/**
 * Grab one frame near 10% / 5s mark for poster/thumbnail auto-fill.
 * Returns a verified Spaces URL. The local frame is job-scoped and always removed.
 */
export async function extractPosterFrame(
  input: string,
  mediaFileId: string,
  durationSeconds = 0
): Promise<string | null> {
  if (/^https?:\/\//i.test(input) || !fs.existsSync(input)) {
    return null;
  }

  const seek =
    durationSeconds > 20
      ? Math.min(30, Math.floor(durationSeconds * 0.1))
      : Math.min(5, Math.max(1, Math.floor(durationSeconds / 3) || 1));
  const workspace = await createVideoWorkspace(`poster-${mediaFileId}`);
  const outFile = path.join(workspace.path, 'poster.jpg');

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(input)
        .seekInput(seek)
        .frames(1)
        .outputOptions(['-q:v', '3'])
        .output(outFile)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });

    if (!fs.existsSync(outFile)) return null;

    await requireSpacesSettings();
    const key = `media/posters/${mediaFileId}-${Date.now()}.jpg`;
    return await uploadToS3(key, fs.createReadStream(outFile), 'image/jpeg');
  } catch (err) {
    logger.warn({ err, mediaFileId }, 'Poster frame extraction failed');
    return null;
  } finally {
    await workspace.cleanup();
  }
}

export { getS3PublicUrl };
