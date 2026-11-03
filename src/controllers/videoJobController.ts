import type { FastifyReply, FastifyRequest } from 'fastify';
import { enqueueMissingHlsJobs } from '../services/videoProcessingQueue';
import { logger } from '../lib/logger';

/** POST /api/video-jobs/reprocess-missing — queue every title that has no remote HLS playlist. */
export const reprocessMissingHls = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = (request.body || {}) as { retryFailed?: boolean };
    const counts = await enqueueMissingHlsJobs({ retryFailed: body.retryFailed !== false });
    return reply.send({
      success: true,
      message: 'Queued movies, series, episodes, trailers, and library videos that are missing HLS in Spaces.',
      data: counts,
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to queue missing HLS jobs');
    return reply.status(500).send({ success: false, error: error.message || 'Failed to queue HLS jobs' });
  }
};
