import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MediaFileModel, IHlsQuality } from '../models/MediaFile';
import { logger } from './logger';
import {
  isS3Configured,
  downloadFromS3ToFile,
  uploadHlsFolderToS3,
  getHlsPublicBaseUrl,
} from './s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_ROOT = path.join(__dirname, '../../uploads');
const TEMP_DIR = path.join(UPLOADS_ROOT, 'temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// Define qualities: 144p to 4K (2160p), we'll adapt to max height of input
const QUALITY_PRESETS = [
  { quality: '144p', height: 144, bitrate: 200 },
  { quality: '240p', height: 240, bitrate: 400 },
  { quality: '360p', height: 360, bitrate: 800 },
  { quality: '480p', height: 480, bitrate: 1200 },
  { quality: '720p', height: 720, bitrate: 2500 },
  { quality: '1080p', height: 1080, bitrate: 5000 },
  { quality: '1440p', height: 1440, bitrate: 8000 },
  { quality: '2160p', height: 2160, bitrate: 16000 },
];

export const getVideoInfo = (filePath: string): Promise<{ duration: number; width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        logger.error(err, 'Error getting video info');
        reject(err);
        return;
      }
      const stream = metadata.streams.find(s => s.codec_type === 'video');
      if (!stream) {
        reject(new Error('No video stream found'));
        return;
      }
      resolve({
        duration: metadata.format.duration || 0,
        width: stream.width || 0,
        height: stream.height || 0,
      });
    });
  });
};

export const transcodeToHls = async (
  mediaFileId: string,
  inputFilePath: string,
  baseUrl: string,
  storageType: 'local' | 's3' = 'local'
): Promise<void> => {
  const mediaFile = await MediaFileModel.findById(mediaFileId);
  if (!mediaFile) {
    throw new Error('Media file not found');
  }

  let tempDownload: string | null = null;

  try {
    mediaFile.hlsStatus = 'processing';
    await mediaFile.save();

    let sourcePath = inputFilePath;
    const useS3 = storageType === 's3' || (await isS3Configured() && (mediaFile as any).storageType === 's3');

    if (useS3 && (mediaFile as any).s3Key) {
      tempDownload = path.join(TEMP_DIR, `${mediaFile._id}-${Date.now()}${path.extname((mediaFile as any).s3Key) || '.mp4'}`);
      await downloadFromS3ToFile((mediaFile as any).s3Key, tempDownload);
      sourcePath = tempDownload;
    }

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('Source video file not found for HLS transcoding');
    }

    const { duration, width, height } = await getVideoInfo(sourcePath);
    mediaFile.duration = Math.round(duration);

    const applicablePresets = QUALITY_PRESETS.filter(preset => preset.height <= height);
    if (applicablePresets.length === 0) {
      applicablePresets.push(QUALITY_PRESETS[0]);
    }

    const hlsOutputDir = path.join(UPLOADS_ROOT, 'hls', mediaFile._id.toString());
    if (!fs.existsSync(hlsOutputDir)) {
      fs.mkdirSync(hlsOutputDir, { recursive: true });
    }

    const qualities: IHlsQuality[] = [];

    const CONCURRENCY = 2;
    const runPreset = async (preset: typeof QUALITY_PRESETS[number]) => {
      const outputDir = path.join(hlsOutputDir, preset.quality);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const playlistPath = path.join(outputDir, 'index.m3u8');
      const segmentPattern = path.join(outputDir, 'segment-%03d.ts');

      await new Promise((resolve, reject) => {
        ffmpeg(sourcePath)
          .outputOptions([
            '-preset', 'veryfast',
            '-g', '48',
            '-sc_threshold', '0',
            '-keyint_min', '48',
            '-hls_time', '4',
            '-hls_list_size', '0',
            '-hls_segment_filename', segmentPattern,
            '-vf', `scale=-2:${preset.height}`,
            '-b:v', `${preset.bitrate}k`,
            '-maxrate', `${preset.bitrate * 1.5}k`,
            '-bufsize', `${preset.bitrate * 2}k`,
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ac', '2',
          ])
          .output(playlistPath)
          .on('end', () => resolve(null))
          .on('error', (err) => reject(err))
          .run();
      });

      return {
        quality: preset.quality,
        url: `/uploads/hls/${mediaFile._id.toString()}/${preset.quality}/index.m3u8`,
        filePath: `/uploads/hls/${mediaFile._id.toString()}/${preset.quality}/index.m3u8`,
        bitrate: preset.bitrate,
        resolution: `${Math.round((height ? width * (preset.height / height) : preset.height * 16 / 9))}x${preset.height}`,
      } as IHlsQuality;
    };

    for (let i = 0; i < applicablePresets.length; i += CONCURRENCY) {
      const batch = applicablePresets.slice(i, i + CONCURRENCY);
      qualities.push(...(await Promise.all(batch.map(runPreset))));
    }

    let masterPlaylistContent = '#EXTM3U\n';
    for (const q of qualities) {
      const preset = applicablePresets.find(p => p.quality === q.quality);
      if (preset) {
        masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${preset.bitrate * 1000},RESOLUTION=${q.resolution}\n`;
        masterPlaylistContent += `${q.quality}/index.m3u8\n`;
      }
    }

    const masterPlaylistFsPath = path.join(hlsOutputDir, 'index.m3u8');
    fs.writeFileSync(masterPlaylistFsPath, masterPlaylistContent);

    let masterPlaylistPath = `/uploads/hls/${mediaFile._id.toString()}/index.m3u8`;

    if (useS3 && (await isS3Configured())) {
      const s3Prefix = `hls/${mediaFile._id.toString()}`;
      await uploadHlsFolderToS3(hlsOutputDir, s3Prefix);
      const hlsBase = await getHlsPublicBaseUrl();
      masterPlaylistPath = `${hlsBase}/${s3Prefix}/index.m3u8`;
      for (const q of qualities) {
        q.url = `${hlsBase}/${s3Prefix}/${q.quality}/index.m3u8`;
        q.filePath = q.url;
      }
      // Clean local HLS after upload
      try { fs.rmSync(hlsOutputDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    mediaFile.isHls = true;
    mediaFile.hlsMasterPlaylistUrl = masterPlaylistPath;
    mediaFile.hlsMasterPlaylistPath = masterPlaylistPath;
    mediaFile.hlsQualities = qualities;
    mediaFile.hlsStatus = 'completed';
    await mediaFile.save();
  } catch (error) {
    logger.error({ error }, 'Error transcoding to HLS');
    mediaFile.hlsStatus = 'failed';
    mediaFile.hlsError = error instanceof Error ? error.message : String(error);
    await mediaFile.save();
    throw error;
  } finally {
    if (tempDownload && fs.existsSync(tempDownload)) {
      try { fs.unlinkSync(tempDownload); } catch { /* ignore */ }
    }
  }
};

export default {
  getVideoInfo,
  transcodeToHls,
};
