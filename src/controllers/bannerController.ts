import type { FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { BannerModel } from '../models/Banner';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import uploadHandler from '../lib/uploadHandler';
import { calculateEpisodeStartSeconds } from '../lib/videoPreview';
import { toAbsoluteUrl, resolveVideoStream, findDiskHlsMaster } from '../lib/urlHelper';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.join(__dirname, '../../uploads');

type BannerMultipartData = {
  title?: string;
  subtitle?: string;
  description?: string;
  genres?: string[];
  languages?: string[];
  targetPlatforms?: Array<'web' | 'mobile' | 'tv'>;
  position?: number;
  isActive?: boolean;
  ctaText?: string;
  ctaLink?: string;
  startDate?: Date;
  endDate?: Date;
  thumbnail?: string;
  contentId?: string;
};

const parseList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseBool = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 'yes';
};

const parseDate = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const parsePlatforms = (value: unknown): Array<'web' | 'mobile' | 'tv'> => {
  const allowed = new Set(['web', 'mobile', 'tv']);
  return parseList(value).filter((platform): platform is 'web' | 'mobile' | 'tv' => allowed.has(platform));
};

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const ensureDefaultBannerImage = () => {
  const folder = path.join(uploadsRoot, 'banners');
  const fileName = 'default-video-banner.svg';
  const filePath = path.join(folder, fileName);
  ensureDir(folder);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#0b1217"/>
  <rect x="64" y="64" width="1152" height="592" rx="28" fill="#141d23" stroke="#2a343c" stroke-width="4"/>
  <circle cx="640" cy="360" r="92" fill="#e50914"/>
  <path d="M615 312v96l84-48z" fill="#fff"/>
  <text x="640" y="515" text-anchor="middle" fill="#d7dde2" font-family="Arial, sans-serif" font-size="42" font-weight="700">Video Upload</text>
</svg>`
    );
  }

  return `/uploads/banners/${fileName}`;
};

const mapContent = (content: any, request?: FastifyRequest | null) => {
  const isShow = content.contentType === 'tvShow' || content.type === 'tvShow' || !!content.totalSeasons;
  const contentType = isShow ? 'tvShow' : 'movie';
  const folderType = isShow ? 'episodes' : 'movies';

  const videoStream = resolveVideoStream(content, request, folderType);
  const trailerUrl = toAbsoluteUrl(request, content.trailerUrl) || null;
  const startSeconds = content.startSeconds || 0;

  const streamUrl = trailerUrl || videoStream.streamUrl;
  const hlsUrl = videoStream.hlsUrl || trailerUrl || videoStream.streamUrl;

  return {
    id: content._id.toString(),
    title: content.title,
    subtitle: content.shortDescription,
    description: content.description,
    thumbnail: toAbsoluteUrl(request, content.thumbnail),
    bannerImage: toAbsoluteUrl(request, content.bannerImage),
    posterImage: toAbsoluteUrl(request, content.posterImage),
    genres: content.genres,
    languages: content.languages,
    views: content.views,
    likes: content.likes,
    shares: content.shares,
    status: content.status,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    contentType,
    type: contentType,
    hlsUrl,
    videoUrl: streamUrl,
    trailerUrl: trailerUrl || streamUrl,
    streamUrl,
    videoQualities: videoStream.videoQualities,
    startSeconds,
    startAt: startSeconds,
    startTime: startSeconds,
    seekTo: startSeconds,
    sourceStartSeconds: startSeconds,
    previewStartTime: startSeconds,
    previewStartSeconds: startSeconds,
    isEpisodePreview: !!content.isEpisodePreview,
  };
};

const populateBannersContent = async (banners: any[], request?: FastifyRequest | null) => {
  const contentIds = banners.map((b) => b.contentId).filter(Boolean);
  if (contentIds.length === 0) return banners;

  const [movies, shows] = await Promise.all([
    MovieModel.find({ _id: { $in: contentIds } }).lean(),
    TVShowModel.find({ _id: { $in: contentIds } }).lean(),
  ]);

  // Create a map for quick lookups
  const contentMap = new Map();
  for (const movie of movies) {
    contentMap.set(movie._id.toString(), { ...movie, contentType: 'movie' });
  }
  for (const show of shows) {
    contentMap.set(show._id.toString(), { ...show, contentType: 'tvShow' });
  }

  // Pre-fetch Episode 1 trailer or video for TV shows
  const showIds = shows.map((s) => s._id);
  if (showIds.length > 0) {
    try {
      const { EpisodeModel } = await import('../models/Episode');
      const firstEpisodes = await EpisodeModel.find({ tvShowId: { $in: showIds } })
        .sort({ season: 1, episode: 1 })
        .select('tvShowId trailerUrl hlsUrl sourceVideoUrl videoUrl duration sourceStartSeconds videoQualities')
        .lean();
      for (const ep of firstEpisodes) {
        const sId = ep.tvShowId?.toString();
        if (sId && contentMap.has(sId)) {
          const show = contentMap.get(sId);
          const hasShowTrailer = !!show.trailerUrl;
          const hasEpTrailer = !!ep.trailerUrl;
          const epStream = resolveVideoStream(ep, request, 'episodes');
          const epVideo = epStream.hlsUrl || epStream.streamUrl || ep.hlsUrl || ep.sourceVideoUrl || ep.videoUrl;
          const epDuration = ep.duration;
          const epStart = ep.sourceStartSeconds || calculateEpisodeStartSeconds(epDuration);

          if (!hasShowTrailer) {
            if (hasEpTrailer) {
              show.trailerUrl = ep.trailerUrl;
              show.startSeconds = 0;
            } else if (epVideo) {
              show.trailerUrl = epVideo;
              show.videoUrl = epVideo;
              show.hlsUrl = epStream.hlsUrl || epVideo;
              show.startSeconds = epStart;
              show.isEpisodePreview = true;
              show.videoQualities = epStream.videoQualities;
            }
          }
          if (!show.videoUrl && epVideo) {
            show.videoUrl = epVideo;
            show.hlsUrl = epStream.hlsUrl || epVideo;
            if (!show.videoQualities?.length) show.videoQualities = epStream.videoQualities;
          }
        }
      }
    } catch (e) {
      console.error('Error fetching episode trailer for banners:', e);
    }
  }

  // Assign populated content back to banner
  for (const banner of banners) {
    if (banner.contentId) {
      const c = contentMap.get(banner.contentId.toString()) || null;
      banner.contentId = c;
      if (c) {
        if (!banner.trailerUrl) banner.trailerUrl = c.trailerUrl;
        if (!banner.videoUrl) banner.videoUrl = c.videoUrl || c.hlsUrl;
        if (!banner.hlsUrl) banner.hlsUrl = c.hlsUrl || c.videoUrl;
        if (c.startSeconds !== undefined && (!banner.startSeconds || banner.startSeconds === 0)) {
          banner.startSeconds = c.startSeconds;
        }
        if (c.isEpisodePreview) banner.isEpisodePreview = true;
        if (c.videoQualities?.length && !banner.videoQualities?.length) {
          banner.videoQualities = c.videoQualities;
        }
      }
    }
  }

  return banners;
};

const resequenceBanners = async (movedBannerId?: string, targetPosition?: number) => {
  try {
    const banners = await BannerModel.find().sort({ position: 1, updatedAt: -1 });
    let currentPos = 1;
    for (const banner of banners) {
      if (movedBannerId && banner._id.toString() === movedBannerId) {
        continue;
      }
      if (targetPosition !== undefined && currentPos === targetPosition) {
        currentPos++;
      }
      if (banner.position !== currentPos) {
        banner.position = currentPos;
        await BannerModel.updateOne({ _id: banner._id }, { $set: { position: currentPos } });
      }
      currentPos++;
    }
  } catch (error) {
    console.error('Error resequencing banners:', error);
  }
};

const mapBanner = (banner: any, request?: FastifyRequest | null) => {
  const content = banner.contentId;
  const thumbnail = toAbsoluteUrl(request, banner.imageUrl || content?.thumbnail || banner.thumbnail);
  const startSeconds = banner.startSeconds || content?.startSeconds || 0;
  const isShow = banner.contentType === 'tvShow' || content?.contentType === 'tvShow' || content?.type === 'tvShow' || !!content?.totalSeasons;
  const folderType = isShow ? 'episodes' : 'movies';

  const contentStream = resolveVideoStream(content, request, folderType);
  const bannerStream = resolveVideoStream(banner, request, folderType);

  const trailerUrl = toAbsoluteUrl(request, banner.trailerUrl || content?.trailerUrl) || null;
  const streamUrl = trailerUrl || bannerStream.streamUrl || contentStream.streamUrl;
  const hlsUrl = bannerStream.hlsUrl || contentStream.hlsUrl || streamUrl;
  const videoQualities = (bannerStream.videoQualities?.length ? bannerStream.videoQualities : contentStream.videoQualities) || [];

  return {
    id: banner._id.toString(),
    title: banner.title,
    subtitle: banner.subtitle,
    description: banner.description,
    thumbnail,
    imageUrl: thumbnail,
    mobileImageUrl: toAbsoluteUrl(request, banner.mobileImageUrl || banner.imageUrl || content?.thumbnail),
    trailerUrl: trailerUrl || streamUrl,
    videoUrl: streamUrl,
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
    isEpisodePreview: !!(banner.isEpisodePreview || content?.isEpisodePreview),
    ctaText: banner.ctaText,
    ctaLink: banner.ctaLink,
    position: banner.position,
    isActive: banner.isActive,
    type: banner.type || 'hero',
    contentType: banner.contentType || content?.contentType || 'tvShow',
    targetPlatforms: banner.targetPlatforms || [],
    startDate: banner.startDate,
    endDate: banner.endDate,
    content: content ? mapContent(content, request) : undefined,
  };
};

const readBannerMultipart = async (request: FastifyRequest): Promise<BannerMultipartData & { thumbnailFilePath?: string }> => {
  const data: BannerMultipartData & { thumbnailFilePath?: string } = {};

  if ((request as any).isMultipart && (request as any).isMultipart()) {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'title') data.title = part.value as string;
        if (part.fieldname === 'subtitle') data.subtitle = part.value as string;
        if (part.fieldname === 'description') data.description = part.value as string;
        if (part.fieldname === 'genres') data.genres = parseList(part.value);
        if (part.fieldname === 'languages') data.languages = parseList(part.value);
        if (part.fieldname === 'position') data.position = Number(part.value);
        if (part.fieldname === 'isActive') data.isActive = parseBool(part.value, true);
        if (part.fieldname === 'ctaText') data.ctaText = part.value as string;
        if (part.fieldname === 'ctaLink') data.ctaLink = part.value as string;
        if (part.fieldname === 'targetPlatforms') data.targetPlatforms = parsePlatforms(part.value);
        if (part.fieldname === 'startDate') data.startDate = parseDate(part.value);
        if (part.fieldname === 'endDate') data.endDate = parseDate(part.value);
        if (part.fieldname === 'thumbnail') data.thumbnail = part.value as string;
        if (part.fieldname === 'bannerImage') data.thumbnail = part.value as string;
        if (part.fieldname === 'imageUrl') data.thumbnail = part.value as string;
        if (part.fieldname === 'contentId') data.contentId = part.value as string;
      } else if (part.type === 'file') {
        if (part.fieldname === 'thumbnailFile' || part.fieldname === 'bannerFile') {
          const uploadedFile = await uploadHandler.saveFileFromPart(part, request as any, 'BANNER');
          data.thumbnail = uploadedFile.url;
          data.thumbnailFilePath = uploadedFile.filePath;
        }
      }
    }
  } else if (request.body && typeof request.body === 'object') {
    const b = request.body as any;
    if (b.title !== undefined) data.title = b.title;
    if (b.subtitle !== undefined) data.subtitle = b.subtitle;
    if (b.description !== undefined) data.description = b.description;
    if (b.genres !== undefined) data.genres = parseList(b.genres);
    if (b.languages !== undefined) data.languages = parseList(b.languages);
    if (b.position !== undefined) data.position = Number(b.position);
    if (b.isActive !== undefined) data.isActive = parseBool(b.isActive, true);
    if (b.ctaText !== undefined) data.ctaText = b.ctaText;
    if (b.ctaLink !== undefined) data.ctaLink = b.ctaLink;
    if (b.targetPlatforms !== undefined) data.targetPlatforms = parsePlatforms(b.targetPlatforms);
    if (b.startDate !== undefined) data.startDate = parseDate(b.startDate);
    if (b.endDate !== undefined) data.endDate = parseDate(b.endDate);
    if (b.thumbnail !== undefined) data.thumbnail = b.thumbnail;
    if (b.imageUrl !== undefined) data.thumbnail = b.imageUrl;
    if (b.bannerImage !== undefined) data.thumbnail = b.bannerImage;
    if (b.contentId !== undefined) data.contentId = b.contentId;
  }

  return data;
};

export const listBanners = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await resequenceBanners();
    const query = request.query as {
      page?: string;
      limit?: string;
      platform?: 'web' | 'mobile' | 'tv';
      admin?: string;
    };
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const now = new Date();
    const isAdminView = parseBool(query.admin, false);
    const filter: any = isAdminView
      ? {}
      : {
          isActive: true,
          $and: [
            { $or: [{ startDate: { $exists: false } }, { startDate: { $lte: now } }] },
            { $or: [{ endDate: { $exists: false } }, { endDate: { $gte: now } }] },
          ],
        };

    if (query.platform) {
      filter.targetPlatforms = query.platform;
    }

    const [bannersRaw, total] = await Promise.all([
      BannerModel.find(filter)
        .sort({ position: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      BannerModel.countDocuments(filter),
    ]);

    const banners = await populateBannersContent(bannersRaw, request);

    return {
      success: true,
      data: banners.map((banner: any) => mapBanner(banner, request)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  } catch (error: any) {
    console.error('Error listing banners:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const createBannerFromContent = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      contentId: string;
      contentSource?: 'movie' | 'tvShow' | 'show' | 'series' | string;
      title?: string;
      subtitle?: string;
      description?: string;
      ctaText?: string;
      ctaLink?: string;
      position?: number;
      isActive?: boolean;
      imageUrl?: string;
      thumbnail?: string;
    };

    if (!body.contentId) {
      return reply.status(400).send({ success: false, message: 'contentId is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(body.contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid contentId format' });
    }

    // Fetch the source content (support TV shows and Movies)
    let source: any = null;
    let contentType: 'tvShow' | 'movie' = 'tvShow';

    if (body.contentSource === 'movie') {
      source = await MovieModel.findById(body.contentId).lean();
      contentType = 'movie';
      if (!source) {
        source = await TVShowModel.findById(body.contentId).lean();
        if (source) contentType = 'tvShow';
      }
    } else {
      source = await TVShowModel.findById(body.contentId).lean();
      contentType = 'tvShow';
      if (!source) {
        source = await MovieModel.findById(body.contentId).lean();
        if (source) contentType = 'movie';
      }
    }

    if (!source) {
      return reply.status(404).send({ success: false, message: 'Source content not found' });
    }

    // If source TV show has no trailerUrl, lookup Episode 1 trailer or video
    let resolvedTrailerUrl = source.trailerUrl;
    let resolvedStartSeconds = 0;
    let isEpisodePreview = false;

    if (!resolvedTrailerUrl && contentType === 'tvShow') {
      try {
        const { EpisodeModel } = await import('../models/Episode');
        const ep1 = await EpisodeModel.findOne({ tvShowId: source._id })
          .sort({ season: 1, episode: 1 })
          .select('trailerUrl hlsUrl sourceVideoUrl videoUrl duration sourceStartSeconds videoQualities')
          .lean();
        if (ep1) {
          if (ep1.trailerUrl) {
            resolvedTrailerUrl = ep1.trailerUrl;
            resolvedStartSeconds = 0;
          } else {
            const epStream = resolveVideoStream(ep1, request, 'episodes');
            resolvedTrailerUrl = epStream.hlsUrl || epStream.streamUrl || ep1.hlsUrl || ep1.sourceVideoUrl || ep1.videoUrl;
            resolvedStartSeconds = ep1.sourceStartSeconds || calculateEpisodeStartSeconds(ep1.duration);
            isEpisodePreview = true;
          }
        }
      } catch {}
    } else if (!resolvedTrailerUrl && contentType === 'movie') {
      const movieStream = resolveVideoStream(source, request, 'movies');
      if (movieStream.streamUrl) {
        resolvedTrailerUrl = movieStream.streamUrl;
        resolvedStartSeconds = calculateEpisodeStartSeconds(source.duration);
        isEpisodePreview = true;
      }
    }

    const thumbnail =
      body.imageUrl ||
      body.thumbnail ||
      source.thumbnail ||
      source.bannerImage ||
      source.imageUrl ||
      ensureDefaultBannerImage();
    const title = body.title || source.title;
    const videoUrl = source.hlsUrl || source.videoUrl || undefined;

    // Check if a banner already exists for this content
    const existing = await BannerModel.findOne({ contentId: body.contentId });
    if (existing) {
      existing.title = title;
      existing.subtitle = body.subtitle || source.shortDescription || existing.subtitle || '';
      existing.description = body.description || source.description || existing.description || '';
      existing.imageUrl = thumbnail;
      existing.trailerUrl = resolvedTrailerUrl || existing.trailerUrl;
      existing.videoUrl = videoUrl || existing.videoUrl;
      existing.startSeconds = resolvedStartSeconds || existing.startSeconds || 0;
      existing.isEpisodePreview = isEpisodePreview || existing.isEpisodePreview || false;
      existing.ctaText = body.ctaText || existing.ctaText || 'Watch Now';
      existing.ctaLink = body.ctaLink || existing.ctaLink || '';
      existing.isActive = body.isActive ?? true;
      existing.contentType = contentType;
      existing.targetPlatforms = ['web', 'mobile', 'tv'];
      if (Number.isFinite(body.position)) existing.position = body.position!;
      await existing.save();

      await resequenceBanners(existing._id.toString(), existing.position);

      const bannerRaw = await BannerModel.findById(existing._id).lean();
      const populated = await populateBannersContent([bannerRaw], request);

      return reply.status(200).send({
        success: true,
        data: mapBanner(populated[0], request),
        message: 'Banner updated successfully from content.',
      });
    }

    const banner = await BannerModel.create({
      title,
      subtitle: body.subtitle || source.shortDescription || '',
      description: body.description || source.description || '',
      imageUrl: thumbnail,
      trailerUrl: resolvedTrailerUrl || undefined,
      videoUrl,
      startSeconds: resolvedStartSeconds,
      isEpisodePreview,
      ctaText: body.ctaText || 'Watch Now',
      ctaLink: body.ctaLink || '',
      contentId: body.contentId,
      type: 'hero',
      contentType,
      position: Number.isFinite(body.position) ? body.position : 0,
      isActive: body.isActive ?? true,
      targetPlatforms: ['web', 'mobile', 'tv'],
    });

    await resequenceBanners(banner._id.toString(), banner.position);

    const bannerRaw = await BannerModel.findById(banner._id).lean();
    const populated = await populateBannersContent([bannerRaw], request);

    return reply.status(201).send({
      success: true,
      data: mapBanner(populated[0], request),
      message: 'Banner created successfully from existing content.',
    });
  } catch (error: any) {
    console.error('Error creating banner from content:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const createBanner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const data = await readBannerMultipart(request);

    if (!data.title) {
      return reply.status(400).send({
        success: false,
        message: 'title is required',
      });
    }

    // If content is linked, verify it exists (TV show or Movie)
    let linkedTrailerUrl: string | undefined;
    let linkedVideoUrl: string | undefined;
    let linkedStartSeconds = 0;
    let linkedIsEpisodePreview = false;
    let linkedContentType: 'tvShow' | 'movie' = 'tvShow';

    if (data.contentId && mongoose.Types.ObjectId.isValid(data.contentId)) {
      const show = await TVShowModel.findById(data.contentId).lean();
      if (show) {
        linkedContentType = 'tvShow';
        linkedTrailerUrl = show.trailerUrl;
        linkedVideoUrl = show.hlsUrl || show.videoUrl;
        if (!linkedTrailerUrl) {
          try {
            const { EpisodeModel } = await import('../models/Episode');
            const ep1 = await EpisodeModel.findOne({ tvShowId: show._id })
              .sort({ season: 1, episode: 1 })
              .select('trailerUrl hlsUrl sourceVideoUrl videoUrl duration sourceStartSeconds videoQualities')
              .lean();
            if (ep1) {
              if (ep1.trailerUrl) {
                linkedTrailerUrl = ep1.trailerUrl;
                linkedStartSeconds = 0;
              } else {
                const epStream = resolveVideoStream(ep1, request, 'episodes');
                linkedTrailerUrl = epStream.hlsUrl || epStream.streamUrl || ep1.hlsUrl || ep1.sourceVideoUrl || ep1.videoUrl;
                linkedStartSeconds = ep1.sourceStartSeconds || calculateEpisodeStartSeconds(ep1.duration);
                linkedIsEpisodePreview = true;
              }
            }
          } catch {}
        }
      } else {
        const movie = await MovieModel.findById(data.contentId).lean();
        if (movie) {
          linkedContentType = 'movie';
          linkedTrailerUrl = movie.trailerUrl;
          linkedVideoUrl = movie.videoUrl || movie.hlsUrl;
          if (!linkedTrailerUrl) {
            const movieStream = resolveVideoStream(movie, request, 'movies');
            if (movieStream.streamUrl) {
              linkedTrailerUrl = movieStream.streamUrl;
              linkedStartSeconds = calculateEpisodeStartSeconds(movie.duration);
              linkedIsEpisodePreview = true;
            }
          }
        }
      }
    }

    const thumbnail = data.thumbnail || ensureDefaultBannerImage();

    const banner = await BannerModel.create({
      title: data.title,
      subtitle: data.subtitle,
      description: data.description,
      imageUrl: thumbnail,
      trailerUrl: linkedTrailerUrl,
      videoUrl: linkedVideoUrl,
      startSeconds: linkedStartSeconds,
      isEpisodePreview: linkedIsEpisodePreview,
      ctaText: data.ctaText || 'Watch Now',
      ctaLink: data.ctaLink,
      contentId: (data.contentId && mongoose.Types.ObjectId.isValid(data.contentId)) ? data.contentId : undefined,
      type: 'hero',
      contentType: linkedContentType,
      position: Number.isFinite(data.position) ? data.position : 0,
      isActive: data.isActive ?? true,
      targetPlatforms: data.targetPlatforms?.length ? data.targetPlatforms : ['web', 'mobile', 'tv'],
      startDate: data.startDate,
      endDate: data.endDate,
    });

    await resequenceBanners(banner._id.toString(), banner.position);

    const bannerRaw = await BannerModel.findById(banner._id).lean();
    const populated = await populateBannersContent([bannerRaw], request);

    return reply.status(201).send({
      success: true,
      data: mapBanner(populated[0], request),
      message: 'Banner created successfully.',
    });
  } catch (error: any) {
    console.error('Error creating banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const getBannerById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { bannerId } = request.params as { bannerId: string };
    const bannerRaw = await BannerModel.findById(bannerId).lean();

    if (!bannerRaw) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    const populated = await populateBannersContent([bannerRaw], request);
    const banner = populated[0];

    return {
      success: true,
      data: mapBanner(banner, request),
    };
  } catch (error: any) {
    console.error('Error getting banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const updateBanner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { bannerId } = request.params as { bannerId: string };
    const existingBanner = await BannerModel.findById(bannerId);

    if (!existingBanner) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    const existingContent = existingBanner.contentId
      ? (await TVShowModel.findById(existingBanner.contentId).lean()) ||
        (await MovieModel.findById(existingBanner.contentId).lean())
      : null;
    const data = await readBannerMultipart(request);
    const updateData: Record<string, any> = {};

    if (data.title !== undefined) updateData.title = data.title;
    if (data.subtitle !== undefined) updateData.subtitle = data.subtitle;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.position !== undefined && Number.isFinite(data.position)) updateData.position = data.position;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.ctaText !== undefined) updateData.ctaText = data.ctaText;
    if (data.ctaLink !== undefined) updateData.ctaLink = data.ctaLink;
    if (data.thumbnail !== undefined) updateData.imageUrl = data.thumbnail;
    if (data.targetPlatforms?.length) updateData.targetPlatforms = data.targetPlatforms;
    if (data.startDate !== undefined) updateData.startDate = data.startDate;
    if (data.endDate !== undefined) updateData.endDate = data.endDate;

    const updatedBannerDoc = await BannerModel.findByIdAndUpdate(bannerId, { $set: updateData }, { new: true });

    if (!updatedBannerDoc) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    await resequenceBanners(updatedBannerDoc._id.toString(), updatedBannerDoc.position);

    if (existingBanner.contentId) {
      const contentUpdate: Record<string, any> = {};
      if (data.title !== undefined) contentUpdate.title = data.title;
      if (data.subtitle !== undefined) contentUpdate.shortDescription = data.subtitle;
      if (data.description !== undefined) contentUpdate.description = data.description;
      if (data.thumbnail !== undefined) {
        contentUpdate.thumbnail = data.thumbnail;
        contentUpdate.bannerImage = data.thumbnail;
      }
      if (data.genres !== undefined) contentUpdate.genres = data.genres;
      if (data.languages?.length) contentUpdate.languages = data.languages;

      if (Object.keys(contentUpdate).length > 0) {
        await Promise.all([
          MovieModel.findByIdAndUpdate(existingBanner.contentId, { $set: contentUpdate }),
          TVShowModel.findByIdAndUpdate(existingBanner.contentId, { $set: contentUpdate }),
        ]);
      }
    }

    if (data.thumbnail && existingBanner.imageUrl !== data.thumbnail) {
      await uploadHandler.deleteUploadedFile(existingBanner.imageUrl);
    }

    if (data.thumbnail && existingContent?.thumbnail && existingContent.thumbnail !== data.thumbnail) {
      await uploadHandler.deleteUploadedFile(existingContent.thumbnail);
    }

    const bannerRaw = await BannerModel.findById(bannerId).lean();
    if (!bannerRaw) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }
    const populated = await populateBannersContent([bannerRaw], request);
    const banner = populated[0];

    return {
      success: true,
      data: mapBanner(banner, request),
      message: 'Banner updated successfully',
    };
  } catch (error: any) {
    console.error('Error updating banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const deleteBanner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { bannerId } = request.params as { bannerId: string };
    const banner = await BannerModel.findByIdAndDelete(bannerId).lean();

    if (!banner) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    if (banner.imageUrl) {
      await uploadHandler.deleteUploadedFile(banner.imageUrl);
    }

    await resequenceBanners();

    return {
      success: true,
      message: 'Banner deleted successfully',
    };
  } catch (error: any) {
    console.error('Error deleting banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const bulkDeleteBanners = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, message: 'Invalid or empty ids array' });
    }

    const banners = await BannerModel.find({ _id: { $in: ids } }).lean();

    for (const banner of banners) {
      if (banner.imageUrl) {
        await uploadHandler.deleteUploadedFile(banner.imageUrl);
      }
    }

    const result = await BannerModel.deleteMany({ _id: { $in: ids } });

    await resequenceBanners();

    return reply.send({
      success: true,
      message: `${result.deletedCount} banner(s) deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    console.error('Error bulk deleting banners:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
