import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { SectionModel } from '../models/Section';
import { GenreModel } from '../models/Genre';
import { logger } from '../lib/logger';

// Standardized mapping for website ContentItem
const mapContentItem = (item: any) => {
  const isShow = item.contentType === 'tvShow' || item._webKind === 'show' || item.totalSeasons != null;
  let badge;
  if (item.featured && item.trending) badge = 'EXCLUSIVE';
  else if (item.trending) badge = 'TRENDING';
  else if (item.featured) badge = 'TOP';
  else if (item.isNewContent) badge = 'NEW';
  else if (item.views > 1000) badge = 'HOT';

  return {
    id: item._id.toString(),
    title: item.title,
    poster: item.posterImage || item.thumbnail || '',
    backdrop: item.bannerImage || item.thumbnail || '',
    type: isShow ? 'show' : 'movie',
    contentType: isShow ? 'tvShow' : 'movie',
    year: item.year?.toString() || new Date(item.createdAt).getFullYear().toString(),
    duration: item.duration ? `${item.duration}m` : '120m',
    imdbRating: item.imdbRating?.toString() || (item.rating || '8.0'),
    ageRating: item.ageRating ? `${item.ageRating}+` : 'U/A 13+',
    description: item.shortDescription || item.description || '',
    language: item.languages && item.languages.length > 0 ? 'Multi' : 'EN',
    badge,
    genres: (item.genres || []).map((g: any) => g?.name || g),
    planRequired: item.planRequired || 'free',
    isPremium: !!item.planRequired && String(item.planRequired).toLowerCase() !== 'free',
    trailerUrl: item.trailerUrl || null,
    hlsUrl: item.hlsUrl || item.videoUrl || null,
    videoUrl: item.videoUrl || item.hlsUrl || null,
  };
};

const browseCache = new Map<string, { time: number; data: any }>();
const BROWSE_CACHE_TTL = 30000; // 30 seconds

