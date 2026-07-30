import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { UserModel } from '../models/User';
import { UserLikeModel } from '../models/UserLike';
import { UserWishlistModel } from '../models/UserWishlist';
import { UserWatchProgressModel } from '../models/UserWatchProgress';
import { UserDownloadModel } from '../models/UserDownload';
import { SubscriptionModel } from '../models/Subscription';
import { logger } from '../lib/logger';
import { buildShareUrl } from '../lib/config';
import { QUALITY_LABELS, QUALITY_PLAN_GATE } from './watchController';
import { normalizePlanKey } from './subscriptionController';

const PLAN_LEVELS: Record<string, number> = {
  free: 0,
  basic: 1,
  standard: 2,
  premium: 3,
};

const normalizePlan = (plan: string | null | undefined): string =>
  String(plan || 'free').trim().toLowerCase();

/** True when the user cannot access content/quality that requires `requiredPlan`. */
const isPlanLocked = (userPlan: string, requiredPlan: string): boolean => {
  const plan = normalizePlan(userPlan);
  const required = normalizePlan(requiredPlan);
  if (required === 'free') return false;
  // Any active paid plan unlocks paid titles (same rule as watchController).
  if (plan === 'free') return true;
  return (PLAN_LEVELS[plan] ?? 0) < (PLAN_LEVELS[required] ?? 1);
};

// Helper to convert relative URLs to absolute URLs
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
  
  const baseUrl = `${request.protocol}://${request.hostname}`;
  return `${baseUrl}${relPath}`;
};

// Helper: try to extract userId and plan from JWT without throwing
const getOptionalUser = async (request: FastifyRequest): Promise<{ userId: string; userPlan: string } | null> => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const server = request.server as any;
    const decoded = server.jwt.verify(authHeader.slice(7)) as any;
    if (!decoded?.id) return null;

    const userId = decoded.id;
    const liveSub = await SubscriptionModel.findOne({
      userId,
      status: 'active',
      $or: [{ endDate: { $gte: new Date() } }, { endDate: null }, { endDate: { $exists: false } }],
    })
      .sort({ endDate: -1 })
      .lean();

    if (liveSub) {
      const livePlan = normalizePlanKey(liveSub.plan);
      // Free-tier subscription rows must not unlock content
      if (livePlan !== 'free') return { userId, userPlan: livePlan };
    }

    const user = await UserModel.findById(userId)
      .select('subscriptionPlan subscriptionStatus subscriptionExpiry')
      .lean();
    if (!user) return { userId, userPlan: 'free' };

    const plan = normalizePlanKey(user.subscriptionPlan);
    const isActive =
      user.subscriptionStatus === 'active' &&
      plan !== 'free' &&
      (!user.subscriptionExpiry || user.subscriptionExpiry > new Date());
    // subscriptionPlan "free" (or inactive) → always free for lock checks
    return { userId, userPlan: isActive ? plan : 'free' };
  } catch {
    return null;
  }
};

