import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoProcessingJobModel } from '../models/VideoProcessingJob';
import { calculateVideoJobRetryDelay, recoverExpiredVideoJobs } from './videoProcessingQueue';

test('retry backoff increases exponentially and is bounded', () => {
  assert.equal(calculateVideoJobRetryDelay(1, 1_000, 5_000), 1_000);
  assert.equal(calculateVideoJobRetryDelay(2, 1_000, 5_000), 2_000);
  assert.equal(calculateVideoJobRetryDelay(8, 1_000, 5_000), 5_000);
});

test('Mongo video jobs support persistent statuses and have a unique entity index', () => {
  for (const status of ['queued', 'processing', 'uploading', 'completed', 'failed'] as const) {
    const job = new VideoProcessingJobModel({
      entityType: 'episode',
      entityId: '6a67175090ae86bf628ebdc2',
      sourceUrl: 'media/originals/episode/source.mp4',
      status,
    });
    assert.equal(job.validateSync(), undefined);
  }
  assert.ok(VideoProcessingJobModel.schema.indexes().some(([keys, options]) =>
    keys.entityType === 1 && keys.entityId === 1 && options.unique === true
  ));
});

test('restart recovery only requeues expired processing/uploading leases', async () => {
  const calls: Array<{ filter: any; update: any }> = [];
  const now = new Date('2026-10-13T12:00:00Z');
  const modifiedCount = await recoverExpiredVideoJobs(now, {
    updateMany: async (filter: any, update: any) => {
      calls.push({ filter, update });
      return { modifiedCount: calls.length };
    },
  });

  assert.equal(modifiedCount, 3);
  assert.deepEqual(calls[0].filter.status.$in, ['processing', 'uploading']);
  assert.equal(calls[0].filter.$or[0].leaseExpiresAt.$lte, now);
  assert.equal(calls[0].update.$set.status, 'failed');
  assert.deepEqual(calls[1].filter.$and[0].$or[0].attempts, { $lt: 5 });
  assert.equal(calls[1].update.$set.status, 'queued');
  assert.equal(calls[1].update.$set.leaseOwner, null);
});