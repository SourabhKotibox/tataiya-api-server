import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { logger } from './logger';
import { SettingsModel } from '../models/Settings';

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
    (settings as any)?.storageDriver ||
    process.env.STORAGE_DRIVER ||
    's3';

  if (storageDriver === 'spaces') {
    const accessKeyId =
      (settings as any)?.doAccessKey ||
      process.env.DO_SPACES_ACCESS_KEY ||
      process.env.DO_SPACES_KEY ||
      '';
    const secretAccessKey =
      (settings as any)?.doSecretKey ||
      process.env.DO_SPACES_SECRET_KEY ||
      process.env.DO_SPACES_SECRET ||
      '';
    const region = (
      (settings as any)?.doRegion ||
      process.env.DO_SPACES_REGION ||
      'nyc3'
    ).trim().toLowerCase();
    const bucket = (
      (settings as any)?.doSpaceName ||
      process.env.DO_SPACES_NAME ||
      process.env.DO_SPACES_BUCKET ||
      ''
    ).trim();
    const rawEndpoint =
      (settings as any)?.doEndpoint ||
      process.env.DO_SPACES_ENDPOINT ||
      `https://${region}.digitaloceanspaces.com`;
    const endpoint = normalizeSpacesEndpoint(rawEndpoint, region, bucket);
    const cdnUrl =
      ((settings as any)?.doCdnUrl || process.env.DO_SPACES_CDN_URL || '').replace(/\/$/, '');

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
  const command = new PutObjectCommand({
    Bucket: settings.bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  // Only sign content-type so browser XHR PUT matches the signature
  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn,
    signableHeaders: new Set(['content-type']),
  });

  return {
    uploadUrl,
    publicUrl: buildPublicUrl(settings, key),
    key,
  };
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

export async function downloadFromS3ToFile(s3Key: string, destPath: string): Promise<void> {
  const settings = await getS3Settings();
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
  await new Promise<void>((resolve, reject) => {
    const write = fs.createWriteStream(destPath);
    body.pipe(write);
    write.on('finish', () => resolve());
    write.on('error', reject);
    body.on('error', reject);
  });
}

/** Download only the first N bytes — enough for ffprobe without pulling multi‑GB files */
export async function downloadS3RangeToFile(
  s3Key: string,
  destPath: string,
  maxBytes = 48 * 1024 * 1024
): Promise<void> {
  const settings = await getS3Settings();
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

export async function uploadHlsFolderToS3(localFolderPath: string, s3Prefix: string): Promise<number> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey || (settings.storageDriver !== 's3' && settings.storageDriver !== 'spaces')) {
    throw new Error('Remote storage is not configured — cannot upload HLS folder');
  }

  const s3Client = await getS3Client();
  let uploadCount = 0;

  const getContentType = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
    if (ext === '.ts') return 'video/mp2t';
    return 'application/octet-stream';
  };

  const uploadDir = async (dirPath: string, keyPrefix: string) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const s3Key = `${keyPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await uploadDir(fullPath, s3Key);
        } else if (entry.isFile()) {
          const body = fs.readFileSync(fullPath);
          const ext = path.extname(entry.name).toLowerCase();
          await s3Client.send(
            new PutObjectCommand({
              Bucket: settings.bucket,
              Key: s3Key,
              Body: body,
              ContentType: getContentType(entry.name),
              CacheControl: ext === '.m3u8' ? 'no-cache' : 'max-age=31536000',
              ...(settings.storageDriver === 'spaces' ? { ACL: 'public-read' } : {}),
            })
          );
          uploadCount++;
        }
      })
    );
  };

  await uploadDir(localFolderPath, s3Prefix.replace(/\/$/, ''));
  logger.info({ s3Prefix, uploadCount }, 'HLS folder uploaded to remote storage');
  return uploadCount;
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

