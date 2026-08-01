import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { UserModel } from '../models/User';
import { MovieModel } from '../models/Movie';
import { UserDownloadModel } from '../models/UserDownload';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PlanLimitModel } from '../models/PlanLimit';
import { SubscriptionModel } from '../models/Subscription';
import { logger } from '../lib/logger';
import { normalizePlanKey } from './subscriptionController';

const formatSizeMB = (sizeBytes: number): string => {
  return sizeBytes ? `${Math.round(sizeBytes / (1024 * 1024))} MB` : 'N/A';
};

const toAbsoluteUrl = (
  request: FastifyRequest,
  url: string | null | undefined
): string | null => {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.includes('.amazonaws.com') || url.startsWith('s3://')) return url;

  let relPath = url;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/')
      ? `/${relPath}`
      : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }

  const host = request.headers.host || request.hostname;
  const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
  return `${proto}://${host}${relPath}`;
};

const normalizeMediaUrl = (u: string): string =>
  String(u || '')
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const looksLikeTrailerUrl = (u: string, trailerUrl?: string | null): boolean => {
  const n = normalizeMediaUrl(u);
  if (!n) return false;
  const trailer = normalizeMediaUrl(trailerUrl || '');
  if (trailer) {
    const tLeaf = trailer.split('/').pop() || '';
    const nLeaf = n.split('/').pop() || '';
    if (n === trailer || (tLeaf && nLeaf && tLeaf === nLeaf)) return true;
  }
  if (/(\/|^)(trailer|teaser|preview)s?([\/._-]|$)/i.test(n)) return true;
  if (/[._-](trailer|teaser|preview)(\.|$)/i.test(n)) return true;
  return false;
};

const usableUrl = (u?: string | null): string => {
  const s = String(u || '').trim();
  if (!s || s.startsWith('blob:')) return '';
  return s;
};

/** Progressive full-movie URL only — never the trailer / HLS playlist. */
const pickDownloadUrl = (
  movie: any,
  request: FastifyRequest,
  preferredQuality?: string | null
): string => {
  const trailer = usableUrl(movie.trailerUrl);
  const candidates: string[] = [];
  const push = (u: string) => {
    if (!u || looksLikeTrailerUrl(u, trailer) || candidates.includes(u)) return;
    if (u.includes('.m3u8')) return;
    candidates.push(u);
  };

  if (preferredQuality) {
    const qMatch = (movie.videoQualities || []).find(
      (q: any) => String(q?.quality || '').toLowerCase() === preferredQuality.toLowerCase()
    );
    const qu = usableUrl(qMatch?.url);
    if (qu) push(qu);
  }

  const source = usableUrl(movie.sourceVideoUrl);
  const video = usableUrl(movie.videoUrl);
  const hls = usableUrl(movie.hlsUrl);

  if (source) push(source);
  if (video) push(video);
  for (const q of movie.videoQualities || []) {
    push(usableUrl(q?.url));
  }
  if (hls) push(hls);

  for (const c of candidates) {
    const abs = toAbsoluteUrl(request, c);
    if (abs && !abs.startsWith('blob:') && !looksLikeTrailerUrl(abs, trailer)) return abs;
  }
  return '';
};

const mapQualities = (movie: any, request: FastifyRequest, allowedQualities?: Set<string> | null) => {
  return (movie.videoQualities || [])
    .filter((q: any) => {
      const key = String(q?.quality || '').toLowerCase();
      if (!key || looksLikeTrailerUrl(q?.url || '', movie.trailerUrl)) return false;
      if (String(q?.url || '').includes('.m3u8')) return false;
      if (allowedQualities && allowedQualities.size > 0 && !allowedQualities.has(key)) return false;
      return true;
    })
    .map((q: any) => ({
      quality: q.quality,
      label: String(q.quality || '').toUpperCase(),
      size: q.size || 0,
      sizeFormatted: formatSizeMB(q.size || 0),
      url: toAbsoluteUrl(request, q.url),
    }));
};

function qualitiesAllowedByPlan(limits: any | null): Set<string> | null {
  if (!limits) return null;
  const set = new Set<string>();
  if (limits.q480p) set.add('480p');
  if (limits.q720p) set.add('720p');
  if (limits.q1080p) set.add('1080p');
  if (limits.q1440p) set.add('1440p');
  if (limits.q2k) {
    set.add('2k');
    set.add('1440p');
  }
  if (limits.q4k) {
    set.add('4k');
    set.add('2160p');
  }
  // If plan has no quality flags, don't filter
  return set.size > 0 ? set : null;
}

