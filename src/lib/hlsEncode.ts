/**
 * Shared HLS encode settings.
 * A short ladder plus `veryfast` and copied AAC keeps transcodes reliable on a small disk.
 */

export type HlsRendition = {
  name: '360p' | '720p' | '1080p';
  width: number;
  height: number;
  bitrate: string;
  maxrate: string;
  bufsize: string;
  bandwidth: number;
};

export const HLS_RENDITION_LADDER: readonly HlsRendition[] = [
  { name: '360p', width: 640, height: 360, bitrate: '800k', maxrate: '900k', bufsize: '1200k', bandwidth: 800_000 },
  { name: '720p', width: 1280, height: 720, bitrate: '2500k', maxrate: '2800k', bufsize: '3750k', bandwidth: 2_500_000 },
  { name: '1080p', width: 1920, height: 1080, bitrate: '4500k', maxrate: '5000k', bufsize: '6750k', bandwidth: 4_500_000 },
];

export function selectHlsLadder(sourceHeight?: number | null): HlsRendition[] {
  const height = sourceHeight && sourceHeight > 0 ? sourceHeight : 720;
  const capped = HLS_RENDITION_LADDER.filter((rendition) => rendition.height <= Math.max(height, 360));
  return capped.length ? capped : [HLS_RENDITION_LADDER[0]];
}

/** AAC already in the file is copied. Anything else is encoded once as AAC. */
export function ffmpegAudioArgs(audioCodec?: string | null): string[] {
  if (audioCodec && /^(aac|mp4a)$/i.test(audioCodec.trim())) return ['-c:a', 'copy'];
  return ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
}

export function isRemoteHls(url?: string | null): boolean {
  if (!url) return false;
  const value = url.trim();
  if (!/\.m3u8(?:[?#]|$)/i.test(value)) return false;
  return /^https?:\/\//i.test(value);
}

export function isExternalEmbed(url: string): boolean {
  return /(?:youtu\.?be|youtube(?:-nocookie)?\.com|vimeo\.com|dailymotion\.com)/i.test(url);
}

/** Progressive file ffmpeg can transcode. Playlists and embeds are not sources. */
export function isTranscodableVideo(url?: string | null): boolean {
  if (!url) return false;
  const value = url.trim();
  if (!value || value.startsWith('blob:') || value.startsWith('data:')) return false;
  if (isExternalEmbed(value) || /\.m3u8(?:[?#]|$)/i.test(value)) return false;
  return /\.(mp4|m4v|mov|webm|mkv|avi)(?:[?#]|$)/i.test(value)
    || /digitaloceanspaces\.com|amazonaws\.com|\/media\/|\/videos\//i.test(value);
}

export function hlsUploadConcurrency(fileCount: number): number {
  const configured = Number(process.env.HLS_UPLOAD_CONCURRENCY || 6);
  const workers = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 6;
  return Math.max(1, Math.min(workers, Math.max(1, fileCount)));
}

export type WorkspaceMarker = {
  pid?: number;
  hostname?: string;
  heartbeatAt?: number;
  startedAt?: number;
};

/**
 * Dead owners are removed immediately. A live owner is kept until the long TTL.
 * Another host with a stale heartbeat is treated as crashed.
 */
export function workspaceIsStale(
  marker: WorkspaceMarker | null,
  now: number,
  options: { ttlMs: number; staleHeartbeatMs: number; pidAlive: boolean; hostname: string }
): boolean {
  if (!marker) return false;
  const beat = Number(marker.heartbeatAt || marker.startedAt || 0);
  const age = beat > 0 ? now - beat : options.ttlMs;
  const sameHost = !marker.hostname || marker.hostname === options.hostname;
  if (sameHost && !options.pidAlive) return true;
  if (!sameHost && age >= options.staleHeartbeatMs) return true;
  return age >= options.ttlMs;
}
