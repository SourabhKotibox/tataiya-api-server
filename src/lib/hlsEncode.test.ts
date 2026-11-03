import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ffmpegAudioArgs,
  hlsUploadConcurrency,
  isRemoteHls,
  isTranscodableVideo,
  selectHlsLadder,
  workspaceIsStale,
} from './hlsEncode';

test('ladder stays within the source and skips 4K', () => {
  assert.deepEqual(selectHlsLadder(480).map((item) => item.name), ['360p']);
  assert.deepEqual(selectHlsLadder(720).map((item) => item.name), ['360p', '720p']);
  assert.deepEqual(selectHlsLadder(2160).map((item) => item.name), ['360p', '720p', '1080p']);
});

test('AAC is copied and other audio is encoded', () => {
  assert.deepEqual(ffmpegAudioArgs('aac'), ['-c:a', 'copy']);
  assert.deepEqual(ffmpegAudioArgs('mp4a'), ['-c:a', 'copy']);
  assert.deepEqual(ffmpegAudioArgs('ac3'), ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']);
});

test('only a remote playlist counts as finished HLS', () => {
  assert.equal(isRemoteHls('https://cdn.example/hls/movies/1/master.m3u8'), true);
  assert.equal(isRemoteHls('/uploads/hls/movies/1/master.m3u8'), false);
  assert.equal(isTranscodableVideo('https://space.example/media/ep1.mp4'), true);
  assert.equal(isTranscodableVideo('https://youtu.be/abcdefghijk'), false);
  assert.equal(isTranscodableVideo('https://cdn.example/master.m3u8'), false);
});

test('dead ffmpeg workspaces are stale immediately', () => {
  const now = 1_000_000;
  assert.equal(workspaceIsStale(
    { pid: 10, hostname: 'box', heartbeatAt: now - 1000 },
    now,
    { ttlMs: 86_400_000, staleHeartbeatMs: 900_000, pidAlive: false, hostname: 'box' }
  ), true);
  assert.equal(workspaceIsStale(
    { pid: 10, hostname: 'box', heartbeatAt: now - 1000 },
    now,
    { ttlMs: 86_400_000, staleHeartbeatMs: 900_000, pidAlive: true, hostname: 'box' }
  ), false);
});

test('segment uploads run in parallel up to the configured cap', () => {
  const previous = process.env.HLS_UPLOAD_CONCURRENCY;
  process.env.HLS_UPLOAD_CONCURRENCY = '8';
  assert.equal(hlsUploadConcurrency(100), 8);
  assert.equal(hlsUploadConcurrency(2), 2);
  if (previous === undefined) delete process.env.HLS_UPLOAD_CONCURRENCY;
  else process.env.HLS_UPLOAD_CONCURRENCY = previous;
});
