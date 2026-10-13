import { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
import { logger } from './logger';
import { SettingsModel } from '../models/Settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Normalizes a DigitalOcean Spaces endpoint to the regional S3 base endpoint.
 *
 * Examples:
 *   "https://tataiya.sgp1.digitaloceanspaces.com" -> "https://sgp1.digitaloceanspaces.com"
 *   "https://tataiya.sgp1.cdn.digitaloceanspaces.com" -> "https://sgp1.digitaloceanspaces.com"
 *   "sgp1.digitaloceanspaces.com" -> "https://sgp1.digitaloceanspaces.com"
 *   "sgp1" -> "https://sgp1.digitaloceanspaces.com"
 *   undefined / "" -> "https://<region>.digitaloceanspaces.com"
 */
export function normalizeSpacesEndpoint(
  rawEndpoint: string | undefined,
  region = 'nyc3',
  spaceName = ''
): string {
  let ep = (rawEndpoint || '').trim();
  const reg = (region || 'nyc3').trim().toLowerCase();

  if (!ep) {
    return `https://${reg}.digitaloceanspaces.com`;
  }

  // If user entered just a region name (e.g. "sgp1", "nyc3")
  if (/^[a-z0-9-]+$/i.test(ep) && !ep.includes('.')) {
    return `https://${ep.toLowerCase()}.digitaloceanspaces.com`;
  }

  if (!/^https?:\/\//i.test(ep)) {
    ep = `https://${ep}`;
  }

  try {
    const parsed = new URL(ep);
    let host = parsed.hostname.toLowerCase();

    // Strip CDN part
    host = host.replace(/\.cdn\./, '.');

    // Strip space/bucket name prefix if user typed "spaceName.region.digitaloceanspaces.com"
    if (spaceName) {
      const cleanSpace = spaceName.trim().toLowerCase();
      if (host.startsWith(`${cleanSpace}.`)) {
        host = host.slice(cleanSpace.length + 1);
      }
    }

    // If host has a region before digitaloceanspaces.com (e.g. "sgp1.digitaloceanspaces.com")
    const match = host.match(/([a-z0-9-]+)\.digitaloceanspaces\.com$/i);
    if (match && match[1]) {
      return `https://${match[1].toLowerCase()}.digitaloceanspaces.com`;
    }

    if (host === 'digitaloceanspaces.com') {
      return `https://${reg}.digitaloceanspaces.com`;
    }

    return `https://${host}`;
  } catch {
    return `https://${reg}.digitaloceanspaces.com`;
  }
}

export async function getS3Settings() {
  const settings = await SettingsModel.findOne().lean();
  const storageDriver =
    process.env.STORAGE_DRIVER ||
    (settings as any)?.storageDriver ||
    's3';

  if (storageDriver === 'spaces') {
    const accessKeyId =
      process.env.DO_SPACES_ACCESS_KEY ||
      (settings as any)?.doAccessKey ||
      process.env.DO_SPACES_KEY ||
      '';
    const secretAccessKey =
      process.env.DO_SPACES_SECRET_KEY ||
      (settings as any)?.doSecretKey ||
      process.env.DO_SPACES_SECRET ||
      '';
    const region = (
      process.env.DO_SPACES_REGION ||
      (settings as any)?.doRegion ||
      'nyc3'
    ).trim().toLowerCase();
    const bucket = (
      process.env.DO_SPACES_NAME ||
      (settings as any)?.doSpaceName ||
      process.env.DO_SPACES_BUCKET ||
      ''
    ).trim();
    const rawEndpoint =
      process.env.DO_SPACES_ENDPOINT ||
      (settings as any)?.doEndpoint ||
      `https://${region}.digitaloceanspaces.com`;
    const endpoint = normalizeSpacesEndpoint(rawEndpoint, region, bucket);
    const cdnUrl =
      (process.env.DO_SPACES_CDN_URL || (settings as any)?.doCdnUrl || '').replace(/\/$/, '');

    return {
      accessKeyId,
      secretAccessKey,
      region,
      bucket,
      endpoint,
      pathStyle: false,
      storageDriver: 'spaces' as const,
      cdnUrl,
    };
  }

  // Standard AWS S3 settings (preserved completely)
  const accessKeyId =
    (settings as any)?.awsAccessKeyId ||
    process.env.AWS_S3_ACCESS_KEY_ID ||
    process.env.AWS_ACCESS_KEY_ID ||
    '';
  const secretAccessKey =
    (settings as any)?.awsSecretAccessKey ||
    process.env.AWS_S3_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    '';
  const region =
    (settings as any)?.awsRegion ||
    process.env.AWS_S3_REGION ||
    process.env.AWS_REGION ||
    'us-east-1';
  const bucket =
    (settings as any)?.awsBucket ||
    process.env.AWS_S3_BUCKET_NAME ||
    process.env.AWS_BUCKET_NAME ||
    'tataiya-ott';
  const pathStyle = !!(settings as any)?.awsPathStyleEndpoint;
  const cdnUrl =
    ((settings as any)?.awsCdnUrl || process.env.AWS_S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');

  return {
    accessKeyId,
    secretAccessKey,
    region,
    bucket,
    endpoint: undefined as string | undefined,
    pathStyle,
    storageDriver: storageDriver as 'local' | 's3' | 'spaces',
    cdnUrl,
  };
}

export async function requireSpacesSettings() {
  const settings = await getS3Settings();
  return assertSpacesConfigured(settings);
}

export function assertSpacesConfigured<T extends Awaited<ReturnType<typeof getS3Settings>>>(settings: T): T {
  if (settings.storageDriver !== 'spaces') {
    throw new Error('Video storage requires STORAGE_DRIVER=spaces; local and AWS S3 video fallbacks are disabled.');
  }
  if (!settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
    throw new Error('DigitalOcean Spaces is required for video storage but is missing a Space name or access credentials.');
  }
  return settings;
}

export async function getS3Client() {
  const settings = await getS3Settings();

  if (settings.storageDriver === 'spaces') {
    const endpoint = normalizeSpacesEndpoint(
      settings.endpoint,
      settings.region,
      settings.bucket
    );
    return new S3Client({
      region: 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      forcePathStyle: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    } as any);
  }

  return new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    ...(settings.pathStyle ? { forcePathStyle: true } : {}),
    // Required for browser presigned PUTs — SDK v3 otherwise adds CRC32 query params
    // that XHR/fetch never send → CORS / "S3 network error"
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  } as any);
}

