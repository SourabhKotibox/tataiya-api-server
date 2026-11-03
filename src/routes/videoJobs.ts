import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { checkUserPermission } from '../middlewares/rbac';
import { reprocessMissingHls } from '../controllers/videoJobController';

const requireCatalogEditor = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const userId = (request.user as { id?: string } | undefined)?.id;
    if (!userId) return reply.status(401).send({ success: false, error: 'Unauthorized — valid Bearer token required' });
    const [movies, shows] = await Promise.all([
      checkUserPermission(userId, 'movies', 'canEdit'),
      checkUserPermission(userId, 'tvShows', 'canEdit'),
    ]);
    if (!movies.allowed && !shows.allowed) {
      return reply.status(403).send({ success: false, error: 'Forbidden — movie or TV show edit permission required' });
    }
  } catch {
    return reply.status(401).send({ success: false, error: 'Unauthorized — valid Bearer token required' });
  }
};

const videoJobRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/reprocess-missing', { onRequest: [requireCatalogEditor] }, reprocessMissingHls);
};

export default videoJobRoutes;
