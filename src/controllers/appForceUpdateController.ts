import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppForceUpdateModel } from '../models/AppForceUpdate';
import { logger } from '../lib/logger';

/** Compare semver-like strings: a < b → -1, a == b → 0, a > b → 1 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => parseInt(x.replace(/\D/g, ''), 10) || 0);
  const pb = String(b || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => parseInt(x.replace(/\D/g, ''), 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

async function getOrCreateConfig() {
  let doc = await AppForceUpdateModel.findOne();
  if (!doc) {
    doc = await AppForceUpdateModel.create({});
  }
  return doc;
}

function serializeConfig(doc: any) {
  return {
    android: {
      latestVersion: doc.android?.latestVersion || '1.0.0',
      minVersion: doc.android?.minVersion || '1.0.0',
      forceUpdateEnabled: !!doc.android?.forceUpdateEnabled,
      storeUrl: doc.android?.storeUrl || '',
    },
    ios: {
      latestVersion: doc.ios?.latestVersion || '1.0.0',
      minVersion: doc.ios?.minVersion || '1.0.0',
      forceUpdateEnabled: !!doc.ios?.forceUpdateEnabled,
      storeUrl: doc.ios?.storeUrl || '',
    },
    title: doc.title || 'Update Required',
    message: doc.message || 'A new version of the app is available. Please update to continue.',
    optionalUpdateTitle: doc.optionalUpdateTitle || 'Update Available',
    optionalUpdateMessage:
      doc.optionalUpdateMessage ||
      'A newer version is available. Update for the best experience.',
    updatedAt: doc.updatedAt || null,
  };
}

/**
 * GET /api/app/force-update
 * Query: platform=android|ios  version=1.2.0  (also accepts currentVersion / appVersion)
 *
 * POST /api/app/force-update  body: { platform, version }
 */
export const checkForceUpdate = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const q = (request.method === 'GET' ? request.query : request.body) as Record<string, any>;
    const platformRaw = String(q?.platform || q?.os || 'android').toLowerCase();
    const platform = platformRaw.includes('ios') || platformRaw === 'iphone' ? 'ios' : 'android';
    const currentVersion = String(
      q?.version || q?.currentVersion || q?.appVersion || '0.0.0'
    ).trim();

    const doc = await getOrCreateConfig();
    const cfg = serializeConfig(doc);
    const platformCfg = platform === 'ios' ? cfg.ios : cfg.android;

    const belowMin = compareVersions(currentVersion, platformCfg.minVersion) < 0;
    const belowLatest = compareVersions(currentVersion, platformCfg.latestVersion) < 0;
    const forceUpdate = !!platformCfg.forceUpdateEnabled && belowMin;
    const optionalUpdate = !forceUpdate && belowLatest;

    return reply.send({
      success: true,
      data: {
        platform,
        currentVersion,
        latestVersion: platformCfg.latestVersion,
        minVersion: platformCfg.minVersion,
        forceUpdate,
        optionalUpdate,
        updateRequired: forceUpdate || optionalUpdate,
        storeUrl: platformCfg.storeUrl,
        title: forceUpdate ? cfg.title : cfg.optionalUpdateTitle,
        message: forceUpdate ? cfg.message : cfg.optionalUpdateMessage,
        androidStoreUrl: cfg.android.storeUrl,
        iosStoreUrl: cfg.ios.storeUrl,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'checkForceUpdate failed');
    return reply.status(500).send({ success: false, message: error.message || 'Failed to check version' });
  }
};

/** GET /api/app-settings/force-update — admin */
export const getForceUpdateConfig = async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    const doc = await getOrCreateConfig();
    return reply.send({ success: true, data: serializeConfig(doc) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** PUT /api/app-settings/force-update — admin */
export const updateForceUpdateConfig = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = (request.body || {}) as Record<string, any>;
    const doc = await getOrCreateConfig();

    if (body.android && typeof body.android === 'object') {
      doc.android = {
        latestVersion: String(body.android.latestVersion || doc.android.latestVersion || '1.0.0').trim(),
        minVersion: String(body.android.minVersion || doc.android.minVersion || '1.0.0').trim(),
        forceUpdateEnabled:
          body.android.forceUpdateEnabled !== undefined
            ? !!body.android.forceUpdateEnabled
            : !!doc.android.forceUpdateEnabled,
        storeUrl: String(body.android.storeUrl ?? doc.android.storeUrl ?? '').trim(),
      };
    }

    if (body.ios && typeof body.ios === 'object') {
      doc.ios = {
        latestVersion: String(body.ios.latestVersion || doc.ios.latestVersion || '1.0.0').trim(),
        minVersion: String(body.ios.minVersion || doc.ios.minVersion || '1.0.0').trim(),
        forceUpdateEnabled:
          body.ios.forceUpdateEnabled !== undefined
            ? !!body.ios.forceUpdateEnabled
            : !!doc.ios.forceUpdateEnabled,
        storeUrl: String(body.ios.storeUrl ?? doc.ios.storeUrl ?? '').trim(),
      };
    }

    if (body.title !== undefined) doc.title = String(body.title);
    if (body.message !== undefined) doc.message = String(body.message);
    if (body.optionalUpdateTitle !== undefined) {
      doc.optionalUpdateTitle = String(body.optionalUpdateTitle);
    }
    if (body.optionalUpdateMessage !== undefined) {
      doc.optionalUpdateMessage = String(body.optionalUpdateMessage);
    }

    await doc.save();
    return reply.send({
      success: true,
      message: 'Force update settings saved',
      data: serializeConfig(doc),
    });
  } catch (error: any) {
    logger.error({ error }, 'updateForceUpdateConfig failed');
    return reply.status(500).send({ success: false, message: error.message });
  }
};
