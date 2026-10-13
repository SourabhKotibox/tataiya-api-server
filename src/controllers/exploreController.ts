import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { UserLikeModel } from '../models/UserLike';
import { UserWishlistModel } from '../models/UserWishlist';
import { UserModel } from '../models/User';
import mongoose from 'mongoose';
import { LanguageModel } from '../models/Language';
import { logger } from '../lib/logger';
import {
  canAccessContent,
  isContentLocked,
  resolveEffectiveUserPlan,
} from '../lib/subscriptionAccess';
import { buildShareUrl } from '../lib/config';
import { calculateEpisodeStartSeconds } from '../lib/videoPreview';
import { toAbsoluteUrl, resolveVideoStream } from '../lib/urlHelper';

// How many extra items to fetch per page to survive deduplication filtering
const FETCH_MULTIPLIER = 4;

// Helper: try to extract userId from JWT (optional auth — no error if missing/invalid)
const getOptionalUserId = (request: FastifyRequest): string | null => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const server = request.server as any;
    const decoded = server.jwt.verify(token) as any;
    return decoded?.id || null;
  } catch {
    return null;
  }
};

// Helper function to map content items for the explore feed
const mapContentItem = (
  request: FastifyRequest,
  item: any,
  likeCount = 0,
  isLikedByUser = false,
  userPlan = 'free',
  type: 'movie' | 'show' = 'show',
  epDoc: any = null,
  isWishlisted = false,
) => {
  const contentPlan = item.planRequired || item.plan || 'free';
  const locked = isContentLocked(contentPlan, userPlan);

  const isShow = type === 'show';
  let streamUrl: string | null = null;
  let hlsUrl: string | null = null;
  let videoUrl: string | null = null;
  let trailerUrl: string | null = null;
  let videoQualities: Array<{ quality: string; url: string; size?: number }> = [];
  let startSeconds = 0;
  let isEpisodePreview = false;

  if (isShow) {
    const hasDirectTrailer = !!item.trailerUrl;
    const hasEpTrailer = !!epDoc?.trailerUrl;
    const showTrailerAbs = hasDirectTrailer ? toAbsoluteUrl(request, item.trailerUrl) : null;
    const epTrailerAbs = hasEpTrailer ? toAbsoluteUrl(request, epDoc.trailerUrl) : null;
    const epStream = epDoc
      ? resolveVideoStream(epDoc, request, 'episodes')
      : resolveVideoStream(item, request, 'episodes');

    if (showTrailerAbs) {
      trailerUrl = showTrailerAbs;
      streamUrl = showTrailerAbs;
      videoUrl = showTrailerAbs;
      hlsUrl = showTrailerAbs;
      videoQualities = epStream.videoQualities;
      startSeconds = 0;
      isEpisodePreview = false;
    } else if (epTrailerAbs) {
      trailerUrl = epTrailerAbs;
      streamUrl = epTrailerAbs;
      videoUrl = epTrailerAbs;
      hlsUrl = epTrailerAbs;
      videoQualities = epStream.videoQualities;
      startSeconds = 0;
      isEpisodePreview = false;
    } else {
      // Episode 1 preview when no trailer exists
      streamUrl = epStream.streamUrl;
      hlsUrl = epStream.hlsUrl || epStream.streamUrl;
      videoUrl = epStream.streamUrl;
      trailerUrl = epStream.streamUrl;
      videoQualities = epStream.videoQualities;
      const duration = epDoc?.duration || item.duration;
      startSeconds = epDoc?.sourceStartSeconds || calculateEpisodeStartSeconds(duration);
      isEpisodePreview = true;
    }
  } else {
    // Movie
    const hasMovieTrailer = !!item.trailerUrl;
    const movieTrailerAbs = hasMovieTrailer ? toAbsoluteUrl(request, item.trailerUrl) : null;
    const movieStream = resolveVideoStream(item, request, 'movies');

    if (movieTrailerAbs) {
      trailerUrl = movieTrailerAbs;
      streamUrl = movieTrailerAbs;
      videoUrl = movieTrailerAbs;
      hlsUrl = movieTrailerAbs;
      videoQualities = movieStream.videoQualities;
      startSeconds = 0;
      isEpisodePreview = false;
    } else {
      // Movie preview
      streamUrl = movieStream.streamUrl;
      hlsUrl = movieStream.hlsUrl || movieStream.streamUrl;
      videoUrl = movieStream.streamUrl;
      trailerUrl = movieStream.streamUrl;
      videoQualities = movieStream.videoQualities;
      startSeconds = calculateEpisodeStartSeconds(item.duration);
      isEpisodePreview = true;
    }
  }

  return {
    id: item._id.toString(),
    title: item.title,
    description: item.description,
    shortDescription: item.shortDescription,
    thumbnail: toAbsoluteUrl(request, item.thumbnail),
    bannerImage: toAbsoluteUrl(request, item.bannerImage),
    posterImage: toAbsoluteUrl(request, item.posterImage || item.bannerImage || item.thumbnail),
    type,
    contentType: type === 'show' ? 'tvShow' : 'movie',
    genres: (item.genres || []).map((g: any) => g.name || g),
    genresText: (item.genres || []).map((g: any) => g.name || g).join(' & '),
    languages: (item.languages || []).map((l: any) => l.name || l),
    views: item.views || 0,
    likeCount,
    isLikedByUser,
    isLiked: isLikedByUser,
    liked: isLikedByUser,
    isWishlisted,
    wishlisted: isWishlisted,
    isWishlist: isWishlisted,
    inWishlist: isWishlisted,
    is_wishlist: isWishlisted,
    is_wishlisted: isWishlisted,
    shares: item.shares || 0,
    shareUrl: buildShareUrl(item._id.toString(), type === 'show' ? 'show' : 'movie'),
    featured: item.featured,
    trending: item.trending,
    isNewContent: item.isNewContent,
    rating: item.rating,
    year: item.year,
    duration: item.duration,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    videoUrl,
    trailerUrl,
    streamUrl,
    hlsUrl,
    videoQualities,
    startSeconds,
    startAt: startSeconds,
    startTime: startSeconds,
    seekTo: startSeconds,
    sourceStartSeconds: startSeconds,
    previewStartTime: startSeconds,
    previewStartSeconds: startSeconds,
    isEpisodePreview,
    contentPlan,
    planRequired: contentPlan,
    isLocked: locked,
  };
};