function buildPublicUrl(settings: Awaited<ReturnType<typeof getS3Settings>>, key: string): string {
  const cleanKey = key.replace(/^\/+/, '').replace(/^uploads\//, '');
  if (settings.cdnUrl) return `${settings.cdnUrl}/${cleanKey}`;

  if (settings.storageDriver === 'spaces') {
    const endpointHost = settings.endpoint
      ? settings.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '')
      : `${settings.region}.digitaloceanspaces.com`;
    const cleanHost = endpointHost.startsWith(`${settings.bucket}.`)
      ? endpointHost
      : `${settings.bucket}.${endpointHost}`;
    return `https://${cleanHost}/${cleanKey}`;
  }

  if (settings.pathStyle) {
    return `https://s3.${settings.region}.amazonaws.com/${settings.bucket}/${cleanKey}`;
  }
  return `https://${settings.bucket}.s3.${settings.region}.amazonaws.com/${cleanKey}`;
}

export interface PresignedUrlResult {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  headers?: Record<string, string>;
}

export async function generatePresignedUrl(
  key: string,
  contentType: string,
  expiresIn = 3600
): Promise<PresignedUrlResult> {
  const settings = await getS3Settings();

  if (!settings.accessKeyId || !settings.secretAccessKey || (settings.storageDriver !== 's3' && settings.storageDriver !== 'spaces')) {
    return {
      uploadUrl: `https://mock-storage.local/upload/${key}?token=dev-placeholder`,
      publicUrl: `https://mock-storage.local/${key}`,
      key,
    };
  }

  const s3Client = await getS3Client();
  const isSpaces = settings.storageDriver === 'spaces';
  const command = new PutObjectCommand({
    Bucket: settings.bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
    ...(isSpaces ? { ACL: 'public-read' as const } : {}),
  });

  const signableHeaders = new Set(['content-type', ...(isSpaces ? ['x-amz-acl'] : [])]);
  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn,
    signableHeaders,
  });

  return {
    uploadUrl,
    publicUrl: buildPublicUrl(settings, key),
    key,
    ...(isSpaces ? { headers: { 'x-amz-acl': 'public-read' } } : {}),
  };
}