export const getWebBrowse = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { type?: string; genre?: string; page?: string; limit?: string; search?: string; section?: string };
    
    // Check Cache
    const cacheKey = JSON.stringify(query);
    const now = Date.now();
    if (browseCache.has(cacheKey)) {
      const cached = browseCache.get(cacheKey)!;
      if (now - cached.time < BROWSE_CACHE_TTL) {
        return reply.send(cached.data);
      }
      browseCache.delete(cacheKey); // clear expired
    }

    const genreName = query.genre;
    const searchTerm = query.search?.trim();
    const section = query.section;
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    let filter: any = { status: 'published' };

    if (searchTerm) {
      filter.$or = [
        { title: new RegExp(searchTerm, 'i') },
        { description: new RegExp(searchTerm, 'i') },
        { tags: new RegExp(searchTerm, 'i') },
      ];
    }

    // Handle genre filtering
    if (genreName && genreName.toLowerCase() !== 'all') {
      const genre = await GenreModel.findOne({ name: { $regex: new RegExp(`^${genreName}$`, 'i') } }).select('_id').lean();
      if (genre) {
        filter.genres = genre._id;
      } else {
        return reply.send({
          success: true,
          data: { items: [], pagination: { total: 0, page, limit, totalPages: 0 } },
        });
      }
    }

    if (section && section !== 'trending' && section !== 'new' && section !== 'top-rated') {
      const sectionMatch = Types.ObjectId.isValid(section)
        ? { $or: [{ _id: new Types.ObjectId(section) }, { key: section }] }
        : { key: section };
      const configuredSection = await SectionModel.findOne({
        ...sectionMatch,
        isActive: true,
        $and: [{
          $or: [
            { platform: 'web' },
            { platform: 'all' },
            { platform: { $exists: false } },
          ],
        }],
      }).lean();

      if (!configuredSection) {
        return reply.send({
          success: true,
          data: { items: [], sectionTitle: '', pagination: { total: 0, page, limit, totalPages: 0 } },
        });
      }

      const sectionFilter: any = { ...(configuredSection.filter || {}) };
      delete sectionFilter.mediaType;
      if (typeof sectionFilter.genres === 'string' && !Types.ObjectId.isValid(sectionFilter.genres)) {
        const sectionGenre = await GenreModel.findOne({
          name: { $regex: new RegExp(`^${sectionFilter.genres}$`, 'i') },
        }).select('_id').lean();
        if (!sectionGenre) {
          return reply.send({
            success: true,
            data: { items: [], sectionTitle: configuredSection.title, pagination: { total: 0, page, limit, totalPages: 0 } },
          });
        }
        sectionFilter.genres = sectionGenre._id;
      }

      const manualIds = (configuredSection.manualContentIds || []).filter((id: any) => Types.ObjectId.isValid(String(id)));
      const selection = configuredSection.contentSelection || 'dynamic';
      const dynamicQuery = { $and: [filter, sectionFilter] };
      const manualQuery = { $and: [filter, { _id: { $in: manualIds } }] };
      const sectionQuery = selection === 'manual'
        ? manualQuery
        : selection === 'mixed' && manualIds.length > 0
          ? { $or: [dynamicQuery, manualQuery] }
          : dynamicQuery;

      const contentType = configuredSection.contentType;
      const contentModels: { model: any; isShow: boolean }[] = contentType === 'movie'
        ? [{ model: MovieModel, isShow: false }]
        : contentType === 'mixed'
          ? [{ model: MovieModel, isShow: false }, { model: TVShowModel, isShow: true }]
          : [{ model: TVShowModel, isShow: true }];
      const sectionSort = configuredSection.sortBy && Object.keys(configuredSection.sortBy).length
        ? configuredSection.sortBy
        : { createdAt: -1 };
      const fetchCount = skip + limit;
      const batches = await Promise.all(contentModels.map(async ({ model, isShow }) => {
        const [items, total] = await Promise.all([
          model.find(sectionQuery)
            .sort(sectionSort)
            .limit(fetchCount)
            .populate('genres', 'name')
            .lean(),
          model.countDocuments(sectionQuery),
        ]);
        return { items: items.map((item: any) => ({ ...item, contentType: isShow ? 'tvShow' : 'movie' })), total };
      }));

      const allItems = batches.flatMap((batch) => batch.items);
      const sortEntries = Object.entries(sectionSort) as [string, number][];
      allItems.sort((a: any, b: any) => {
        for (const [field, direction] of sortEntries) {
          if (a[field] === b[field]) continue;
          if (a[field] == null) return 1;
          if (b[field] == null) return -1;
          return (a[field] < b[field] ? -1 : 1) * direction;
        }
        return 0;
      });

      const uniqueItems = allItems.filter((item: any, index: number, items: any[]) =>
        items.findIndex((candidate) => String(candidate._id) === String(item._id)) === index
      );
      const items = uniqueItems.slice(skip, skip + limit).map(mapContentItem);
      const total = batches.reduce((sum, batch) => sum + batch.total, 0);
      const responseData = {
        success: true,
        data: {
          items,
          sectionTitle: configuredSection.title,
          pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        },
      };
      browseCache.set(cacheKey, { time: Date.now(), data: responseData });
      return reply.send(responseData);
    }

    let sort: any = { createdAt: -1 };
    if (section === 'trending') {
      sort = { views: -1, createdAt: -1 };
      filter.trending = true;
    } else if (section === 'new') {
      sort = { createdAt: -1 };
      filter.isNewContent = true;
    } else if (section === 'top-rated') {
      sort = { imdbRating: -1, views: -1 };
    }

    const selectFields = 'title description shortDescription thumbnail bannerImage posterImage year rating ageRating duration imdbRating featured trending isNewContent views genres languages planRequired trailerUrl hlsUrl videoUrl createdAt';

    const [rawItems, total] = await Promise.all([
      MovieModel.find(filter).sort(sort).skip(skip).limit(limit).select(selectFields).populate('genres', 'name').lean(),
      MovieModel.countDocuments(filter)
    ]);

    const items = rawItems.map((item: any) => mapContentItem(item));

    const responseData = {
      success: true,
      data: {
        items,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    };

    browseCache.set(cacheKey, { time: Date.now(), data: responseData });

    return reply.send(responseData);

  } catch (error: any) {
    logger.error({ error }, 'Error fetching web browse API data');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
