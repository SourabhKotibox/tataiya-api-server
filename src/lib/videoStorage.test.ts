import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  assertSpacesConfigured,
  ensureVideoSourceInSpaces,
  uploadHlsFolderToS3,
  uploadVerifiedReadableToSpaces,
  validateHlsPackage,
} from './s3';
import { cleanupStaleVideoWorkspaces, createVideoWorkspace, estimateHlsOutputBytes } from './videoJobRuntime';

const spacesSettings = {
  storageDriver: 'spaces',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'test-space',
  region: 'sgp1',
  endpoint: 'https://sgp1.digitaloceanspaces.com',
  pathStyle: false,
  cdnUrl: 'https://test-space.sgp1.cdn.digitaloceanspaces.com',
} as any;

test('Spaces is required and local storage cannot satisfy video configuration', () => {
  assert.throws(() => assertSpacesConfigured({ ...spacesSettings, storageDriver: 'local' }), /requires STORAGE_DRIVER=spaces/);
  assert.throws(() => assertSpacesConfigured({ ...spacesSettings, accessKeyId: '' }), /missing a Space name or access credentials/);
  assert.equal(assertSpacesConfigured(spacesSettings), spacesSettings);
});

test('HLS disk estimate includes all video and audio renditions with headroom', () => {
  assert.equal(estimateHlsOutputBytes(60, [{ bitrate: '1000k', audioBitrate: '128k' }]), 10_998_000);
});

test('original upload streams to Spaces and verifies the complete object size', async () => {
  const chunks: Buffer[] = [];
  const uploaded = await uploadVerifiedReadableToSpaces(
    'media/originals/movie/1/source.mp4',
    Readable.from([Buffer.from('video-'), Buffer.from('source')]),
    'video/mp4',
    12,
    {
      upload: async (_key, body) => {
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        return 'https://cdn.example/media/originals/movie/1/source.mp4';
      },
      getSize: async () => 12,
      remove: async () => undefined,
    }
  );

  assert.equal(Buffer.concat(chunks).toString(), 'video-source');
  assert.equal(uploaded, 'https://cdn.example/media/originals/movie/1/source.mp4');
});

test('partial original upload is deleted and never returned as playable', async () => {
  let deletedKey = '';
  await assert.rejects(
    uploadVerifiedReadableToSpaces(
      'media/originals/episode/2/episode.mp4',
      Readable.from([Buffer.from('short')]),
      'video/mp4',
      100,
      {
        upload: async () => 'https://cdn.example/episode.mp4',
        getSize: async () => 5,
        remove: async (key) => { deletedKey = key; },
      }
    ),
    /verification failed/
  );
  assert.equal(deletedKey, 'media/originals/episode/2/episode.mp4');
});