export async function getSignedObjectUrl(key: string, expiresIn = 604800): Promise<string> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey) {
    throw new Error('Remote storage credentials are not configured');
  }

  const s3Client = await getS3Client();
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: settings.bucket, Key: key }),
    { expiresIn }
  );
}

export async function uploadToS3(
  key: string,
  body: Buffer | Uint8Array | string | Readable,
  contentType: string
): Promise<string> {
  const settings = await getS3Settings();

  if (!settings.accessKeyId || !settings.secretAccessKey || (settings.storageDriver !== 's3' && settings.storageDriver !== 'spaces')) {
    throw new Error('Remote storage credentials not configured or storage driver is not s3/spaces');
  }

  const s3Client = await getS3Client();
  await s3Client.send(
    new PutObjectCommand({
      Bucket: settings.bucket,
      Key: key,
      Body: body as any,
      ContentType: contentType,
      ...(settings.storageDriver === 'spaces' ? { ACL: 'public-read' } : {}),
    })
  );
  return buildPublicUrl(settings, key);
}

export async function uploadReadableToS3(
  key: string,
  body: Readable,
  contentType: string,
  options: { cacheControl?: string } = {}
): Promise<string> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey || (settings.storageDriver !== 's3' && settings.storageDriver !== 'spaces')) {
    throw new Error('Remote storage credentials not configured or storage driver is not s3/spaces');
  }

  const client = await getS3Client();
  const upload = new Upload({
    client,
    params: {
      Bucket: settings.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
      ...(settings.storageDriver === 'spaces' ? { ACL: 'public-read' as const } : {}),
    },
    partSize: 8 * 1024 * 1024,
    queueSize: 2,
    leavePartsOnError: false,
  });
  let lastProgressLogAt = 0;
  upload.on('httpUploadProgress', (progress) => {
    const now = Date.now();
    if (now - lastProgressLogAt < 5_000 && progress.loaded !== progress.total) return;
    lastProgressLogAt = now;
    logger.info({ key, loadedBytes: progress.loaded || 0, totalBytes: progress.total || 0 }, 'Spaces stream upload progress');
  });
  await upload.done();
  return buildPublicUrl(settings, key);
}

export async function uploadVerifiedReadableToSpaces(
  key: string,
  body: Readable,
  contentType: string,
  expectedSize: number,
  dependencies: {
    upload?: typeof uploadReadableToS3;
    getSize?: typeof getS3ObjectSize;
    remove?: typeof deleteFromS3;
  } = {}
): Promise<string> {
  const upload = dependencies.upload || uploadReadableToS3;
  const getSize = dependencies.getSize || getS3ObjectSize;
  const remove = dependencies.remove || deleteFromS3;
  const url = await upload(key, body, contentType, { cacheControl: 'public, max-age=31536000, immutable' });
  const actualSize = await getSize(key);
  if (actualSize <= 0 || (expectedSize > 0 && actualSize !== expectedSize)) {
    await remove(key).catch((error) => logger.error({ error, key }, 'Failed to remove incomplete original upload'));
    throw new Error(`Spaces source verification failed for ${key}: uploaded ${actualSize} of ${expectedSize} bytes`);
  }
  return url;
}