// ── GET /api/app/movies/:id ────────────────────────────────────────────────────
// Mobile movie detail page — returns all info needed to render the detail screen
// Optional auth: isLikedByUser and isWishlisted are false for guests
export const getMovieDetail = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, message: 'Invalid movie ID.' });
    }

    const userInfo = await getOptionalUser(request);
    const userId = userInfo?.userId || null;
    const userPlan = userInfo?.userPlan || 'free';

    // ── 1. Fetch Movie with populated cast/crew/genres ────────────────────────
    const movie = await MovieModel.findById(id)
      .populate('cast.actor', 'name image designation')
      .populate('crew.director', 'name image designation')
      .populate('genres', 'name')
      .populate('languages', 'name')
      .lean();

    if (!movie || movie.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Movie not found.' });
    }

    // ── 2. User-specific flags (like + wishlist + watch progress + download) ───
    let isLikedByUser = false;
    let isWishlisted = false;
    let wishlisted = false;
    let watchProgress = null;
    let downloaded = false;
    let isDownloaded = false;

    if (userId) {
      // Cast userId string to ObjectId for accurate DB lookups
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const [likeDoc, wishlistDoc, progressDoc, downloadDoc] = await Promise.all([
        UserLikeModel.findOne({ userId: userObjectId, contentId: movie._id }).lean(),
        UserWishlistModel.findOne({ userId: userObjectId, contentId: movie._id }).lean(),
        UserWatchProgressModel.findOne({ userId: userObjectId, contentId: movie._id }).lean(),
        UserDownloadModel.findOne({ userId: userObjectId, contentId: movie._id }).lean(),
      ]);
      isLikedByUser = !!likeDoc;
      isWishlisted = !!wishlistDoc;
      wishlisted = !!wishlistDoc;
      downloaded = !!downloadDoc;
      isDownloaded = !!downloadDoc;
      if (progressDoc) {
        watchProgress = {
          progressSeconds: progressDoc.progressSeconds,
          durationSeconds: progressDoc.durationSeconds,
          progressPercent: progressDoc.progressPercent,
          lastWatchedAt: progressDoc.lastWatchedAt,
        };
      }
    }

    // ── 3. Related Movies (same genre, limit 10) ──────────────────────────────
    let related: any[] = [];
    if (movie.genres && movie.genres.length > 0) {
      const genreIds = (movie.genres as any[]).map((g: any) => g._id || g);
      const relatedMovies = await MovieModel.find({
        _id: { $ne: movie._id },
        status: 'published',
        genres: { $in: genreIds },
      })
        .select('title thumbnail bannerImage duration year rating genres')
        .populate('genres', 'name')
        .limit(10)
        .lean();

      related = relatedMovies.map((r: any) => ({
        id: r._id.toString(),
        title: r.title,
        thumbnail: toAbsoluteUrl(request, r.thumbnail) || null,
        bannerImage: toAbsoluteUrl(request, r.bannerImage) || null,
        duration: r.duration || null,
        year: r.year || null,
        rating: r.rating || null,
        genres: (r.genres || []).map((g: any) => g?.name || g),
        type: 'movie',
      }));
    }

    // ── 4. Map cast & crew cleanly ────────────────────────────────────────────
    const cast = (movie.cast || []).map((c: any) => ({
      id: c.actor?._id?.toString() || null,
      name: c.actor?.name || 'Unknown',
      image: toAbsoluteUrl(request, c.actor?.image) || null,
      designation: c.actor?.designation || null,
      role: c.role || 'Actor',
      character: c.character || null,
    }));

    const crew = (movie.crew || []).map((c: any) => ({
      id: c.director?._id?.toString() || null,
      name: c.director?.name || 'Unknown',
      image: toAbsoluteUrl(request, c.director?.image) || null,
      designation: c.director?.designation || null,
      role: c.role || 'Director',
    }));

    // ── 5. Format duration ────────────────────────────────────────────────────
    const hours = movie.duration ? Math.floor(movie.duration / 3600) : 0;
    const minutes = movie.duration ? Math.floor((movie.duration % 3600) / 60) : 0;
    const durationFormatted = movie.duration
      ? hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
      : null;

    // ── 6. Video settings (quality options) ──────────────────────────────────
    // Prefer HLS master playlist for app playback
    const candidates = [movie.hlsUrl, movie.videoUrl, movie.sourceVideoUrl].filter(
      (u: any) => typeof u === 'string' && u.trim() && !String(u).startsWith('blob:')
    ) as string[];
    const hlsUrl =
      candidates.find((u) => /\.m3u8(\?|#|$)/i.test(u)) ||
      candidates[0] ||
      null;
    const qualities: any[] = movie.videoQualities || [];
    const isHlsReady = !!(hlsUrl && /\.m3u8(\?|#|$)/i.test(hlsUrl)) || qualities.length > 0;

    // Sort qualities in the correct playback order (144p → 4K)
    const QUALITY_ORDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];
    const sortedQualities = [...qualities].sort(
      (a, b) => QUALITY_ORDER.indexOf(a.quality) - QUALITY_ORDER.indexOf(b.quality)
    );

    const planRequired = normalizePlan(movie.planRequired);
    // Free / unsubscribed users → locked. Only an active paid plan unlocks.
    const contentLocked = normalizePlanKey(userPlan) === 'free';

    const videoSettings = hlsUrl
      ? [
          {
            key: 'auto',
            label: 'Auto',
            description: 'Adjusts quality automatically based on your connection',
            url: toAbsoluteUrl(request, hlsUrl),
            requiresPlan: 'standard',
            isLocked: contentLocked,
          },
          ...sortedQualities.map((q: any) => {
            const sizeMB = q.size ? `${Math.round(q.size / (1024 * 1024))} MB` : null;
            const label = QUALITY_LABELS[q.quality] || q.quality;
            const requiredPlan = QUALITY_PLAN_GATE[q.quality] || 'free';
            // Always mirror content lock for free users (app may check quality rows)
            const isLocked = contentLocked || isPlanLocked(userPlan, requiredPlan);
            const description = q.quality === '144p' ? 'Very low quality — for slow connections' :
                                q.quality === '240p' ? 'Low quality — saves data' :
                                q.quality === '360p' ? 'Low quality' :
                                q.quality === '480p' ? 'Standard definition' :
                                q.quality === '720p' ? 'High definition' :
                                q.quality === '1080p' ? 'Full HD — recommended' :
                                q.quality === '1440p' ? '2K — requires fast connection' :
                                q.quality === '2160p' ? '4K Ultra HD — requires very fast connection' :
                                `Stream at ${label}`;
            return {
              key: q.quality,
              label,
              description: sizeMB ? `${description} (${sizeMB})` : description,
              url: toAbsoluteUrl(request, q.url),
              requiresPlan: requiredPlan,
              isLocked,
            };
          })
        ]
      : null;

    // ── 7. Build response ─────────────────────────────────────────────────────
    const genreNames = (movie.genres as any[]).map((g: any) => g?.name || g);
    const languageNames = (movie.languages as any[]).map((l: any) => l?.name || l);

    return reply.send({
      success: true,
      data: {
        id: movie._id.toString(),
        title: movie.title,
        originalTitle: movie.originalTitle || null,
        description: movie.description || null,
        shortDescription: movie.shortDescription || null,
        thumbnail: toAbsoluteUrl(request, movie.thumbnail) || null,
        bannerImage: toAbsoluteUrl(request, movie.bannerImage) || null,
        posterImage: toAbsoluteUrl(request, movie.posterImage) || null,
        trailerUrl: toAbsoluteUrl(request, movie.trailerUrl) || null,
        type: 'movie',

        // Video
        hlsUrl: toAbsoluteUrl(request, hlsUrl),
        isHlsReady,
        processingStatus: (movie as any).processingStatus || (isHlsReady ? 'ready' : 'queued'),
        videoSettings,
        playbackSpeeds: [
          { value: 0.75, label: '0.75x' },
          { value: 1.0, label: 'Normal' },
          { value: 1.25, label: '1.25x' },
          { value: 1.5, label: '1.5x' },
          { value: 1.75, label: '1.75x' },
          { value: 2.0, label: '2.0x' }
        ],
        isLocked: contentLocked,

        // Meta
        genres: genreNames,
        genresText: genreNames.join(' & '),
        languages: languageNames,
        year: movie.year || null,
        rating: movie.rating || null,
        ageRating: movie.ageRating || 0,
        duration: movie.duration || null,
        durationFormatted,
        episodeMeta: `HD • ${genreNames.join(', ')} • ${durationFormatted || 'N/A'}`,
        imdbRating: movie.imdbRating || null,
        planRequired: planRequired === 'free' ? 'standard' : planRequired,
        isExclusive: movie.isExclusive || false,
        featured: movie.featured || false,
        trending: movie.trending || false,
        releaseDate: movie.releaseDate || null,
        country: movie.country || null,
        studio: movie.studio || null,

        // Stats
        views: movie.views || 0,
        likeCount: movie.likes || 0,
        shares: movie.shares || 0,

        // User flags
        isLikedByUser,
        isWishlisted,
        wishlisted,
        watchProgress,
        downloaded,
        isDownloaded,

        // Share
        shareUrl: buildShareUrl(movie._id.toString()),

        // People
        cast,
        crew,

        // Related
        related,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting movie detail');
    return reply.status(500).send({ success: false, message: 'Failed to fetch movie detail.', error: error.message });
  }
};
