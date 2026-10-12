import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { UserWishlistModel } from '../models/UserWishlist';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { UserModel } from '../models/User';
import { logger } from '../lib/logger';
import { resolveContent } from '../lib/contentResolver';
import { isS3Configured, getS3PublicUrl } from '../lib/s3';

const toAbsoluteUrl = (
  request: FastifyRequest,
  url: string | null | undefined,
  s3Active: boolean = false,
  s3BaseUrl: string = ''
): string | null => {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;

  if (s3Active && s3BaseUrl) {
    const cleanPath = url.startsWith('/') ? url.slice(1) : url;
    return `${s3BaseUrl}/${cleanPath}`;
  }

  let relPath = url;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/') ? `/${relPath}` : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }

  const baseUrl = `${request.protocol}://${request.hostname}`;
  return `${baseUrl}${relPath}`;
};

export const toggleWishlist = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const params = (request.params || {}) as { contentId?: string };
    const body = (request.body || {}) as {
      contentId?: string;
      contentType?: string;
      type?: string;
      profileId?: string;
      action?: string;
    };

    const contentId = body.contentId || params.contentId;
    const rawType = body.contentType || body.type;
    const profileId = body.profileId || (request.headers['x-profile-id'] as string) || null;

    if (!contentId) {
      return reply.status(400).send({ success: false, message: 'contentId is required' });
    }

    const resolved = await resolveContent(contentId, rawType || 'TVShow');
    if (!resolved) {
      return reply.status(404).send({ success: false, message: 'Content not found' });
    }
    const detectedType = rawType || (resolved.type === 'TVShow' ? 'tvShow' : 'movie');

    const user = (request as any).user;
    if (!user || !user.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userObjectId = new mongoose.Types.ObjectId(user.id);
    const contentObjectId = mongoose.Types.ObjectId.isValid(contentId)
      ? new mongoose.Types.ObjectId(contentId)
      : null;

    const queryConditions: any = {
      userId: userObjectId,
      contentId: contentObjectId || contentId,
    };
    if (profileId) {
      queryConditions.profileId = profileId;
    }

    const existingWishlist = await UserWishlistModel.findOne(queryConditions);

    if (body.action === 'add' && existingWishlist) {
      return reply.send({
        success: true,
        message: 'Already in wishlist',
        isWishlisted: true,
        wishlisted: true,
        isWishlist: true,
        inWishlist: true,
        is_wishlist: true,
        is_wishlisted: true,
        data: {
          id: existingWishlist._id.toString(),
          contentId: contentId.toString(),
          type: detectedType,
          contentType: detectedType,
          isWishlisted: true,
          wishlisted: true,
          isWishlist: true,
          inWishlist: true,
          is_wishlist: true,
          is_wishlisted: true,
        },
      });
    }

    if (existingWishlist && body.action !== 'add') {
      // Remove from wishlist
      await UserWishlistModel.deleteOne({ _id: existingWishlist._id });
      await UserModel.findByIdAndUpdate(userObjectId, { $inc: { watchlistCount: -1 } });

      return reply.send({
        success: true,
        message: 'Removed from wishlist',
        isWishlisted: false,
        wishlisted: false,
        isWishlist: false,
        inWishlist: false,
        is_wishlist: false,
        is_wishlisted: false,
        data: {
          id: existingWishlist._id.toString(),
          contentId: contentId.toString(),
          type: detectedType,
          contentType: detectedType,
          isWishlisted: false,
          wishlisted: false,
          isWishlist: false,
          inWishlist: false,
          is_wishlist: false,
          is_wishlisted: false,
        },
      });
    } else {
      // Add to wishlist
      const newWishlist = await UserWishlistModel.create({
        userId: userObjectId,
        contentId: contentObjectId || contentId,
        contentModelType: resolved.type,
        profileId: profileId || null,
      });
      await UserModel.findByIdAndUpdate(userObjectId, { $inc: { watchlistCount: 1 } });

      return reply.send({
        success: true,
        message: 'Added to wishlist',
        isWishlisted: true,
        wishlisted: true,
        isWishlist: true,
        inWishlist: true,
        is_wishlist: true,
        is_wishlisted: true,
        data: {
          id: newWishlist._id.toString(),
          contentId: contentId.toString(),
          type: detectedType,
          contentType: detectedType,
          isWishlisted: true,
          wishlisted: true,
          isWishlist: true,
          inWishlist: true,
          is_wishlist: true,
          is_wishlisted: true,
        },
      });
    }
  } catch (error: any) {
    logger.error({ error }, 'Error toggling wishlist');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const getWishlist = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const user = (request as any).user;
    if (!user || !user.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = user.id;
    // Cast userId string to ObjectId for all DB queries
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const query = request.query as { page?: string; limit?: string; profileId?: string };
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;
    const profileId = query.profileId || (request.headers['x-profile-id'] as string) || null;

    const [wishlistItems, total] = await Promise.all([
      UserWishlistModel.find({ userId: userObjectId, ...(profileId ? { profileId } : {}) })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      UserWishlistModel.countDocuments({ userId: userObjectId, ...(profileId ? { profileId } : {}) }),
    ]);

    // Fetch actual content for the wishlist items
    const selectFields = 'title description shortDescription thumbnail bannerImage posterImage year rating ageRating duration imdbRating type contentType createdAt languages genres';

    const ids = wishlistItems.map(i => i.contentId);
    const [movies, shows] = ids.length > 0
      ? await Promise.all([
          MovieModel.find({ _id: { $in: ids } }).select(selectFields).lean(),
          TVShowModel.find({ _id: { $in: ids } }).select(selectFields).lean(),
        ])
      : [[], []];

    const contentMap = new Map<string, any>();
    movies.forEach((m: any) => contentMap.set(m._id.toString(), { ...m, _kind: 'movie' }));
    shows.forEach((s: any) => contentMap.set(s._id.toString(), { ...s, _kind: 'show' }));

    const s3Active = await isS3Configured();
    let s3BaseUrl = '';
    if (s3Active) {
      const s3Url = await getS3PublicUrl('');
      s3BaseUrl = s3Url.endsWith('/') ? s3Url.slice(0, -1) : s3Url;
    }

    const mappedItems = wishlistItems.map(item => {
      const c: any = contentMap.get(item.contentId.toString());
      if (!c) return null;
      const isShow = c._kind === 'show' || item.contentModelType === 'TVShow' || c.contentType === 'tvShow';
      const posterUrl = toAbsoluteUrl(request, c.posterImage || c.thumbnail, s3Active, s3BaseUrl) || '';
      const bannerUrl = toAbsoluteUrl(request, c.bannerImage || c.thumbnail, s3Active, s3BaseUrl) || '';
      const thumbUrl = toAbsoluteUrl(request, c.thumbnail || c.posterImage, s3Active, s3BaseUrl) || '';

      return {
        id: c._id.toString(),
        contentId: item.contentId.toString(),
        title: c.title,
        poster: posterUrl,
        posterImage: posterUrl,
        backdrop: bannerUrl,
        bannerImage: bannerUrl,
        thumbnail: thumbUrl,
        type: isShow ? 'tvShow' : 'movie',
        contentType: isShow ? 'tvShow' : 'movie',
        year: c.year?.toString() || (c.createdAt ? new Date(c.createdAt).getFullYear().toString() : '2025'),
        duration: c.duration ? `${c.duration}m` : '120m',
        imdbRating: c.imdbRating?.toString() || (c.rating || '8.0'),
        ageRating: c.ageRating ? `${c.ageRating}+` : 'U/A 13+',
        description: c.shortDescription || c.description || '',
        language: c.languages && c.languages.length > 0 ? 'Multi' : 'Hindi',
        genres: (c.genres || []).map((g: any) => g?.name || g),
        isWishlisted: true,
        wishlisted: true,
        isWishlist: true,
        inWishlist: true,
        is_wishlist: true,
        is_wishlisted: true,
        addedAt: item.createdAt,
      };
    }).filter(Boolean);

    return reply.send({
      success: true,
      data: {
        items: mappedItems,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    });

  } catch (error: any) {
    logger.error({ error }, 'Error fetching wishlist');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