// Get explore page data (infinite scroll, movies + tvShows)
export const getExplore = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      offset?: string;
      limit?: string;
      sort?: string;
      seenIds?: string;
    };

    const offset = Math.max(0, Number(query.offset || 0));
    const limit = Math.min(10, Math.max(1, Number(query.limit || 5)));
    const sort = (query.sort || 'new').toLowerCase().trim();

    // Parse already-seen IDs sent by the client (dedup across scroll sessions)
    const seenIds = query.seenIds
      ? query.seenIds.split(',').map(id => id.trim()).filter(Boolean)
      : [];

    // Optional auth — used for isLikedByUser + lock gating
    const userId = getOptionalUserId(request);
    let userPlan = 'free';
    if (userId) {
      userPlan = await resolveEffectiveUserPlan(userId);
    }

    let sortBy: any = {};
    let filter: any = { status: { $in: ['published', 'active'] } };

    // Exclude content IDs the client has already seen
    if (seenIds.length > 0) {
      const mongoose = await import('mongoose');
      const seenObjectIds = seenIds
        .filter(id => mongoose.default.Types.ObjectId.isValid(id))
        .map(id => new mongoose.default.Types.ObjectId(id));
      if (seenObjectIds.length > 0) {
        filter._id = { $nin: seenObjectIds };
      }
    }

    switch (sort) {
      case 'new':
        sortBy = { isNewContent: -1, createdAt: -1 };
        break;
      case 'trending':
      case 'hot':
        sortBy = { trending: -1, views: -1, createdAt: -1 };
        break;
      case 'featured':
        sortBy = { featured: -1, trending: -1, views: -1, createdAt: -1 };
        break;
      case 'views':
      case 'popular':
        sortBy = { views: -1, createdAt: -1 };
        break;
      default:
        sortBy = { isNewContent: -1, trending: -1, featured: -1, createdAt: -1 };
    }

    // Get user's preferred language (defaulting to Hindi if skipped/not set)
    let preferredLanguage = 'Hindi';
    if (userId) {
      const user = await UserModel.findById(userId).select('preferredLanguage languageSelectionSkipped').lean();
      if (user) {
        if (user.preferredLanguage) {
          preferredLanguage = user.preferredLanguage;
        } else if (user.languageSelectionSkipped) {
          preferredLanguage = 'Hindi';
        }
      }
    }

    // Lookup corresponding Language document ObjectId
    let targetLanguageId: any = null;
    if (preferredLanguage) {
      const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
      if (langDoc) {
        targetLanguageId = langDoc._id;
      }
    }

    // ── Fetch a larger batch to allow for deduplication ──────────────────────
    const fetchLimit = limit * FETCH_MULTIPLIER;
    const combinedLimit = offset + fetchLimit;
    
    // Primarily fetch TV Shows (movies as secondary/legacy)
    let [rawShows, rawMovies] = await Promise.all([
      TVShowModel.find(filter)
        .sort(sortBy)
        .limit(combinedLimit)
        .populate('languages', 'name')
        .populate('genres', 'name')
        .lean(),
      MovieModel.find(filter)
        .sort(sortBy)
        .limit(combinedLimit)
        .populate('languages', 'name')
        .populate('genres', 'name')
        .lean(),
    ]);

    // Safety fallback: if no published shows found, check non-rejected shows
    if (rawShows.length === 0) {
      const fallbackFilter = { ...filter, status: { $nin: ['rejected'] } };
      rawShows = await TVShowModel.find(fallbackFilter)
        .sort(sortBy)
        .limit(combinedLimit)
        .populate('languages', 'name')
        .populate('genres', 'name')
        .lean();
    }
    if (rawMovies.length === 0) {
      const fallbackFilter = { ...filter, status: { $nin: ['rejected'] } };
      rawMovies = await MovieModel.find(fallbackFilter)
        .sort(sortBy)
        .limit(combinedLimit)
        .populate('languages', 'name')
        .populate('genres', 'name')
        .lean();
    }

    // Tag items
    const taggedShows = rawShows.map(s => ({ ...s, _type: 'show' }));
    const taggedMovies = rawMovies.map(m => ({ ...m, _type: 'movie' }));

    const merged = [...taggedShows, ...taggedMovies];
    
    // Prioritize TV Shows over Movies, then sort according to selected sort mode
    merged.sort((a: any, b: any) => {
      // 1. Shows come first before movies
      const typeA = a._type === 'show' ? 1 : 0;
      const typeB = b._type === 'show' ? 1 : 0;
      if (typeA !== typeB) {
        return typeB - typeA;
      }

      // 2. Sort by criteria
      if (sort === 'trending' || sort === 'hot') {
        const trendA = a.trending ? 1 : 0;
        const trendB = b.trending ? 1 : 0;
        if (trendA !== trendB) return trendB - trendA;
        const viewsA = a.views || 0;
        const viewsB = b.views || 0;
        if (viewsA !== viewsB) return viewsB - viewsA;
      } else if (sort === 'featured') {
        const featA = a.featured ? 1 : 0;
        const featB = b.featured ? 1 : 0;
        if (featA !== featB) return featB - featA;
        const trendA = a.trending ? 1 : 0;
        const trendB = b.trending ? 1 : 0;
        if (trendA !== trendB) return trendB - trendA;
        const viewsA = a.views || 0;
        const viewsB = b.views || 0;
        if (viewsA !== viewsB) return viewsB - viewsA;
      } else if (sort === 'views' || sort === 'popular') {
        const viewsA = a.views || 0;
        const viewsB = b.views || 0;
        if (viewsA !== viewsB) return viewsB - viewsA;
      } else {
        // 'new' or default
        const newA = a.isNewContent ? 1 : 0;
        const newB = b.isNewContent ? 1 : 0;
        if (newA !== newB) return newB - newA;
        const trendA = a.trending ? 1 : 0;
        const trendB = b.trending ? 1 : 0;
        if (trendA !== trendB) return trendB - trendA;
        const featA = a.featured ? 1 : 0;
        const featB = b.featured ? 1 : 0;
        if (featA !== featB) return featB - featA;
      }

      // 3. Fallback to createdAt (newest first)
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    const rawContents = merged.slice(offset, offset + fetchLimit);

    logger.info(
      { offset, limit, fetchLimit, raw: rawContents.length },
      'Explore API raw fetch',
    );

    // ── Deduplicate: remove items with same content ID ────────
    const seenContentIds = new Set<string>();
    const uniqueContents: any[] = [];

    for (const content of rawContents) {
      const cid = content._id ? content._id.toString() : '';
      if (cid && seenContentIds.has(cid)) {
        continue;
      }
      if (cid) seenContentIds.add(cid);
      uniqueContents.push(content);

      if (uniqueContents.length >= limit) break;
    }

    // ── Pre-fetch Episode 1 for TV Shows without trailers ─────────────────────
    const { EpisodeModel } = await import('../models/Episode');
    const showIds = uniqueContents.filter(c => c._type === 'show').map(c => c._id);
    const episodesMap = new Map<string, any>();

    if (showIds.length > 0) {
      const firstEpisodes = await EpisodeModel.find({
        tvShowId: { $in: showIds },
      })
        .sort({ season: 1, episode: 1 })
        .select('tvShowId trailerUrl hlsUrl sourceVideoUrl videoUrl duration sourceStartSeconds videoQualities isFree')
        .lean();

      for (const ep of firstEpisodes) {
        const sId = ep.tvShowId?.toString();
        if (sId && !episodesMap.has(sId)) {
          episodesMap.set(sId, ep);
        }
      }
    }

    // ── Fetch like & wishlist status for unique items ────────────────────────
    const uniqueIds = uniqueContents.map(c => c._id);
    const likedContentIdSet = new Set<string>();
    const wishlistedContentIdSet = new Set<string>();

    if (userId && uniqueIds.length > 0) {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const [userLikes, userWishlists] = await Promise.all([
        UserLikeModel.find({
          userId: userObjectId,
          contentId: { $in: uniqueIds },
        }).select('contentId').lean(),
        UserWishlistModel.find({
          userId: userObjectId,
          contentId: { $in: uniqueIds },
        }).select('contentId').lean(),
      ]);
      userLikes.forEach(l => likedContentIdSet.add(l.contentId.toString()));
      userWishlists.forEach(w => wishlistedContentIdSet.add(w.contentId.toString()));
    }

    // ── Map to response ───────────────────────────────────────────────────────
    const items = uniqueContents.map(content => {
      const cid = content._id.toString();
      const likeCount: number = content.likes || 0;
      const isLikedByUser: boolean = likedContentIdSet.has(cid);
      const isWishlisted: boolean = wishlistedContentIdSet.has(cid);
      const isShow = content._type === 'show';
      const epDoc = isShow ? episodesMap.get(cid) : null;

      return mapContentItem(
        request,
        content,
        likeCount,
        isLikedByUser,
        userPlan,
        content._type || 'show',
        epDoc,
        isWishlisted,
      );
    });

    // nextOffset moves forward by the full raw fetch batch size (not just unique count)
    const nextOffset = offset + rawContents.length;
    const hasMore = rawContents.length === fetchLimit;

    reply.send({
      success: true,
      data: {
        items,
        returnedIds: items.map(i => i.id),
        nextOffset,
        hasMore,
      },
    });
  } catch (error: any) {
    logger.error(error, 'Error fetching explore data');
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch explore data',
      error: error.message,
    });
  }
};