export async function resolveDownloadLimits(userId: string): Promise<{
  allowed: boolean;
  max: number;
  plan: string;
  reason?: string;
  limits: any | null;
}> {
  const liveSub = await SubscriptionModel.findOne({
    userId,
    status: 'active',
    $or: [{ endDate: { $gte: new Date() } }, { endDate: null }, { endDate: { $exists: false } }],
  })
    .sort({ endDate: -1 })
    .lean();

  const user = await UserModel.findById(userId)
    .select('subscriptionStatus subscriptionExpiry subscriptionPlan subscriptionPlanId')
    .lean();
  if (!user) {
    return { allowed: false, max: 0, plan: 'free', reason: 'User not found', limits: null };
  }

  let planName = 'free';
  let planId = user.subscriptionPlanId || null;

  if (liveSub) {
    planName = normalizePlanKey(liveSub.plan) || 'free';
  } else {
    planName = normalizePlanKey(user.subscriptionPlan) || 'free';
    const isActive =
      user.subscriptionStatus === 'active' &&
      planName !== 'free' &&
      (!user.subscriptionExpiry || new Date(user.subscriptionExpiry) > new Date());
    if (!isActive) planName = 'free';
  }

  if (planName === 'free') {
    return {
      allowed: false,
      max: 0,
      plan: 'free',
      reason: 'Active subscription required to download content offline.',
      limits: null,
    };
  }

  let plan =
    planId
      ? await SubscriptionPlanModel.findById(planId).lean()
      : await SubscriptionPlanModel.findOne({
          name: { $regex: new RegExp(`^${planName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        }).lean();

  if (!plan) {
    return { allowed: true, max: 10, plan: planName, limits: null };
  }

  const limits = await PlanLimitModel.findOne({ planId: plan._id }).lean();
  if (!limits) return { allowed: true, max: 10, plan: planName, limits: null };

  if (!limits.downloadStatus) {
    return {
      allowed: false,
      max: 0,
      plan: planName,
      reason: 'Downloads are not included in your plan. Please upgrade.',
      limits,
    };
  }

  const max = Math.max(0, Number((limits as any).downloadLimitCount ?? 10));
  return { allowed: true, max, plan: planName, limits };
}

function movieHasOfflineFile(movie: any): boolean {
  const trailer = usableUrl(movie.trailerUrl);
  const check = (u?: string | null) => {
    const s = usableUrl(u);
    return !!(s && !s.includes('.m3u8') && !looksLikeTrailerUrl(s, trailer));
  };
  if (check(movie.sourceVideoUrl) || check(movie.videoUrl)) return true;
  if ((movie.videoQualities || []).some((q: any) => check(q?.url))) return true;
  if (check(movie.hlsUrl)) return true;
  return false;
}

/** GET /api/app/download/check?contentId= — eligibility without starting a download */
export const checkDownloadEligibility = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }

    const q = request.query as { contentId?: string; id?: string };
    const contentId = String(q.contentId || q.id || '').trim();
    if (!contentId || !mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid or missing contentId' });
    }

    const limits = await resolveDownloadLimits(userPayload.id);
    const movie = await MovieModel.findById(contentId).lean();
    if (!movie || movie.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Movie not found' });
    }

    const downloadAllowed = (movie as any).downloadAllowed !== false;
    const hasFile = movieHasOfflineFile(movie);
    const used = await UserDownloadModel.countDocuments({
      userId: new mongoose.Types.ObjectId(userPayload.id),
    });
    const alreadyDownloaded = !!(await UserDownloadModel.findOne({
      userId: new mongoose.Types.ObjectId(userPayload.id),
      contentId,
    }).lean());

    const canDownload =
      limits.allowed && downloadAllowed && hasFile && (alreadyDownloaded || used < limits.max);

    let reason: string | null = null;
    if (!limits.allowed) reason = limits.reason || 'Downloads not allowed';
    else if (!downloadAllowed) reason = 'Downloading is disabled for this movie.';
    else if (!hasFile) {
      reason =
        'No progressive MP4 available for offline download. HLS/trailer cannot be used — attach the full movie file.';
    } else if (!alreadyDownloaded && used >= limits.max) {
      reason = `Download limit reached (${limits.max}). Remove an old download or upgrade.`;
    }

    const allowedQualities = qualitiesAllowedByPlan(limits.limits);

    return reply.send({
      success: true,
      data: {
        contentId,
        contentType: 'movie',
        canDownload,
        downloadAllowed,
        downloadEnabled: limits.allowed,
        hasOfflineFile: hasFile,
        alreadyDownloaded,
        plan: limits.plan,
        downloadLimit: limits.max,
        downloadUsed: used,
        reason,
        videoQualities: mapQualities(movie, request, allowedQualities),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'checkDownloadEligibility failed');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** POST /api/app/download — authorize + return progressive URL for offline cache */
export const requestDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const limits = await resolveDownloadLimits(userId);
    if (!limits.allowed) {
      return reply.status(403).send({
        success: false,
        message: limits.reason || 'Downloads not allowed',
        code: 'DOWNLOAD_NOT_ALLOWED',
      });
    }

    const body = (request.body || {}) as {
      contentId?: string;
      contentType?: 'movie';
      quality?: string;
      profileId?: string;
    };
    const contentId = String(body.contentId || '').trim();

    if (!contentId || !mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid contentId' });
    }

    const existing = await UserDownloadModel.findOne({ userId: userObjectId, contentId }).lean();
    if (!existing) {
      const count = await UserDownloadModel.countDocuments({ userId: userObjectId });
      if (count >= limits.max) {
        return reply.status(403).send({
          success: false,
          message: `Download limit reached (${limits.max}). Remove an old download or upgrade your plan.`,
          code: 'DOWNLOAD_LIMIT',
          limit: limits.max,
          used: count,
        });
      }
    }

    const movie = await MovieModel.findById(contentId).lean();
    if (!movie || movie.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Movie not found' });
    }

    if ((movie as any).downloadAllowed === false) {
      return reply.status(400).send({
        success: false,
        message: 'Downloading is disabled for this movie.',
        code: 'DOWNLOAD_DISABLED',
      });
    }

    const preferredQuality = body.quality ? String(body.quality).trim() : null;
    const allowedQualities = qualitiesAllowedByPlan(limits.limits);
    if (preferredQuality && allowedQualities && !allowedQualities.has(preferredQuality.toLowerCase())) {
      return reply.status(403).send({
        success: false,
        message: `Quality ${preferredQuality} is not included in your plan.`,
        code: 'QUALITY_NOT_ALLOWED',
      });
    }

    const downloadUrl = pickDownloadUrl(movie, request, preferredQuality);
    if (!downloadUrl) {
      const hasHls = !!(movie as any).hlsUrl && String((movie as any).hlsUrl).includes('.m3u8');
      return reply.status(404).send({
        success: false,
        code: 'NO_OFFLINE_FILE',
        message: hasHls
          ? 'This movie is streaming-only (HLS). A progressive MP4 is required for offline download — re-upload the full movie file.'
          : 'No full movie file available for offline download. Trailer cannot be used — attach the full movie video.',
      });
    }

    const qualities = mapQualities(movie, request, allowedQualities);

    const downloadDoc: any = await UserDownloadModel.findOneAndUpdate(
      { userId: userObjectId, contentId },
      {
        $set: {
          quality: preferredQuality || existing?.quality || null,
          status: existing?.status === 'completed' ? 'completed' : 'pending',
          ...(body.profileId !== undefined ? { profileId: body.profileId || null } : {}),
        },
        $setOnInsert: { contentModelType: 'Movie', progress: 0 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const used = await UserDownloadModel.countDocuments({ userId: userObjectId });

    return reply.send({
      success: true,
      message: 'Download authorized. Save the file on-device for offline playback.',
      data: {
        id: downloadDoc._id.toString(),
        userId,
        contentId,
        contentType: 'movie',
        title: movie.title,
        thumbnail: toAbsoluteUrl(request, movie.thumbnail || '') || '',
        duration: movie.duration || 0,
        quality: downloadDoc.quality || preferredQuality || 'auto',
        downloadUrl,
        videoQualities: qualities,
        status: downloadDoc.status || 'pending',
        progress: downloadDoc.progress || 0,
        downloadLimit: limits.max,
        downloadUsed: used,
        expiresInSeconds: null,
        offline: true,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'requestDownload failed');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/app/downloads */
export const getDownloadList = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const { profileId, page, limit } = request.query as {
      profileId?: string;
      page?: string;
      limit?: string;
    };
    const filter: any = { userId: userObjectId };
    if (profileId) filter.profileId = profileId;

    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '50', 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [downloads, total, limits] = await Promise.all([
      UserDownloadModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      UserDownloadModel.countDocuments(filter),
      resolveDownloadLimits(userId),
    ]);

    const allowedQualities = qualitiesAllowedByPlan(limits.limits);
    const result = [];

    for (const dl of downloads) {
      const movie = await MovieModel.findById(dl.contentId).lean();
      if (!movie || movie.status !== 'published') continue;

      result.push({
        id: dl._id.toString(),
        contentId: dl.contentId.toString(),
        contentType: 'movie',
        title: movie.title,
        thumbnail: toAbsoluteUrl(request, movie.thumbnail || '') || '',
        duration: movie.duration || 0,
        quality: (dl as any).quality || null,
        downloadUrl: pickDownloadUrl(movie, request, (dl as any).quality),
        videoQualities: mapQualities(movie, request, allowedQualities),
        status: (dl as any).status || 'pending',
        progress: (dl as any).progress || 0,
        fileSize: (dl as any).fileSize ?? null,
        createdAt: dl.createdAt,
        updatedAt: dl.updatedAt,
      });
    }

    return reply.send({
      success: true,
      data: result,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        downloadLimit: limits.max,
        downloadUsed: await UserDownloadModel.countDocuments({ userId: userObjectId }),
        downloadEnabled: limits.allowed,
        plan: limits.plan,
      },
    });
  } catch (error: any) {
    logger.error(error, 'Error getting downloads list');
    return reply
      .status(500)
      .send({ success: false, message: 'Failed to fetch downloads.', error: error.message });
  }
};

export const getDownloadsList = getDownloadList;

/** PATCH /api/app/downloads/:id — client reports progress/status after local save */
export const updateDownloadStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userObjectId = new mongoose.Types.ObjectId(userPayload.id);
    const { id } = request.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, message: 'Invalid download ID' });
    }

    const body = (request.body || {}) as {
      status?: string;
      progress?: number;
      fileSize?: number;
      quality?: string;
    };

    const allowedStatus = new Set(['pending', 'downloading', 'completed', 'failed', 'paused']);
    const update: any = {};
    if (body.status && allowedStatus.has(body.status)) update.status = body.status;
    if (body.progress !== undefined) {
      update.progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
    }
    if (body.fileSize !== undefined) update.fileSize = Math.max(0, Number(body.fileSize) || 0);
    if (body.quality !== undefined) update.quality = String(body.quality || '') || null;

    if (Object.keys(update).length === 0) {
      return reply.status(400).send({ success: false, message: 'No valid fields to update' });
    }

    const doc = await UserDownloadModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), userId: userObjectId },
      { $set: update },
      { new: true }
    );

    if (!doc) {
      return reply.status(404).send({ success: false, message: 'Download record not found' });
    }

    return reply.send({
      success: true,
      message: 'Download status updated',
      data: {
        id: doc._id.toString(),
        status: doc.status,
        progress: doc.progress,
        quality: doc.quality,
        fileSize: doc.fileSize,
      },
    });
  } catch (error: any) {
    logger.error(error, 'Error updating download status');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

export const deleteDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userObjectId = new mongoose.Types.ObjectId(userPayload.id);
    const { id } = request.params as { id: string };

    if (id === 'all') {
      await UserDownloadModel.deleteMany({ userId: userObjectId });
      return reply.send({ success: true, message: 'All downloads deleted successfully' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, message: 'Invalid download ID' });
    }

    const deleted = await UserDownloadModel.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(id),
      userId: userObjectId,
    });
    if (!deleted) {
      return reply.status(404).send({ success: false, message: 'Download record not found' });
    }

    return reply.send({ success: true, message: 'Download deleted successfully' });
  } catch (error: any) {
    logger.error(error, 'Error deleting download');
    return reply
      .status(500)
      .send({ success: false, message: 'Failed to delete download.', error: error.message });
  }
};

export const removeDownload = deleteDownload;

export const removeAllDownloads = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userObjectId = new mongoose.Types.ObjectId(userPayload.id);
    const result = await UserDownloadModel.deleteMany({ userId: userObjectId });

    return reply.send({
      success: true,
      message: 'All downloads deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    logger.error(error, 'Error removing all downloads');
    return reply
      .status(500)
      .send({ success: false, message: 'Failed to delete all downloads.', error: error.message });
  }
};