export interface SpacesVideoSource {
  key: string;
  url: string;
  size: number;
  legacyLocalPath?: string;
}

export async function ensureVideoSourceInSpaces(
  source: string,
  entityType: string,
  entityId: string,
  knownKey?: string,
  dependencies: {
    settings?: Awaited<ReturnType<typeof getS3Settings>>;
    head?: (key: string) => Promise<number>;
    upload?: typeof uploadVerifiedReadableToSpaces;
    fetch?: typeof fetch;
    localUploadsRoot?: string;
    publicUrl?: (key: string) => string;
  } = {}
): Promise<SpacesVideoSource> {
  const settings = dependencies.settings ? assertSpacesConfigured(dependencies.settings) : await requireSpacesSettings();
  const candidate = (knownKey || source || '').trim();
  if (!candidate || /\.m3u8(?:[?#]|$)/i.test(candidate)) {
    throw new Error('A source MP4/video file is required; HLS playlists are not original source files.');
  }

  const cdnHost = settings.cdnUrl ? new URL(settings.cdnUrl).host.toLowerCase() : '';
  const spacesHost = `${settings.bucket}.${settings.endpoint?.replace(/^https?:\/\//, '').split('/')[0] || `${settings.region}.digitaloceanspaces.com`}`.toLowerCase();
  let sourceKey = knownKey;
  let externalUrl: URL | undefined;
  try {
    externalUrl = new URL(candidate);
  } catch {}

  if (externalUrl) {
    const host = externalUrl.host.toLowerCase();
    if (host === cdnHost || host === spacesHost) {
      sourceKey = decodeURIComponent(externalUrl.pathname.replace(/^\/+/, ''));
      if (sourceKey.startsWith(`${settings.bucket}/`)) sourceKey = sourceKey.slice(settings.bucket.length + 1);
    }
  } else if (!sourceKey && /^(?:uploads\/)?media\//.test(candidate.replace(/^\/+/, ''))) {
    sourceKey = candidate.replace(/^\/+/, '').replace(/^uploads\//, '');
  }

  const client = dependencies.head ? undefined : await getS3Client();
  if (sourceKey) {
    const normalizedKey = sourceKey.replace(/^\/+/, '').replace(/^uploads\//, '');
    try {
      const size = dependencies.head
        ? await dependencies.head(normalizedKey)
        : Number((await client!.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: normalizedKey }))).ContentLength) || 0;
      return { key: normalizedKey, url: dependencies.publicUrl?.(normalizedKey) || buildPublicUrl(settings, normalizedKey), size };
    } catch (error: any) {
      if (externalUrl && (externalUrl.host.toLowerCase() === cdnHost || externalUrl.host.toLowerCase() === spacesHost)) throw error;
    }
  }

  let body: Readable;
  let size = 0;
  let filename = 'source.mp4';
  let legacyLocalPath: string | undefined;
  const uploadsRoot = path.resolve(__dirname, '../../uploads');
  const localRoot = path.resolve(dependencies.localUploadsRoot || uploadsRoot);
  const linkedUploadPath = externalUrl?.pathname.match(/^\/uploads\/(.+)$/)?.[1];
  const linkedLocalPath = linkedUploadPath ? path.resolve(localRoot, decodeURIComponent(linkedUploadPath)) : undefined;
  const localCandidate = linkedLocalPath && linkedLocalPath.startsWith(`${localRoot}${path.sep}`) && fs.existsSync(linkedLocalPath)
    ? linkedLocalPath
    : undefined;
  if (externalUrl) {
    filename = path.basename(externalUrl.pathname) || filename;
    if (localCandidate) {
      const stat = await fs.promises.stat(localCandidate);
      size = stat.size;
      legacyLocalPath = localCandidate;
      body = fs.createReadStream(localCandidate);
    } else {
      const response = await (dependencies.fetch || fetch)(externalUrl);
      if (!response.ok || !response.body) throw new Error(`Unable to read legacy video source (${response.status})`);
      size = Number(response.headers.get('content-length')) || 0;
      body = Readable.fromWeb(response.body as any);
    }
  } else {
    const relative = candidate.replace(/^\/*uploads\//, '').replace(/^\/+/, '');
    const absolute = path.resolve(localRoot, relative);
    if (!absolute.startsWith(`${localRoot}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Legacy source is not in Spaces and does not exist under the uploads directory: ${candidate}`);
    }
    const stat = await fs.promises.stat(absolute);
    size = stat.size;
    filename = path.basename(absolute);
    body = fs.createReadStream(absolute);
    legacyLocalPath = absolute;
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '-');
  const key = `media/originals/${entityType}/${entityId}/${safeName}`;
  const ext = path.extname(safeName).toLowerCase();
  const contentType = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  const url = await (dependencies.upload || uploadVerifiedReadableToSpaces)(key, body, contentType, size);
  const uploadedSize = size || await getS3ObjectSize(key);
  return { key, url, size: uploadedSize, legacyLocalPath };
}

export async function downloadFromS3ToFile(s3Key: string, destPath: string): Promise<void> {
  const settings = await requireSpacesSettings();
  const s3Client = await getS3Client();
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: settings.bucket,
      Key: s3Key.replace(/^\/+/, ''),
    })
  );
  if (!response.Body) throw new Error('No response body from remote storage');

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const body = response.Body as Readable;
  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const write = fs.createWriteStream(destPath, { flags: 'wx' });
      body.pipe(write);
      write.on('finish', resolve);
      write.on('error', reject);
      body.on('error', reject);
    });
  } catch (error) {
    await fs.promises.rm(destPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Download only the first N bytes — enough for ffprobe without pulling multi‑GB files */
export async function downloadS3RangeToFile(
  s3Key: string,
  destPath: string,
  maxBytes = 48 * 1024 * 1024
): Promise<void> {
  const settings = await requireSpacesSettings();
  const s3Client = await getS3Client();
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: settings.bucket,
      Key: s3Key.replace(/^\/+/, ''),
      Range: `bytes=0-${Math.max(0, maxBytes - 1)}`,
    })
  );
  if (!response.Body) throw new Error('No response body from remote storage range get');

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const body = response.Body as Readable;
  await new Promise<void>((resolve, reject) => {
    const write = fs.createWriteStream(destPath);
    body.pipe(write);
    write.on('finish', () => resolve());
    write.on('error', reject);
    body.on('error', reject);
  });
}

export async function deleteFromS3(key: string): Promise<void> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey || (settings.storageDriver !== 's3' && settings.storageDriver !== 'spaces')) {
    return;
  }
  const s3Client = await getS3Client();
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: settings.bucket,
      Key: key.replace(/^\/+/, '').replace(/^uploads\//, ''),
    })
  );
}