test('legacy local originals stream into Spaces, then return the source path for post-verification cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tataiya-source-test-'));
  await fs.mkdir(path.join(root, 'videos'), { recursive: true });
  const filePath = path.join(root, 'videos', 'old-upload.mp4');
  await fs.writeFile(filePath, 'legacy-video');
  const bytes: Buffer[] = [];
  try {
    const result = await ensureVideoSourceInSpaces('/uploads/videos/old-upload.mp4', 'movie', 'movie-id', undefined, {
      settings: spacesSettings,
      localUploadsRoot: root,
      head: async () => { throw new Error('not found'); },
      upload: async (_key, body) => {
        for await (const chunk of body) bytes.push(Buffer.from(chunk));
        return 'https://cdn.example/original.mp4';
      },
      publicUrl: () => 'https://cdn.example/existing.mp4',
    });

    assert.equal(Buffer.concat(bytes).toString(), 'legacy-video');
    assert.equal(result.legacyLocalPath, filePath);
    assert.equal(result.size, 12);
    assert.match(result.key, /^media\/originals\/movie\/movie-id\//);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'legacy-video');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeValidHls(root: string): Promise<string[]> {
  await fs.mkdir(path.join(root, '360p'), { recursive: true });
  await fs.writeFile(path.join(root, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n360p/playlist.m3u8\n');
  await fs.writeFile(path.join(root, '360p', 'playlist.m3u8'), '#EXTM3U\n#EXTINF:4,\nsegment-000.ts\n#EXT-X-ENDLIST\n');
  await fs.writeFile(path.join(root, '360p', 'segment-000.ts'), Buffer.from([0, 0, 1, 2, 3]));
  return ['master.m3u8', '360p/playlist.m3u8', '360p/segment-000.ts'];
}

test('HLS package uploads every playlist and segment with complete-object verification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tataiya-hls-test-'));
  const keys = new Map<string, number>();
  try {
    const expectedFiles = await makeValidHls(root);
    validateHlsPackage(root, expectedFiles);
    const count = await uploadHlsFolderToS3(root, 'hls/movies/1/job-1', {
      settings: spacesSettings,
      uploadFile: async (filePath, key, contentType, cacheControl, size) => {
        assert.equal((await fs.stat(filePath)).size, size);
        assert.ok(contentType === 'application/vnd.apple.mpegurl' || contentType === 'video/mp2t');
        assert.ok(cacheControl.length > 0);
        keys.set(key, size);
      },
      verifyObject: async (key) => keys.get(key) || 0,
    });

    assert.equal(count, expectedFiles.length);
    assert.equal(keys.size, expectedFiles.length);
    assert.ok(keys.has('hls/movies/1/job-1/master.m3u8'));
    assert.ok(keys.has('hls/movies/1/job-1/360p/segment-000.ts'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('partial HLS uploads reject and cannot yield a playable package result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tataiya-hls-partial-test-'));
  let uploaded = 0;
  const remoteSizes = new Map<string, number>();
  try {
    await makeValidHls(root);
    await assert.rejects(uploadHlsFolderToS3(root, 'hls/episodes/2/job-2', {
      settings: spacesSettings,
      uploadFile: async (filePath, key, _contentType, _cacheControl, size) => {
        uploaded++;
        if (uploaded === 2) throw new Error('simulated Spaces failure');
        assert.equal((await fs.stat(filePath)).size, size);
        remoteSizes.set(key, size);
      },
      verifyObject: async (key) => remoteSizes.get(key) || 0,
    }), /simulated Spaces failure/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HLS validation rejects playlists that reference missing segments before upload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tataiya-hls-missing-test-'));
  try {
    await fs.mkdir(path.join(root, '360p'), { recursive: true });
    await fs.writeFile(path.join(root, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n360p/playlist.m3u8\n');
    await fs.writeFile(path.join(root, '360p', 'playlist.m3u8'), '#EXTM3U\n#EXTINF:4,\nmissing.ts\n#EXT-X-ENDLIST\n');
    assert.throws(() => validateHlsPackage(root, ['master.m3u8', '360p/playlist.m3u8']), /references missing file/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent video jobs receive isolated workspaces and cleanup is idempotent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tataiya-workspace-test-'));
  const previousRoot = process.env.VIDEO_TEMP_DIR;
  process.env.VIDEO_TEMP_DIR = root;
  try {
    const [first, second] = await Promise.all([
      createVideoWorkspace('same-job'),
      createVideoWorkspace('same-job'),
    ]);
    assert.notEqual(first.path, second.path);
    await fs.writeFile(path.join(first.path, 'source.mp4'), 'source');
    await fs.writeFile(path.join(second.path, 'segment.ts'), 'segment');
    await first.cleanup();
    await first.cleanup();
    assert.equal(await fs.stat(first.path).then(() => true, () => false), false);
    assert.equal(await fs.stat(second.path).then(() => true, () => false), true);
    await second.cleanup();
  } finally {
    if (previousRoot === undefined) delete process.env.VIDEO_TEMP_DIR;
    else process.env.VIDEO_TEMP_DIR = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stale workspaces from a prior process are recovered but current-process workspaces are kept', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tataiya-recovery-test-'));
  const previousRoot = process.env.VIDEO_TEMP_DIR;
  const previousTtl = process.env.VIDEO_TEMP_TTL_HOURS;
  process.env.VIDEO_TEMP_DIR = root;
  process.env.VIDEO_TEMP_TTL_HOURS = '1';
  try {
    const stale = path.join(root, 'old-job');
    await fs.mkdir(stale);
    await fs.writeFile(path.join(stale, '.tataiya-video-job.json'), JSON.stringify({ jobId: 'old', pid: 99999999, hostname: 'previous-host', startedAt: Date.now() - 3 * 60 * 60_000, heartbeatAt: Date.now() - 3 * 60 * 60_000 }));
    await fs.writeFile(path.join(stale, 'source.mp4'), 'stale-source');
    const active = await createVideoWorkspace('active-job');
    const cleanup = await cleanupStaleVideoWorkspaces(Date.now() + 2 * 60 * 60_000);
    assert.equal(cleanup.removed, 1);
    assert.ok(cleanup.bytes >= Buffer.byteLength('stale-source'));
    assert.equal(await fs.stat(active.path).then(() => true, () => false), true);
    await active.cleanup();
  } finally {
    if (previousRoot === undefined) delete process.env.VIDEO_TEMP_DIR;
    else process.env.VIDEO_TEMP_DIR = previousRoot;
    if (previousTtl === undefined) delete process.env.VIDEO_TEMP_TTL_HOURS;
    else process.env.VIDEO_TEMP_TTL_HOURS = previousTtl;
    await fs.rm(root, { recursive: true, force: true });
  }
});