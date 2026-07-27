import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { UserModel } from '../models/User';
import { MovieModel } from '../models/Movie';
import { UserDownloadModel } from '../models/UserDownload';
import { logger } from '../lib/logger';

// Helper to format bytes to MB
const formatSizeMB = (sizeBytes: number): string => {
  return sizeBytes ? `${Math.round(sizeBytes / (1024 * 1024))} MB` : 'N/A';
};

const toAbsoluteUrl = (
  request: FastifyRequest,
  url: string | null | undefined
): string | null => {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;

  let relPath = url;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/') ? `/${relPath}` : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }

  const host = request.headers.host || request.hostname;
  const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
  return `${proto}://${host}${relPath}`;
};

const pickDownloadUrl = (movie: any, request: FastifyRequest): string => {
  const candidates: string[] = [];
  if (movie.videoUrl && !String(movie.videoUrl).includes('.m3u8')) candidates.push(movie.videoUrl);
  for (const q of movie.videoQualities || []) {
    if (q?.url && !String(q.url).includes('.m3u8')) candidates.push(q.url);
  }
  if (movie.hlsUrl) candidates.push(movie.hlsUrl);
  if (movie.videoUrl) candidates.push(movie.videoUrl);
  for (const q of movie.videoQualities || []) {
    if (q?.url) candidates.push(q.url);
  }
  for (const c of candidates) {
    const abs = toAbsoluteUrl(request, c);
    if (abs) return abs;
  }
  return '';
};

export const requestDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    // Cast userId string to ObjectId for all DB queries
    const userObjectId = new mongoose.Types.ObjectId(userId);

    // Check user subscription status
    const user = await UserModel.findById(userObjectId).select('subscriptionStatus subscriptionExpiry').lean();
    if (!user) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    const isActive = user.subscriptionStatus === 'active' && (!user.subscriptionExpiry || user.subscriptionExpiry > new Date());
    if (!isActive) {
      return reply.status(403).send({ success: false, message: 'Active subscription required to download content.' });
    }

    const { contentId } = request.body as {
      contentId: string;
      contentType?: 'movie';
    };

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid contentId' });
    }

    const movie = await MovieModel.findById(contentId).lean();
    if (!movie || movie.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Movie not found' });
    }

    if (!movie.downloadAllowed) {
      return reply.status(400).send({ success: false, message: 'Downloading is disabled for this movie.' });
    }

    const title = movie.title;
    const thumbnail = toAbsoluteUrl(request, movie.thumbnail || '') || '';
    const duration = movie.duration || 0;
    const downloadUrl = pickDownloadUrl(movie, request);
    if (!downloadUrl) {
      return reply.status(404).send({ success: false, message: 'No video URL available for this content' });
    }
    const qualities = (movie.videoQualities || []).map((q: any) => ({
      quality: q.quality,
      label: q.quality.toUpperCase(),
      size: q.size,
      sizeFormatted: formatSizeMB(q.size),
      url: toAbsoluteUrl(request, q.url)
    }));

    // Upsert download record
    const downloadDoc: any = await UserDownloadModel.findOneAndUpdate(
      { userId: userObjectId, contentId },
      { $setOnInsert: { contentModelType: 'Movie' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return reply.send({
      success: true,
      data: {
        id: downloadDoc._id.toString(),
        userId: userId,
        contentId: contentId,
        contentType: 'movie',
        title: title,
        thumbnail: thumbnail,
        duration: duration,
        downloadUrl: downloadUrl,
        videoQualities: qualities,
        status: downloadDoc.status || 'pending',
        progress: downloadDoc.progress || 0,
        createdAt: downloadDoc.createdAt
      }
    });
  } catch (error: any) {
    logger.error(error, 'Error requesting download');
    return reply.status(500).send({ success: false, message: 'Failed to request download.', error: error.message });
  }
};

export const getDownloadList = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const downloads = await UserDownloadModel.find({ userId: userObjectId }).sort({ createdAt: -1 }).lean();

    const result = [];

    for (const dl of downloads) {
      const movie = await MovieModel.findById(dl.contentId).lean();
      if (!movie || movie.status !== 'published') continue;

      const qualities = (movie.videoQualities || []).map((q: any) => ({
        quality: q.quality,
        label: q.quality.toUpperCase(),
        size: q.size,
        sizeFormatted: formatSizeMB(q.size),
        url: toAbsoluteUrl(request, q.url)
      }));

      result.push({
        id: dl._id.toString(),
        contentId: dl.contentId.toString(),
        contentType: 'movie',
        title: movie.title,
        thumbnail: toAbsoluteUrl(request, movie.thumbnail || '') || '',
        duration: movie.duration || 0,
        downloadUrl: pickDownloadUrl(movie, request),
        videoQualities: qualities,
        status: (dl as any).status || 'pending',
        progress: (dl as any).progress || 0,
        createdAt: dl.createdAt
      });
    }

    return reply.send({
      success: true,
      data: result
    });
  } catch (error: any) {
    logger.error(error, 'Error getting downloads list');
    return reply.status(500).send({ success: false, message: 'Failed to fetch downloads.', error: error.message });
  }
};

export const getDownloadsList = getDownloadList;

export const deleteDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const { id } = request.params as { id: string };

    if (id === 'all') {
      await UserDownloadModel.deleteMany({ userId: userObjectId });
      return reply.send({
        success: true,
        message: 'All downloads deleted successfully'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, message: 'Invalid download ID' });
    }

    const deleted = await UserDownloadModel.findOneAndDelete({ _id: new mongoose.Types.ObjectId(id), userId: userObjectId });
    if (!deleted) {
      return reply.status(404).send({ success: false, message: 'Download record not found' });
    }

    return reply.send({
      success: true,
      message: 'Download deleted successfully'
    });
  } catch (error: any) {
    logger.error(error, 'Error deleting download');
    return reply.status(500).send({ success: false, message: 'Failed to delete download.', error: error.message });
  }
};

export const removeDownload = deleteDownload;

export const removeAllDownloads = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const result = await UserDownloadModel.deleteMany({ userId: userObjectId });

    return reply.send({
      success: true,
      message: 'All downloads deleted successfully.',
      deletedCount: result.deletedCount
    });
  } catch (error: any) {
    logger.error(error, 'Error removing all downloads');
    return reply.status(500).send({ success: false, message: 'Failed to delete all downloads.', error: error.message });
  }
};