export async function deleteS3Prefix(prefix: string): Promise<number> {
  const settings = await requireSpacesSettings();
  const client = await getS3Client();
  const normalizedPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '') + '/';
  let continuationToken: string | undefined;
  let deleted = 0;

  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: settings.bucket,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (page.Contents || []).flatMap((object) => object.Key ? [{ Key: object.Key }] : []);
    if (objects.length) {
      await client.send(new DeleteObjectsCommand({
        Bucket: settings.bucket,
        Delete: { Objects: objects, Quiet: true },
      }));
      deleted += objects.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}

export async function abortStaleSpacesMultipartUploads(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const settings = await requireSpacesSettings();
  const client = await getS3Client();
  const cutoff = Date.now() - olderThanMs;
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  let aborted = 0;

  do {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: settings.bucket,
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
    }));
    for (const upload of page.Uploads || []) {
      if (!upload.Key || !upload.UploadId || !upload.Initiated || upload.Initiated.getTime() > cutoff) continue;
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: settings.bucket, Key: upload.Key, UploadId: upload.UploadId }));
        aborted++;
      } catch (error) {
        logger.warn({ error, key: upload.Key, initiatedAt: upload.Initiated }, 'Failed to abort stale Spaces multipart upload');
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker || uploadIdMarker);

  if (aborted) logger.warn({ aborted, olderThanMs }, 'Aborted stale Spaces multipart uploads');
  return aborted;
}

