# Video Storage and Transcoding

## Audit Findings

The old 14 GB accumulation came from several independent paths:

- The multipart video handler first streamed the entire request into `uploads/temp/upload-*`, then streamed that second copy to Spaces. Its `finally` removed the staging file during normal completion, but SIGKILL, host restart, or disk/process failure bypassed JavaScript cleanup.
- Media HLS downloaded full originals into a shared `uploads/temp` directory and generated qualities in `uploads/hls/{mediaId}`. The source download had a `finally`, but the HLS folder was removed only after successful upload. A failed FFmpeg run, partial Spaces upload, or process restart left the full HLS tree behind.
- Movie, TV-show, and episode workers wrote HLS into shared `uploads/hls/{type}/{id}` directories. They deleted a rendition only after that rendition uploaded, and had no cleanup `finally` for FFmpeg or upload failures.
- Movie and episode queues were in-memory arrays. PM2 restart discarded queued work; an interrupted `processing` status did not identify a recoverable job.
- A direct presigned browser PUT created a single object and was not a suitable multipart path for very large files.

## New Behavior

- Video originals are streamed through the existing `@aws-sdk/lib-storage` multipart uploader directly into Spaces. No full MP4 staging copy is written to EC2. Incomplete multipart uploads are aborted by the uploader on ordinary failures and by the periodic Spaces cleanup after 24 hours if the process was killed.
- `STORAGE_DRIVER=spaces` is required for video processing and upload. Explicit environment values override the existing Settings-document fallback. Image/document local behavior remains compatible; video local fallback is rejected.
- Legacy originals referenced by MongoDB are copied to Spaces, verified by remote object size, and then their old local path is removed. Sources already in Spaces are reused.
- HLS is encoded in a unique workspace under `VIDEO_TEMP_DIR`. The original, all resolution-appropriate qualities, playlists, and segments are checked locally, streamed to a versioned Spaces prefix, then each remote object's byte length is verified before the content record receives its new playback URL.
- HLS upload failure removes the incomplete versioned prefix. Local workspaces are always removed in `finally`. A poster frame is stored in Spaces as well.
- MongoDB `VideoProcessingJob` records persist queued, processing, uploading, completed, and failed states. Atomic claims, lease heartbeats, bounded retry backoff, and startup recovery protect jobs across PM2 restarts. Run one PM2 API instance by default; higher concurrency should be explicitly sized.
- Startup migrates queued legacy video records. A six-hour cleanup removes expired multipart uploads, expired job workspaces, stale temp files, and stale local HLS only after that entity has a remote HLS URL. Files open by a live process or associated with queued/active jobs are kept.

## Configuration

Set these API environment variables in the deployment environment or API `.env` (do not commit secrets):

```dotenv
STORAGE_DRIVER=spaces
DO_SPACES_NAME=your-space-name
DO_SPACES_REGION=sgp1
DO_SPACES_ENDPOINT=https://sgp1.digitaloceanspaces.com
DO_SPACES_ACCESS_KEY=...
DO_SPACES_SECRET_KEY=...
DO_SPACES_CDN_URL=https://your-space.sgp1.cdn.digitaloceanspaces.com
VIDEO_TEMP_DIR=/var/tmp/tataiya-video-processing
VIDEO_MAX_CONCURRENT_JOBS=1
VIDEO_MIN_FREE_DISK_BYTES=2147483648
VIDEO_MIN_JOB_DISK_BYTES=10737418240
VIDEO_MIN_MEMORY_PER_JOB_BYTES=3221225472
MAX_VIDEO_UPLOAD_BYTES=26843545600
VIDEO_TEMP_TTL_HOURS=24
VIDEO_LEGACY_CLEANUP_TTL_HOURS=72
VIDEO_JOB_POLL_MS=15000
VIDEO_JOB_LEASE_MS=300000
VIDEO_JOB_MAX_ATTEMPTS=5
VIDEO_JOB_RETRY_BASE_MS=30000
VIDEO_LEGACY_UPLOADS_ROOT=/home/ubuntu/uploads
```

