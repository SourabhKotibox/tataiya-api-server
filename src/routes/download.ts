import type { FastifyPluginAsync } from 'fastify';
import {
  requestDownload,
  getDownloadsList,
  removeDownload,
  removeAllDownloads,
  checkDownloadEligibility,
  updateDownloadStatus,
} from '../controllers/downloadController';

const downloadRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
  });

  // Check if user can download a title (before starting)
  // GET /api/app/download/check?contentId=
  fastify.get('/download/check', checkDownloadEligibility);

  // Authorize offline download + return progressive MP4 URL
  // POST /api/app/download  body: { contentId, quality? }
  fastify.post('/download', requestDownload);

  // List user's downloads
  // GET /api/app/downloads
  fastify.get('/downloads', getDownloadsList);

  // Client reports local download progress/status
  // PATCH /api/app/downloads/:id  body: { status, progress, fileSize?, quality? }
  fastify.patch('/downloads/:id', updateDownloadStatus);

  // Remove all
  fastify.delete('/downloads', removeAllDownloads);

  // Remove one (or :id=all)
  fastify.delete('/downloads/:id', removeDownload);
};

export default downloadRoutes;
