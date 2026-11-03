import type { FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger';
import { getSignedObjectUrl, getS3PublicUrl } from './s3';
import { findDiskHlsMaster, toAbsoluteUrl } from './urlHelper';
import { calculateEpisodeStartSeconds } from './videoPreview';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');

export type PlaybackFields = {
  trailerUrl: string | null;
  trailer: string | null;
  trailer_url: string | null;
  videoUrl: string | null;
  video_url: string | null;
  streamUrl: string | null;
  hlsUrl: string | null;
  playUrl: string | null;
  previewUrl: string | null;
  bannerVideo: string | null;
  video: string | null;
  startSeconds: number;
  startAt: number;
  startTime: number;
  seekTo: number;
  sourceStartSeconds: number;
  previewStartTime: number;
  previewStartSeconds: number;
  isEpisodePreview: boolean;
  isTrailer: boolean;
  videoQualities: Array<{ quality: string; url: string; size?: number }>;
};

export type MediaResolveDeps = {
  sign?: (key: string) => Promise<string>;
  publicUrl?: (key: string) => Promise<string>;
  localFileUrl?: (key: string) => string | null;
  absoluteLocal?: (request: FastifyRequest | null | undefined, value: string) => string | null;
};

const defaultDeps: MediaResolveDeps = {
  sign: (key) => getSignedObjectUrl(key),
  publicUrl: (key) => getS3PublicUrl(key),
  localFileUrl: (key) => {
    const rel = key.replace(/^\/+/, '');
    const abs = path.join(UPLOADS_ROOT, rel);
    if (!rel || rel.includes('..') || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return toAbsoluteUrl(null, `/uploads/${rel}`);
  },
  absoluteLocal: (request, value) => toAbsoluteUrl(request, value),
};

const nonempty = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) return null;
  return trimmed;
};