export async function isS3Configured(): Promise<boolean> {
  const settings = await getS3Settings();
  const hasCreds = !!(settings.accessKeyId && settings.secretAccessKey && settings.bucket);
  const notPlaceholder =
    settings.accessKeyId !== 'your-access-key-id' &&
    settings.secretAccessKey !== 'your-secret-access-key';
  const isRemote = settings.storageDriver === 's3' || settings.storageDriver === 'spaces';
  return hasCreds && notPlaceholder && isRemote;
}

export async function getS3PublicUrl(key: string): Promise<string> {
  const settings = await getS3Settings();
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  return buildPublicUrl(settings, key);
}

export async function getHlsPublicBaseUrl(): Promise<string> {
  const settings = await getS3Settings();
  if (settings.cdnUrl) return settings.cdnUrl;
  if (settings.storageDriver === 'spaces') {
    const endpointHost = settings.endpoint
      ? settings.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '')
      : `${settings.region}.digitaloceanspaces.com`;
    const cleanHost = endpointHost.startsWith(`${settings.bucket}.`)
      ? endpointHost
      : `${settings.bucket}.${endpointHost}`;
    return `https://${cleanHost}`;
  }
  if (settings.pathStyle) {
    return `https://s3.${settings.region}.amazonaws.com/${settings.bucket}`;
  }
  return `https://${settings.bucket}.s3.${settings.region}.amazonaws.com`;
}

export async function uploadHlsFolderToS3(
  localFolderPath: string,
  s3Prefix: string,
  dependencies: {
    settings?: Awaited<ReturnType<typeof getS3Settings>>;
    uploadFile?: (filePath: string, key: string, contentType: string, cacheControl: string, size: number) => Promise<void>;
    verifyObject?: (key: string) => Promise<number>;
  } = {}
): Promise<number> {
  const settings = dependencies.settings ? assertSpacesConfigured(dependencies.settings) : await requireSpacesSettings();
  const s3Client = dependencies.uploadFile && dependencies.verifyObject ? undefined : await getS3Client();
  const root = path.resolve(localFolderPath);
  const files: Array<{ path: string; relative: string; size: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(fullPath);
        files.push({ path: fullPath, relative: path.relative(root, fullPath).split(path.sep).join('/'), size: stat.size });
      }
    }
  };
  await walk(root);
  validateHlsPackage(root, files.map((file) => file.relative));

  const normalizedPrefix = s3Prefix.replace(/^\/+|\/+$/g, '');
  let cursor = 0;
  let failure: unknown;
  const worker = async () => {
    while (!failure) {
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index];
      const key = `${normalizedPrefix}/${file.relative}`;
      const ext = path.extname(file.relative).toLowerCase();
      const contentType = ext === '.m3u8'
        ? 'application/vnd.apple.mpegurl'
        : ext === '.ts'
          ? 'video/mp2t'
          : 'application/octet-stream';
      try {
        const cacheControl = ext === '.m3u8' ? 'no-cache' : 'max-age=31536000';
        if (dependencies.uploadFile && dependencies.verifyObject) {
          await dependencies.uploadFile(file.path, key, contentType, cacheControl, file.size);
          const remoteSize = await dependencies.verifyObject(key);
          if (remoteSize !== file.size) throw new Error(`HLS object verification failed for ${key}: expected ${file.size} bytes, found ${remoteSize}`);
        } else {
          const upload = new Upload({
            client: s3Client!,
            params: {
              Bucket: settings.bucket,
              Key: key,
              Body: fs.createReadStream(file.path),
              ContentType: contentType,
              CacheControl: cacheControl,
              ACL: 'public-read',
            },
            partSize: 8 * 1024 * 1024,
            queueSize: 1,
            leavePartsOnError: false,
          });
          let lastProgressLogAt = 0;
          upload.on('httpUploadProgress', (progress) => {
            const now = Date.now();
            if (now - lastProgressLogAt < 5_000 && progress.loaded !== progress.total) return;
            lastProgressLogAt = now;
            logger.info({ key, loadedBytes: progress.loaded || 0, totalBytes: progress.total || 0 }, 'HLS Spaces upload progress');
          });
          await upload.done();
          const head = await s3Client!.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }));
          if (head.ContentLength !== file.size) {
            throw new Error(`HLS object verification failed for ${key}: expected ${file.size} bytes, found ${head.ContentLength ?? 0}`);
          }
        }
        logger.info({ key, uploadedBytes: file.size, contentType }, 'HLS object uploaded and verified');
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  if (failure) throw failure;

  logger.info({ s3Prefix: normalizedPrefix, uploadCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0) }, 'Verified HLS upload to DigitalOcean Spaces');
  return files.length;
}

