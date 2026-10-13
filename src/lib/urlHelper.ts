import type { FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');

/**
 * Converts any stored media path to a full, valid HTTPS URL.
 * Ensures:
 * 1. Always HTTPS for production (tataiya.in) and proxied requests
 * 2. Never returns a relative path like "/uploads/..." to mobile apps
 * 3. Handles S3/Cloud storage URLs as-is
 * 4. Ensures proper "/uploads/" prefix for local uploads
 */
export const toAbsoluteUrl = (
  request?: FastifyRequest | null,
  url?: string | null | undefined
): string | null => {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Already an absolute URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    // Upgrade http://tataiya.in to https://tataiya.in to prevent Android cleartext / iOS ATS blocks
    if (trimmed.startsWith('http://tataiya.in') || trimmed.startsWith('http://www.tataiya.in')) {
      return trimmed.replace(/^http:\/\//, 'https://');
    }
    return trimmed;
  }

  // Relative path - normalize uploads prefix
  let relPath = trimmed;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/')
      ? `/${relPath}`
      : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }

  // Determine protocol and host
  let proto = 'https';
  let host = 'tataiya.in';

  if (request) {
    const forwardedProto = (request.headers['x-forwarded-proto'] as string) || '';
    const reqHost = (request.headers['x-forwarded-host'] as string) || request.hostname;
    const isLocalhost = reqHost.includes('localhost') || reqHost.includes('127.0.0.1');

    if (isLocalhost) {
      proto = forwardedProto || request.protocol || 'http';
      host = reqHost;
    } else {
      proto = 'https'; // Always https on public domains
      host = reqHost || 'tataiya.in';
    }
  }

  return `${proto}://${host}${relPath}`;
};

/**
 * Checks if a transcoded HLS stream exists on disk for a given content id and folder type.
 */
export const findDiskHlsMaster = (
  id: string,
  folderType: 'episodes' | 'tv-shows' | 'movies'
): string | null => {
  if (!id) return null;
  const masterPath = path.join(UPLOADS_ROOT, 'hls', folderType, id.toString(), 'master.m3u8');
  if (fs.existsSync(masterPath)) {
    return `/uploads/hls/${folderType}/${id}/master.m3u8`;
  }
  return null;
};

/**
 * Probes the file system to find individual quality rendition playlists (144p .. 1080p).
 */
export const findDiskVideoQualities = (
  id: string,
  folderType: 'episodes' | 'tv-shows' | 'movies',
  request?: FastifyRequest | null
): Array<{ quality: string; url: string; size?: number }> => {
  if (!id) return [];
  const hlsFolder = path.join(UPLOADS_ROOT, 'hls', folderType, id.toString());
  if (!fs.existsSync(hlsFolder)) return [];

  const validQualities = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];
  const qualities: Array<{ quality: string; url: string; size?: number }> = [];

  try {
    const entries = fs.readdirSync(hlsFolder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && validQualities.includes(entry.name)) {
        const qualityPlaylistPath = path.join(hlsFolder, entry.name, 'playlist.m3u8');
        if (fs.existsSync(qualityPlaylistPath)) {
          const relUrl = `/uploads/hls/${folderType}/${id}/${entry.name}/playlist.m3u8`;
          qualities.push({
            quality: entry.name,
            url: toAbsoluteUrl(request, relUrl) || relUrl,
          });
        }
      }
    }
  } catch {}

  return qualities;
};

/**
 * Resolves the optimal transcoded video stream for any content item (movie, tvShow, episode).
 * Prioritizes transcoded HLS (.m3u8) for instant buffer-free playback,
 * maps videoQualities with absolute URLs, and falls back to progressive source video.
 */
export const resolveVideoStream = (
  item: any,
  request?: FastifyRequest | null,
  folderType?: 'episodes' | 'tv-shows' | 'movies'
) => {
  if (!item) {
    return {
      hlsUrl: null,
      streamUrl: null,
      videoUrl: null,
      videoQualities: [],
      isTranscoded: false,
    };
  }

  const itemId = item._id ? item._id.toString() : item.id ? item.id.toString() : '';

  // 1. Check existing hlsUrl on item
  let hlsPath: string | null = item.hlsUrl || null;

  // 2. If missing, check disk for HLS master playlist
  if (!hlsPath && itemId && folderType) {
    hlsPath = findDiskHlsMaster(itemId, folderType);
  } else if (!hlsPath && itemId) {
    // Probe common folder types
    hlsPath =
      findDiskHlsMaster(itemId, 'episodes') ||
      findDiskHlsMaster(itemId, 'tv-shows') ||
      findDiskHlsMaster(itemId, 'movies');
  }

  const hasHls = !!(hlsPath && typeof hlsPath === 'string' && hlsPath.includes('.m3u8'));
  const hlsAbs = hasHls ? toAbsoluteUrl(request, hlsPath) : null;

  // Map videoQualities to absolute URLs (or auto-discover from disk)
  const rawQualities: Array<{ quality: string; url: string; size?: number }> = item.videoQualities || [];
  let videoQualities: Array<{ quality: string; url: string; size?: number }> = [];

  if (rawQualities.length > 0) {
    videoQualities = rawQualities.map((q) => ({
      quality: q.quality,
      url: toAbsoluteUrl(request, q.url) || q.url,
      size: q.size,
    }));
  } else if (itemId) {
    const fType = folderType || 'episodes';
    const detected = findDiskVideoQualities(itemId, fType, request);
    if (detected.length > 0) {
      videoQualities = detected;
    } else {
      videoQualities =
        findDiskVideoQualities(itemId, 'episodes', request).length > 0
          ? findDiskVideoQualities(itemId, 'episodes', request)
          : findDiskVideoQualities(itemId, 'movies', request);
    }
  }

  // Progressive source video fallback
  const rawVideo = item.videoUrl || item.sourceVideoUrl || (!hasHls ? item.hlsUrl : null);
  const progressiveAbs = toAbsoluteUrl(request, rawVideo);

  // Stream URL: prefer transcoded HLS stream for fast buffer-free playback
  const streamUrl = hlsAbs || progressiveAbs;

  return {
    hlsUrl: hlsAbs,
    streamUrl,
    videoUrl: streamUrl,
    videoQualities,
    isTranscoded: hasHls,
  };
};
