import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../middlewares/rbac';
import { createSeason, deleteSeason, getSeasons, updateSeason } from '../controllers/seasonController';

const seasons: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { onRequest: [requirePermission('tvShows', 'canView')] }, getSeasons);
  fastify.post('/', { onRequest: [requirePermission('tvShows', 'canCreate')] }, createSeason);
  fastify.put('/:id', { onRequest: [requirePermission('tvShows', 'canEdit')] }, updateSeason);
  fastify.delete('/:id', { onRequest: [requirePermission('tvShows', 'canDelete')] }, deleteSeason);
};

export default seasons;