export function validateHlsPackage(root: string, relativeFiles: string[]): void {
  const fileSet = new Set(relativeFiles);
  const playlists = relativeFiles.filter((file) => file.toLowerCase().endsWith('.m3u8'));
  if (!playlists.length) throw new Error('HLS output is incomplete: no playlists were generated');

  for (const playlist of playlists) {
    const playlistPath = path.resolve(root, playlist);
    const playlistText = fs.readFileSync(playlistPath, 'utf8');
    if (!playlistText.split(/\r?\n/).some((line) => line.trim() === '#EXTM3U')) {
      throw new Error(`Invalid HLS playlist: ${playlist}`);
    }
    const references = playlistText.split(/\r?\n/).flatMap((rawLine) => {
      const line = rawLine.trim();
      if (!line) return [];
      const attributeUris = [...line.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]);
      return line.startsWith('#') ? attributeUris : [line];
    });
    if (!references.length) throw new Error(`Empty HLS playlist: ${playlist}`);

    for (const reference of references) {
      if (/^(?:https?:|data:)/i.test(reference)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(playlist), reference.split(/[?#]/)[0]));
      if (resolved.startsWith('../') || path.isAbsolute(resolved) || !fileSet.has(resolved)) {
        throw new Error(`HLS playlist ${playlist} references missing file ${reference}`);
      }
    }
  }
}

/** HeadObject ContentLength — used to skip multi‑GB local HLS downloads */
export async function getS3ObjectSize(key: string): Promise<number> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey) return 0;
  const s3Client = await getS3Client();
  const cleanKey = key.replace(/^\/+/, '').replace(/^uploads\//, '');
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: settings.bucket, Key: cleanKey })
    );
    return Number(head.ContentLength) || 0;
  } catch (err) {
    logger.warn({ err, key: cleanKey }, 'HeadObject failed');
    return 0;
  }
}

