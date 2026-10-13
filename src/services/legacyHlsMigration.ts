import fs from 'node:fs/promises';
import path from 'node:path';
import { EpisodeModel } from '../models/Episode';
import { MediaFileModel } from '../models/MediaFile';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { deleteS3Prefix, getHlsPublicBaseUrl, uploadHlsFolderToS3, validateHlsPackage } from '../lib/s3';
import { logger } from '../lib/logger';
import { markVideoJobUploading, assertVideoJobLease } from './videoProcessingQueue';

const models = {
  mediaFile: MediaFileModel,
  movie: MovieModel,
  tvShow: TVShowModel,
  episode: EpisodeModel,
} as const;

function uploadsRoots(): string[] {
  if (process.env.VIDEO_LEGACY_UPLOADS_ROOT) return [path.resolve(process.env.VIDEO_LEGACY_UPLOADS_ROOT)];
  return [path.resolve(process.cwd(), 'uploads'), path.resolve(process.cwd(), '..', 'uploads')];
}

async function findLegacyMaster(masterUrl: string): Promise<{ root: string; masterName: string }> {
  const pathname = masterUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
  const relative = pathname.replace(/^\/*uploads\//, '').replace(/^\/+/, '');
  if (!relative.startsWith('hls/')) throw new Error(`Legacy HLS path is outside uploads/hls: ${masterUrl}`);
  for (const root of uploadsRoots()) {
    const masterPath = path.resolve(root, relative);
    if (!masterPath.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
    if (await fs.stat(masterPath).then(() => true, () => false)) {
      return { root: path.dirname(masterPath), masterName: path.basename(masterPath) };
    }
  }
  throw new Error(`Legacy HLS master playlist not found on disk: ${masterUrl}`);
}

async function collectRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, relative = ''): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const key = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), key);
      else if (entry.isFile()) files.push(key);
    }
  };
  await walk(root);
  return files;
}

function readRenditions(masterText: string, baseUrl: string, prefix: string) {
  const lines = masterText.split(/\r?\n/).map((line) => line.trim());
  const renditions: Array<{ quality: string; url: string; filePath: string; bitrate: number; resolution: string; size: number }> = [];
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const relativePlaylist = lines[index + 1];
    if (!relativePlaylist || relativePlaylist.startsWith('#')) continue;
    const quality = path.posix.basename(path.posix.dirname(relativePlaylist));
    const attributes = lines[index].slice(lines[index].indexOf(':') + 1);
    const bitrate = Number(attributes.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1]) || 0;
    const resolution = attributes.match(/(?:^|,)RESOLUTION=([\dx]+)/)?.[1] || '';
    const url = `${baseUrl}/${prefix}/${relativePlaylist}`;
    renditions.push({ quality, url, filePath: url, bitrate, resolution, size: 0 });
  }
  return renditions;
}

export async function migrateLegacyHlsToSpaces(
  entityType: keyof typeof models,
  entityId: string,
  masterUrl: string,
  jobId: string
): Promise<void> {
  const model = models[entityType] as any;
  const entity = await model.findById(entityId).lean();
  if (!entity) throw new Error(`HLS migration target not found: ${entityType}/${entityId}`);

  const { root, masterName } = await findLegacyMaster(masterUrl);
  const relativeFiles = await collectRelativeFiles(root);
  validateHlsPackage(root, relativeFiles);
  const prefix = `hls/${entityType}/${entityId}/migrated-${jobId}`;

  try {
    await markVideoJobUploading(jobId);
    const uploaded = await uploadHlsFolderToS3(root, prefix);
    if (uploaded !== relativeFiles.length) throw new Error(`Partial legacy HLS migration: ${uploaded}/${relativeFiles.length} objects uploaded`);

    const baseUrl = await getHlsPublicBaseUrl();
    const migratedMasterUrl = `${baseUrl}/${prefix}/${masterName}`;
    const masterText = await fs.readFile(path.join(root, masterName), 'utf8');
    const renditions = readRenditions(masterText, baseUrl, prefix);
    await assertVideoJobLease(jobId);

    const updates = entityType === 'mediaFile'
      ? { hlsMasterPlaylistUrl: migratedMasterUrl, hlsMasterPlaylistPath: migratedMasterUrl, hlsQualities: renditions, isHls: true, hlsStatus: 'completed', hlsError: null }
      : { hlsUrl: migratedMasterUrl, videoQualities: renditions.map(({ quality, url, size }) => ({ quality, url, size })), processingStatus: 'ready', processingError: null };
    await model.findByIdAndUpdate(entityId, { $set: updates });
    await fs.rm(root, { recursive: true, force: true });
    logger.info({ entityType, entityId, jobId, prefix, files: uploaded }, 'Legacy local HLS migrated to Spaces and local copy removed');
  } catch (error) {
    await deleteS3Prefix(prefix).catch((cleanupError) => logger.error({ cleanupError, entityType, entityId, prefix }, 'Failed to remove partial legacy HLS migration'));
    throw error;
  }
}