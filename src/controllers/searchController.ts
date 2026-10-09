import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { UserModel } from '../models/User';
import { LanguageModel } from '../models/Language';
import { GenreModel } from '../models/Genre';
import { logger } from '../lib/logger';
import mongoose from 'mongoose';
import {
  isContentLocked,
  resolveEffectiveUserPlan,
} from '../lib/subscriptionAccess';

// Helper: try to extract userId from JWT (optional auth)
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

// Unified item mapper
const mapSearchItem = (item: any, userPlan = 'free', type = 'movie') => {
  const contentPlan = item.planRequired || 'free';
  return {
    id: item._id.toString(),
    title: item.title,
    description: item.description,
    shortDescription: item.shortDescription,
    thumbnail: item.thumbnail,
    bannerImage: item.bannerImage,
    posterImage: item.posterImage || item.thumbnail || null,
    type: type,
    contentPlan,
    planRequired: contentPlan,
    isLocked: isContentLocked(contentPlan, userPlan),
    views: item.views || 0,
    rating: item.rating,
    year: item.year,
    duration: item.duration,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

export const getRecommendations = async (preferredLanguage: string, userPlan = 'free') => {
  let targetLanguageId: mongoose.Types.ObjectId | null = null;
  if (preferredLanguage) {
    const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
    if (langDoc) {
      targetLanguageId = langDoc._id as mongoose.Types.ObjectId;
    }
  }

  const filter: any = { status: 'published' };
  if (targetLanguageId) filter.languages = targetLanguageId;

  const recShows = await TVShowModel.find(filter).sort({ views: -1, createdAt: -1 }).limit(12).lean();

  const recommendationsList = recShows.map(s => mapSearchItem(s, userPlan, 'tvShow'));
  recommendationsList.sort((a, b) => b.views - a.views);
  return recommendationsList.slice(0, 12);
};

export const getSearchPage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { q?: string };
    const searchTerm = query.q?.trim() || '';

    const userId = getOptionalUserId(request);

    // Get user's preferred language + active plan
    let preferredLanguage = 'Hindi';
    let userPlan = 'free';
    if (userId) {
      const [plan, user] = await Promise.all([
        resolveEffectiveUserPlan(userId),
        UserModel.findById(userId)
          .select('preferredLanguage languageSelectionSkipped')
          .lean(),
      ]);
      userPlan = plan;
      if (user) {
        if (user.preferredLanguage) {
          preferredLanguage = user.preferredLanguage;
        } else if (user.languageSelectionSkipped) {
          preferredLanguage = 'Hindi';
        }
      }
    }

    if (!searchTerm) {
      // 1. Initial State: Return Trending Searches & Recommended For You

      // A. Fetch Trending Searches (top viewed/liked show titles only)
      const popularShows = await TVShowModel.find({ status: 'published' })
          .sort({ views: -1, likes: -1 })
          .limit(8)
          .select('title views likes')
          .lean();

      const trendingSearchesSet = new Set<string>();
      popularShows.forEach(s => trendingSearchesSet.add((s as any).title));
      const trendingSearches = Array.from(trendingSearchesSet).slice(0, 6);

      const recommendations = await getRecommendations(preferredLanguage, userPlan);

      return reply.send({
        success: true,
        data: {
          isQueryEmpty: true,
          trendingSearches,
          recommendations,
        }
      });
    }

    let targetLanguageId: mongoose.Types.ObjectId | null = null;
    if (preferredLanguage) {
      const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
      if (langDoc) {
        targetLanguageId = langDoc._id as mongoose.Types.ObjectId;
      }
    }

    // 2. Active Query State: Perform Search
    const regex = new RegExp(searchTerm, 'i');

    // Check for genre matches
    const matchedGenres = await GenreModel.find({ name: regex }).select('_id').lean();
    const genreIds = matchedGenres.map(g => g._id);

    // Build query conditions
    const queryOptions: any[] = [
      { title: regex },
      { originalTitle: regex },
      { description: regex },
      { shortDescription: regex },
      { tags: regex }
    ];
    if (genreIds.length > 0) queryOptions.push({ genres: { $in: genreIds } });

    const baseFilter = {
      status: 'published' as const,
      ...(targetLanguageId ? { languages: targetLanguageId } : {}),
      $or: queryOptions
    };

    // Search only TV shows
    const matchedShows = await TVShowModel.find(baseFilter).limit(30).lean();

    const results = matchedShows.map(s => mapSearchItem(s, userPlan, 'tvShow'));

    // Sort search results by views/popularity
    results.sort((a, b) => b.views - a.views);

    if (results.length === 0) {
      const recommendations = await getRecommendations(preferredLanguage, userPlan);
      return reply.send({
        success: true,
        data: {
          isQueryEmpty: false,
          results: [],
          message: 'No match found',
          recommendations
        }
      });
    }

    return reply.send({
      success: true,
      data: {
        isQueryEmpty: false,
        results
      }
    });

  } catch (error: any) {
    logger.error({ error }, 'Error during search operation');
    return reply.status(500).send({
      success: false,
      message: 'Failed to process search request',
      error: error.message
    });
  }
};