/** Test connectivity to AWS S3 or DigitalOcean Spaces */
export async function testStorageConnection(config?: {
  driver?: 's3' | 'spaces';
  spaceName?: string;
  region?: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  pathStyle?: boolean;
}): Promise<{ success: boolean; message?: string; error?: string }> {
  let savedSettings: any = null;
  try {
    const mongoose = await import('mongoose');
    if (mongoose.default.connection.readyState === 1) {
      savedSettings = await SettingsModel.findOne().lean();
    }
  } catch {
    savedSettings = null;
  }
  const driver = config?.driver || (savedSettings as any)?.storageDriver || 'spaces';
  let client: S3Client;
  let bucketName: string;

  if (driver === 'spaces') {
    const spaceName = (config?.spaceName?.trim() || (savedSettings as any)?.doSpaceName || process.env.DO_SPACES_NAME || process.env.DO_SPACES_BUCKET || '').trim();
    const accessKey = (config?.accessKey?.trim() || (savedSettings as any)?.doAccessKey || process.env.DO_SPACES_ACCESS_KEY || process.env.DO_SPACES_KEY || '').trim();
    const secretKey = (config?.secretKey?.trim() || (savedSettings as any)?.doSecretKey || process.env.DO_SPACES_SECRET_KEY || process.env.DO_SPACES_SECRET || '').trim();
    const region = (config?.region?.trim() || (savedSettings as any)?.doRegion || process.env.DO_SPACES_REGION || 'nyc3').trim().toLowerCase();
    const rawEndpoint = config?.endpoint?.trim() || (savedSettings as any)?.doEndpoint || process.env.DO_SPACES_ENDPOINT || `https://${region}.digitaloceanspaces.com`;
    const endpoint = normalizeSpacesEndpoint(rawEndpoint, region, spaceName);

    if (!spaceName || !accessKey || !secretKey) {
      return {
        success: false,
        error: 'Missing required credentials: Space Name, Access Key, and Secret Key are required.',
      };
    }

    bucketName = spaceName;
    client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    } as any);
  } else {
    const bucket = config?.bucket?.trim() || (savedSettings as any)?.awsBucket || process.env.AWS_S3_BUCKET_NAME || '';
    const accessKey = config?.accessKey?.trim() || (savedSettings as any)?.awsAccessKeyId || process.env.AWS_S3_ACCESS_KEY_ID || '';
    const secretKey = config?.secretKey?.trim() || (savedSettings as any)?.awsSecretAccessKey || process.env.AWS_S3_SECRET_ACCESS_KEY || '';
    const region = config?.region?.trim() || (savedSettings as any)?.awsRegion || process.env.AWS_S3_REGION || 'us-east-1';
    const pathStyle = config?.pathStyle !== undefined ? !!config.pathStyle : !!(savedSettings as any)?.awsPathStyleEndpoint;

    if (!bucket || !accessKey || !secretKey) {
      return {
        success: false,
        error: 'Missing required credentials: S3 Bucket Name, Access Key ID, and Secret Access Key are required.',
      };
    }

    bucketName = bucket;
    client = new S3Client({
      region,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      ...(pathStyle ? { forcePathStyle: true } : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    } as any);
  }

  try {
    await client.send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }));
    return {
      success: true,
      message: `Successfully connected to ${driver === 'spaces' ? 'DigitalOcean Space' : 'AWS S3 bucket'} "${bucketName}".`,
    };
  } catch (err: any) {
    logger.error({ err, driver, bucket: bucketName }, 'Storage connection test failed');
    let errMsg = err?.message || 'Failed to connect to storage provider';
    if (err?.name === 'NoSuchBucket' || err?.$metadata?.httpStatusCode === 404) {
      errMsg = `Bucket/Space "${bucketName}" was not found. Please verify the bucket name and region/endpoint.`;
    } else if (err?.name === 'InvalidAccessKeyId' || err?.Code === 'InvalidAccessKeyId') {
      errMsg = 'Invalid Access Key ID.';
    } else if (err?.name === 'SignatureDoesNotMatch' || err?.Code === 'SignatureDoesNotMatch') {
      errMsg = 'Invalid Secret Key (Signature does not match).';
    } else if (err?.name === 'AccessDenied' || err?.Code === 'AccessDenied') {
      errMsg = `Access denied to Bucket/Space "${bucketName}". Please check API key permissions.`;
    }
    return { success: false, error: errMsg };
  }
}
