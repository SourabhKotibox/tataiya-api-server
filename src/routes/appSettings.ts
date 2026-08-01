import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../middlewares/rbac';
import { getAppSettings, updateAppSettings, addAppSetting, deleteAppSetting, editAppSetting, getHomeTabs, updateHomeTabs } from '../controllers/appSettingController';
import { getForceUpdateConfig, updateForceUpdateConfig } from '../controllers/appForceUpdateController';

const appSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/home-tabs', getHomeTabs);
  fastify.put('/home-tabs', updateHomeTabs);

  // Force update / version config (admin)
  fastify.get('/force-update', { onRequest: [requirePermission('settings', 'canView')] }, getForceUpdateConfig);
  fastify.put('/force-update', { onRequest: [requirePermission('settings', 'canEdit')] }, updateForceUpdateConfig);

  fastify.get('/', getAppSettings);
  fastify.put('/', updateAppSettings);
  fastify.post('/', addAppSetting);
  fastify.delete('/:id', deleteAppSetting);
  fastify.patch('/:id', editAppSetting);
};

export default appSettingsRoutes;