The Spaces access key needs object read/write/delete, object listing, and multipart list/abort permissions. The Space/CDN must permit public GETs for the current playback model. Do not put credentials in source control or command-line arguments.

## Safe Deployment

From the API project directory, validate before restarting:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Back up the current environment configuration outside the repository, set the required Spaces variables in the process manager, then restart the existing API process with environment refresh:

```bash
pm2 restart <api-process-name> --update-env
pm2 logs <api-process-name> --lines 200
```

Use the actual PM2 process name from `pm2 list`. Do not run `rm -rf` against `/home/ubuntu/uploads`; migration and cleanup are status-, age-, and active-file-guarded. On startup, the worker creates the `VideoProcessingJob` indexes and queues legacy records that still reference local originals/HLS.

## Verification

1. Check startup logs for `Persistent video-processing worker started`, then confirm Spaces credentials/configuration errors are absent.
2. Upload a test MP4 larger than 2 MB through the admin media library. Confirm the browser progress request completes and the returned MediaFile has `storageType: "spaces"` plus an `s3Key`.
3. Poll the MediaFile and content record until HLS status is completed/ready. Confirm the playback URL starts with the configured Spaces CDN base.
4. Inspect Spaces without printing credentials:

```bash
aws s3api head-object --endpoint-url "$DO_SPACES_ENDPOINT" --bucket "$DO_SPACES_NAME" --key "media/<folder-id>/<file-name>.mp4"
aws s3 ls "s3://$DO_SPACES_NAME/hls/<type>/<content-id>/" --recursive --endpoint-url "$DO_SPACES_ENDPOINT"
aws s3api head-object --endpoint-url "$DO_SPACES_ENDPOINT" --bucket "$DO_SPACES_NAME" --key "hls/<type>/<content-id>/<job-id>/master.m3u8"
```

5. Verify the master playlist references each expected variant, each variant references existing `.ts` segments, and each object has a nonzero `ContentLength`.
6. Check disk without deleting anything:

```bash
du -sh "$VIDEO_TEMP_DIR" /home/ubuntu/uploads/temp /home/ubuntu/uploads/hls 2>/dev/null
find "$VIDEO_TEMP_DIR" -mindepth 1 -maxdepth 1 -type d -print
```

   A successful job should leave no per-job workspace after cleanup. Legacy `/home/ubuntu/uploads/temp` is eligible only after the configured age threshold; local HLS remains until the matching Spaces HLS URL is recorded.

## Disk Sizing and Limits

One job is the default. Before download, the worker checks room for the source plus reserve. After probing, it estimates HLS output from the selected rendition and audio bitrates with 30% overhead and checks again. Approximate peak disk is:

`source size + duration × (sum of selected video and audio bitrates) ÷ 8 × 1.3 + free-space reserve`

At the full 8-rendition ladder, the encoded bitrate budget is about 35.5 Mb/s; a one-hour title can therefore require roughly 16 GB of HLS payload before the 30% headroom, plus the downloaded source and 2 GB reserve. Lower-resolution sources use fewer renditions. Increase concurrency only after sizing temporary disk and memory for every simultaneous job and PM2 instance.

## Test Coverage and Limitations

`npm test` covers configuration rejection, streamed original upload verification, partial-object deletion, legacy-source migration behavior, HLS package/reference validation, object MIME/cache metadata, partial upload failure, isolated workspaces, idempotent cleanup, stale-workspace recovery, job schema uniqueness, bounded retry backoff, and expired-lease recovery.

The test suite uses injected Spaces upload/head callbacks and does not contact production Spaces, MongoDB, or an actual PM2 daemon. Validate one real test upload and one FFmpeg transcode in staging before production rollout. Legacy local files without a MongoDB reference are not automatically migrated; stale unreferenced temp files are age-cleaned, but manually review any untracked originals before removing them.