/** Pull a Spaces/S3 object key out of a stored path or absolute URL. */
export function extractStorageKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) return null;

  let pathPart = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      pathPart = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }

  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }

  const match = decoded.match(/(?:^|\/)((?:media|hls|videos)\/[^?#]+)/i);
  if (match?.[1]) return match[1].replace(/^\/+/, '');

  if (/^https?:\/\//i.test(trimmed)) return null;

  const rel = trimmed.replace(/^\/+/, '').replace(/^uploads\//i, '');
  if (!rel || rel.includes('..')) return null;
  if (/^(media|hls|videos)\//i.test(rel)) return rel;
  return null;
}

export function isExternalEmbed(url: string): boolean {
  return /(?:youtu\.?be|youtube(?:-nocookie)?\.com|vimeo\.com|dailymotion\.com)/i.test(url);
}

export function contentIsSeries(banner?: any, content?: any): boolean {
  const contentType = String(content?.contentType || content?.type || content?._type || '');
  if (/movie/i.test(contentType) && !/show|series/i.test(contentType)) return false;
  const values = [contentType, banner?.contentType];
  if (values.some((value) => /series|tv[\s_-]?show|\bshow\b/i.test(String(value || '')))) return true;
  return !!content?.totalSeasons;
}

/**
 * Turn a stored trailer/video value into an absolute URL ExoPlayer can open.
 * Website banners already do this (sign `media/` and `hls/` keys). App banner
 * and explore responses were prefixing those keys with `/uploads/`, which the
 * phone cannot play.
 */
export async function resolveStoredMediaUrl(
  request: FastifyRequest | null | undefined,
  raw: string | null | undefined,
  deps: MediaResolveDeps = defaultDeps
): Promise<string | null> {
  const trimmed = nonempty(raw);
  if (!trimmed) return null;

  const key = extractStorageKey(trimmed);
  const playlist = /\.m3u8(?:[?#]|$)/i.test(key || trimmed);

  if (key && deps.localFileUrl) {
    const local = deps.localFileUrl(key);
    if (local && /^https?:\/\//i.test(local)) return local;
  }

  if (key) {
    if (playlist && deps.publicUrl) {
      try {
        const pub = await deps.publicUrl(key);
        if (pub && /^https?:\/\//i.test(pub)) return pub;
      } catch (error) {
        logger.warn({ error, key }, 'Public HLS URL failed; trying a signed URL');
      }
    }
    if (deps.sign) {
      try {
        const signed = await deps.sign(key);
        if (signed && /^https?:\/\//i.test(signed)) return signed;
      } catch (error) {
        logger.warn({ error, key }, 'Signed media URL failed; trying the public URL');
      }
    }
    if (deps.publicUrl) {
      try {
        const pub = await deps.publicUrl(key);
        if (pub && /^https?:\/\//i.test(pub)) return pub;
      } catch (error) {
        logger.warn({ error, key }, 'Public media URL failed');
      }
    }
  }

  if (/^https?:\/\//i.test(trimmed)) {
    if (/^http:\/\/(?:www\.)?tataiya\.in/i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://');
    return trimmed;
  }

  const local = deps.absoluteLocal?.(request, trimmed) || null;
  return local && /^https?:\/\//i.test(local) ? local : null;
}

export function createRequestMediaResolver(request?: FastifyRequest | null) {
  const cache = new Map<string, Promise<string | null>>();
  return (raw: string | null | undefined) => {
    const key = nonempty(raw) || '';
    if (!key) return Promise.resolve(null);
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = resolveStoredMediaUrl(request, key);
    cache.set(key, pending);
    return pending;
  };
}

type PreviewInput = {
  bannerTrailer?: string | null;
  contentTrailer?: string | null;
  episodeTrailer?: string | null;
  episodeVideos?: Array<string | null | undefined>;
  contentVideos?: Array<string | null | undefined>;
  episodeDuration?: number | null;
  contentDuration?: number | null;
  episodeStartSeconds?: number | null;
  isSeries?: boolean;
};

async function firstResolved(
  values: Array<string | null | undefined>,
  resolve: (raw: string | null | undefined) => Promise<string | null>,
  accept: (url: string) => boolean
): Promise<string | null> {
  for (const value of values) {
    const resolved = await resolve(nonempty(value));
    if (resolved && accept(resolved)) return resolved;
  }
  return null;
}

export async function resolveContentPlayback(
  input: PreviewInput,
  resolve: (raw: string | null | undefined) => Promise<string | null>
): Promise<PlaybackFields> {
  const trailerCandidates = [input.bannerTrailer, input.contentTrailer, input.isSeries ? input.episodeTrailer : null];
  const fileTrailer = await firstResolved(trailerCandidates, resolve, (url) => !isExternalEmbed(url));
  const embedTrailer = fileTrailer
    ? null
    : await firstResolved(trailerCandidates, resolve, (url) => isExternalEmbed(url));

  const fileFallback = await firstResolved(
    [...(input.isSeries ? input.episodeVideos || [] : []), ...(input.contentVideos || [])],
    resolve,
    (url) => !isExternalEmbed(url)
  );

  const playable = fileTrailer || fileFallback || embedTrailer;
  const isTrailer = !!fileTrailer || (!fileFallback && !!embedTrailer);
  const usedEpisode = !fileTrailer && !!fileFallback && !!input.isSeries && (input.episodeVideos || []).some((value) => nonempty(value));
  const startSeconds = isTrailer
    ? 0
    : (input.episodeStartSeconds && input.episodeStartSeconds > 0
        ? input.episodeStartSeconds
        : calculateEpisodeStartSeconds(input.episodeDuration || input.contentDuration || undefined));

  const qualities = playable
    ? [{ quality: 'auto', url: playable }, { quality: '720p', url: playable }]
    : [];

  return {
    trailerUrl: playable,
    trailer: playable,
    trailer_url: playable,
    videoUrl: playable,
    video_url: playable,
    streamUrl: playable,
    hlsUrl: playable,
    playUrl: playable,
    previewUrl: playable,
    bannerVideo: playable,
    video: playable,
    startSeconds,
    startAt: startSeconds,
    startTime: startSeconds,
    seekTo: startSeconds,
    sourceStartSeconds: startSeconds,
    previewStartTime: startSeconds,
    previewStartSeconds: startSeconds,
    isEpisodePreview: !isTrailer && !!playable && (!!usedEpisode || !input.isSeries),
    isTrailer,
    videoQualities: qualities,
  };
}

const diskMaster = (id: unknown, folder: 'episodes' | 'tv-shows' | 'movies') => {
  if (!id) return null;
  return findDiskHlsMaster(String(id), folder);
};

export async function playbackForDocuments(
  request: FastifyRequest | null | undefined,
  docs: { banner?: any; content?: any; episode?: any }
): Promise<PlaybackFields> {
  const { banner, content, episode } = docs;
  const isSeries = contentIsSeries(banner, content);
  const contentId = content?._id || content?.id;
  const episodeId = episode?._id || episode?.id;
  const resolve = createRequestMediaResolver(request);

  return resolveContentPlayback(
    {
      bannerTrailer: banner?.trailerUrl,
      contentTrailer: content?.trailerUrl,
      episodeTrailer: episode?.trailerUrl,
      episodeVideos: [
        episode?.hlsUrl,
        episode?.videoUrl,
        episode?.sourceVideoUrl,
        diskMaster(episodeId, 'episodes'),
      ],
      contentVideos: [
        content?.hlsUrl,
        content?.videoUrl,
        content?.sourceVideoUrl,
        banner?.videoUrl,
        banner?.hlsUrl,
        diskMaster(contentId, isSeries ? 'tv-shows' : 'movies'),
        diskMaster(contentId, 'episodes'),
      ],
      episodeDuration: episode?.duration,
      contentDuration: content?.duration || episode?.duration,
      episodeStartSeconds: episode?.sourceStartSeconds,
      isSeries,
    },
    resolve
  );
}

export async function loadFirstEpisodes(showIds: any[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  const ids = (showIds || []).filter(Boolean);
  if (ids.length === 0) return map;

  const { EpisodeModel } = await import('../models/Episode');
  const episodes = await EpisodeModel.find({
    $or: [
      { tvShowId: { $in: ids } },
      { tvShowId: { $in: ids.map((id) => String(id)) } },
    ],
  })
    .sort({ season: 1, episode: 1 })
    .select('tvShowId trailerUrl hlsUrl sourceVideoUrl videoUrl duration sourceStartSeconds videoQualities')
    .lean();

  for (const episode of episodes) {
    const key = episode.tvShowId?.toString();
    if (key && !map.has(key)) map.set(key, episode);
  }
  return map;
}
