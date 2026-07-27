/**
 * Probe video metadata + extract a cover frame for movie auto-fill.
 */
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger';
import { isS3Configured, uploadToS3, getS3PublicUrl } from './s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_DIR = path.join(__dirname, '../../uploads/temp');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

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

export async function probeVideo(input: string): Promise<VideoProbeResult> {
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
 * Returns public URL (S3 or local path).
 */
export async function extractPosterFrame(
  input: string,
  mediaFileId: string,
  durationSeconds = 0
): Promise<string | null> {
  const seek = durationSeconds > 20 ? Math.min(30, Math.floor(durationSeconds * 0.1)) : Math.min(5, Math.max(1, Math.floor(durationSeconds / 3) || 1));
  const outFile = path.join(TEMP_DIR, `poster-${mediaFileId}-${Date.now()}.jpg`);

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

    if (await isS3Configured()) {
      const key = `media/posters/${mediaFileId}-${Date.now()}.jpg`;
      const buf = fs.readFileSync(outFile);
      const url = await uploadToS3(key, buf, 'image/jpeg');
      try { fs.unlinkSync(outFile); } catch { /* ignore */ }
      return url;
    }

    const rel = `/uploads/temp/${path.basename(outFile)}`;
    return rel;
  } catch (err) {
    logger.warn({ err, mediaFileId }, 'Poster frame extraction failed');
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
    return null;
  }
}

/** Resolve a usable probe input (local path or public HTTP URL). */
export async function resolveProbeInput(opts: {
  localPath?: string;
  s3Key?: string;
  publicUrl?: string;
}): Promise<string> {
  if (opts.localPath && fs.existsSync(opts.localPath)) return opts.localPath;
  if (opts.publicUrl && /^https?:\/\//i.test(opts.publicUrl)) return opts.publicUrl;
  if (opts.s3Key) return getS3PublicUrl(opts.s3Key);
  throw new Error('No probeable video source');
}
