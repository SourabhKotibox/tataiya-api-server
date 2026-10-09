import type { FastifyRequest, FastifyReply } from 'fastify';
import { EpisodeModel } from '../models/Episode';
import { SeasonModel } from '../models/Season';
import { TVShowModel } from '../models/TVShow';
import { Types } from 'mongoose';
import { logger } from '../lib/logger';
import { syncTVShowTotalSeasons } from '../lib/seasonStats';
import { isRawLocalVideo } from '../lib/contentResolver';

export const getAllEpisodes = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      tvShowId?: string;
      season?: string;
      contentType?: string;
      TVShowType?: string;
      search?: string;
    };

    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (query.tvShowId) {
      filter.tvShowId = query.tvShowId;
    } else {
      const typeFilter = query.contentType || query.TVShowType;
      if (typeFilter) {
        const normalizedType =
          typeFilter === 'drama' || typeFilter === 'series' || typeFilter === 'show'
            ? 'tvShow'
            : typeFilter;
        if (normalizedType === 'tvShow') {
          const tvShowIds = await TVShowModel.find({ contentType: 'tvShow' })
            .select('_id')
            .lean()
            .then((contents) => contents.map((c) => c._id));
          filter.tvShowId = { $in: tvShowIds };
        } else {
          filter.tvShowId = { $in: [] };
        }
      }
    }

    if (query.season) filter.season = Number(query.season);
    if (query.search) {
      filter.$or = [
        { title: new RegExp(query.search, 'i') },
        { description: new RegExp(query.search, 'i') },
      ];
    }

    const [episodes, total] = await Promise.all([
      EpisodeModel.find(filter)
        .populate('tvShowId', 'title thumbnail contentType')
        .populate('subtitleLanguages', 'name code')
        .populate('audioLanguages', 'name code')
        .populate('subtitles.language', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      EpisodeModel.countDocuments(filter),
    ]);

    const formatDuration = (seconds: number | undefined | null): string | null => {
      if (!seconds || seconds === 0) return null;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0 && s > 0) return `${m}m ${s}s`;
      return `${m}m`;
    };

    const data = episodes.map((e) => ({
      ...e,
      id: e._id?.toString(),
      showName: (e.tvShowId as any)?.title || '',
      showThumbnail: (e.tvShowId as any)?.thumbnail || '',
      durationFormatted: formatDuration(e.duration),
    }));

    return reply.send({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting all episodes');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getEpisodeById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    // Sync HLS qualities from disk if they exist but are missing in DB
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id, 'episode');
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities for episode');
    }

    const episode = await EpisodeModel.findById(id)
      .populate('tvShowId', 'title thumbnail contentType')
      .populate('subtitleLanguages', 'name code')
      .populate('audioLanguages', 'name code')
      .populate('subtitles.language', 'name code')
      .lean();

    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    const formatDuration = (seconds: number | undefined | null): string | null => {
      if (!seconds || seconds === 0) return null;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0 && s > 0) return `${m}m ${s}s`;
      return `${m}m`;
    };

    return reply.send({
      success: true,
      data: {
        ...episode,
        id: episode._id?.toString(),
        durationFormatted: formatDuration(episode.duration),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting episode by ID');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createEpisode = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as any;

    const submittedVideoUrl = String(body.sourceVideoUrl || body.videoFilePath || body.videoUrl || body.hlsUrl || '').trim();
    const isHlsPlaylist = /\.m3u8(?:[?#]|$)/i.test(submittedVideoUrl);
    const hlsUrl = String(body.hlsUrl || (body.videoUploadType === 'hls' || isHlsPlaylist ? submittedVideoUrl : '')).trim();
    const videoPath = hlsUrl ? '' : submittedVideoUrl;
    const shouldProcessHls = !!videoPath && !isHlsPlaylist &&
      (isRawLocalVideo(videoPath) || body.videoUploadType === 'local');
    if (hlsUrl) {
      body.hlsUrl = hlsUrl;
    } else if (videoPath) {
      body.sourceVideoUrl = videoPath;
      body.hlsUrl = undefined;
    }
    if (shouldProcessHls) {
      body.processingStatus = 'queued';
    } else {
      body.processingStatus = 'ready';
    }

    const episode = await EpisodeModel.create(body);

    // Automatically synchronize TVShow totalSeasons
    await syncTVShowTotalSeasons(episode.tvShowId);

    if (shouldProcessHls && videoPath) {
      import('../services/videoProcessor').then(({ processEpisodeInBackground }) => {
        processEpisodeInBackground(episode._id as Types.ObjectId, videoPath);
      }).catch(async (error) => {
        logger.error({ error, episodeId: episode._id }, 'Failed to load episode HLS processor');
        await EpisodeModel.findByIdAndUpdate(episode._id, {
          processingStatus: 'failed',
          processingError: error instanceof Error ? error.message : 'Failed to load episode HLS processor',
        });
      });
    }

    return reply.status(201).send({
      success: true,
      data: { ...episode.toObject(), id: episode._id?.toString() },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error creating episode');
    if (error?.code === 11000 || (error?.name === 'MongoServerError' && error?.code === 11000)) {
      const seasonVal = (request.body as any)?.season ?? '';
      const episodeVal = (request.body as any)?.episode ?? '';
      return reply.status(409).send({
        success: false,
        message: `An episode for Season ${seasonVal} Episode ${episodeVal} already exists for this TV Show.`,
        error: 'Duplicate episode: An episode with this season and episode number already exists for this TV Show.',
      });
    }
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateEpisode = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const existingEpisode = await EpisodeModel.findById(id).lean();
    if (!existingEpisode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    const hasVideoUpdate = ['sourceVideoUrl', 'videoFilePath', 'videoUrl', 'hlsUrl']
      .some((key) => Object.prototype.hasOwnProperty.call(body, key));
    let videoPath = '';
    let shouldProcessHls = false;
    if (hasVideoUpdate) {
      const submittedVideoUrl = String(body.sourceVideoUrl || body.videoFilePath || body.videoUrl || body.hlsUrl || '').trim();
      const isHlsPlaylist = /\.m3u8(?:[?#]|$)/i.test(submittedVideoUrl);
      const hlsUrl = String(body.hlsUrl || (body.videoUploadType === 'hls' || isHlsPlaylist ? submittedVideoUrl : '')).trim();
      videoPath = hlsUrl ? '' : submittedVideoUrl;
      const previousSource = String((existingEpisode as any).sourceVideoUrl || '');
      const previousHlsUrl = String((existingEpisode as any).hlsUrl || '');
      shouldProcessHls = !!videoPath && !isHlsPlaylist && videoPath !== previousSource &&
        (isRawLocalVideo(videoPath) || body.videoUploadType === 'local');

      if (hlsUrl) {
        body.hlsUrl = hlsUrl;
        if (hlsUrl !== previousHlsUrl) {
          body.sourceVideoUrl = null;
          body.videoQualities = [];
          body.processingStatus = 'ready';
        }
      } else if (videoPath) {
        body.sourceVideoUrl = videoPath;
        if (videoPath !== previousSource) {
          body.hlsUrl = null;
          body.videoQualities = [];
          body.processingStatus = shouldProcessHls ? 'queued' : 'ready';
        }
      } else {
        body.sourceVideoUrl = null;
        body.hlsUrl = null;
        body.videoQualities = [];
        body.processingStatus = 'ready';
      }
    }

    const episode = await EpisodeModel.findByIdAndUpdate(
      id,
      { $set: body },
      { new: true, runValidators: true }
    ).lean();

    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    // Automatically synchronize TVShow totalSeasons if season or show reference shifted
    if (existingEpisode.tvShowId) {
      await syncTVShowTotalSeasons(existingEpisode.tvShowId);
    }
    if (episode.tvShowId && episode.tvShowId.toString() !== existingEpisode.tvShowId?.toString()) {
      await syncTVShowTotalSeasons(episode.tvShowId);
    }

    if (shouldProcessHls && videoPath) {
      import('../services/videoProcessor').then(({ processEpisodeInBackground }) => {
        processEpisodeInBackground(new Types.ObjectId(id), videoPath);
      }).catch(async (error) => {
        logger.error({ error, episodeId: id }, 'Failed to load episode HLS processor');
        await EpisodeModel.findByIdAndUpdate(id, {
          processingStatus: 'failed',
          processingError: error instanceof Error ? error.message : 'Failed to load episode HLS processor',
        });
      });
    }

    // Sync HLS qualities from disk if they exist but were not submitted/saved properly in update form
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id, 'episode');
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities during episode update');
    }

    const updatedEpisode = await EpisodeModel.findById(id).lean();

    return reply.send({
      success: true,
      data: { ...updatedEpisode, id: updatedEpisode?._id?.toString() },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error updating episode');
    if (error?.code === 11000 || (error?.name === 'MongoServerError' && error?.code === 11000)) {
      return reply.status(409).send({
        success: false,
        message: 'Duplicate episode: An episode with this season and episode number already exists for this TV Show.',
        error: 'Duplicate episode: An episode with this season and episode number already exists for this TV Show.',
      });
    }
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteEpisode = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const episode = await EpisodeModel.findByIdAndDelete(id);
    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    // Automatically recalculate TVShow totalSeasons after deletion
    await syncTVShowTotalSeasons(episode.tvShowId);

    return reply.send({ success: true, message: 'Episode deleted successfully' });
  } catch (error: any) {
    logger.error({ error }, 'Error deleting episode');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const toggleEpisodeLock = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const { isLocked } = request.body as { isLocked: boolean };

    const episode = await EpisodeModel.findByIdAndUpdate(
      id,
      { $set: { isLocked } },
      { new: true }
    ).lean();

    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    return reply.send({ success: true, data: { ...episode, id: episode._id?.toString() } });
  } catch (error: any) {
    logger.error({ error }, 'Error toggling episode lock');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getSeasons = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      contentType?: string;
      TVShowType?: string;
      tvShowId?: string;
    };

    const matchFilter: any = {};
    if (query.tvShowId && Types.ObjectId.isValid(query.tvShowId)) {
      matchFilter.tvShowId = new Types.ObjectId(query.tvShowId);
    } else {
      const typeFilter = query.contentType || query.TVShowType;
      if (typeFilter) {
        const normalizedType =
          typeFilter === 'drama' || typeFilter === 'series' || typeFilter === 'show'
            ? 'tvShow'
            : typeFilter;
        if (normalizedType === 'tvShow') {
          const tvShowIds = await TVShowModel.find({ contentType: 'tvShow' })
            .select('_id')
            .lean()
            .then((contents) => contents.map((c) => c._id));
          matchFilter.tvShowId = { $in: tvShowIds };
        } else {
          matchFilter.tvShowId = { $in: [] };
        }
      }
    }

    const episodeSeasons = await EpisodeModel.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { tvShowId: '$tvShowId', season: '$season' },
          episodeCount: { $sum: 1 },
          thumbnail: { $first: '$thumbnail' },
        },
      },
      {
        $lookup: {
          from: TVShowModel.collection.name,
          localField: '_id.tvShowId',
          foreignField: '_id',
          as: 'content',
        },
      },
      { $unwind: { path: '$content', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          seasonId: {
            $concat: [{ $toString: '$_id.tvShowId' }, '-', { $toString: '$_id.season' }],
          },
          tvShowId: '$_id.tvShowId',
          season: '$_id.season',
          episodeCount: 1,
          showName: { $ifNull: ['$content.title', 'Unknown Series'] },
          thumbnail: { $ifNull: ['$content.thumbnail', '$thumbnail'] },
          status: { $ifNull: ['$content.status', 'draft'] },
        },
      },
      { $sort: { showName: 1, season: 1 } },
    ]);

    const savedSeasons = await SeasonModel.find(matchFilter)
      .populate('tvShowId', 'title thumbnail posterImage')
      .lean();
    const seasonMap = new Map<string, any>();
    for (const season of episodeSeasons) {
      seasonMap.set(`${season.tvShowId}-${season.season}`, season);
    }
    for (const season of savedSeasons as any[]) {
      const show = season.tvShowId;
      const showId = show?._id?.toString() || season.tvShowId?.toString();
      const key = `${showId}-${season.seasonNumber}`;
      const existing = seasonMap.get(key);
      seasonMap.set(key, {
        ...existing,
        _id: season._id,
        id: season._id?.toString(),
        seasonId: key,
        tvShowId: show,
        season: season.seasonNumber,
        title: season.title,
        description: season.description,
        poster: season.poster,
        posterImage: season.posterImage,
        releaseDate: season.releaseDate,
        episodeCount: existing?.episodeCount || 0,
        showName: show?.title || existing?.showName || 'Unknown Series',
        thumbnail: season.posterImage || season.poster || existing?.thumbnail || show?.thumbnail || '',
        status: season.status,
      });
    }

    const seasons = Array.from(seasonMap.values()).sort(
      (a, b) => a.showName.localeCompare(b.showName) || a.season - b.season
    );

    return reply.send({
      success: true,
      data: seasons,
      total: seasons.length,
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting seasons');
    return reply.status(500).send({ success: false, error: error.message });
  }
};


// Get episode HLS processing status
export const getEpisodeProcessingStatus = async (request: any, reply: any) => {
  try {
    const { id } = request.params as { id: string };

    const episode = await EpisodeModel.findById(id)
      .select('processingStatus processingError hlsUrl videoQualities status title')
      .lean();

    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    const qualities = (episode.videoQualities || []).map((q: any) => ({
      quality: q.quality,
      url:     q.url,
      size:    q.size,
    }));

    return reply.send({
      success: true,
      data: {
        title:            episode.title,
        status:           episode.status,
        processingStatus: episode.processingStatus || 'queued',
        processingError:  episode.processingError || null,
        hlsUrl:           episode.hlsUrl || null,
        availableQualities: qualities,
        qualityCount:     qualities.length,
        isReady:          episode.processingStatus === 'ready',
        isFailed:         episode.processingStatus === 'failed',
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting episode processing status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const reprocessEpisodeHls = async (request: any, reply: any) => {
  try {
    const { id } = request.params as { id: string };

    const episode = await EpisodeModel.findById(id).lean();
    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    const source = (episode as any).sourceVideoUrl || (episode as any).videoUrl || (episode as any).hlsUrl;
    
    if (!source || /.m3u8(?:[?#]|$)/i.test(source)) {
      return reply.status(400).send({
        success: false,
        error: 'Episode does not have a raw MP4 source video to transcode. Only MP4 videos can be processed into HLS.',
      });
    }

    await EpisodeModel.findByIdAndUpdate(id, {
      $set: {
        processingStatus: 'queued',
        processingError: null,
        sourceVideoUrl: source,
        videoUrl: source,
        hlsUrl: null,
        videoQualities: [],
      },
    });

    const { processEpisodeInBackground } = await import('../services/videoProcessor');
    processEpisodeInBackground(id, source);

    return reply.send({
      success: true,
      message: 'Episode HLS processing queued successfully',
      data: {
        id,
        title: episode.title,
        sourceVideoUrl: source,
        processingStatus: 'queued',
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error queueing episode HLS reprocess');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/**
 * POST /admin/episodes/backfill-durations
 * Scans all episodes with missing or zero duration and probes duration from
 * the source video using ffprobe — without triggering a full re-transcode.
 * Episodes that already have a non-zero duration are skipped.
 */
export const backfillEpisodeDurations = async (request: any, reply: any) => {
  try {
    // Find episodes with missing/zero duration that have a usable source
    const episodes = await EpisodeModel.find({
      $or: [{ duration: { $exists: false } }, { duration: 0 }, { duration: null }],
      $or: [
        { sourceVideoUrl: { $exists: true, $ne: null, $ne: '' } },
        { hlsUrl: { $exists: true, $ne: null, $ne: '' } },
      ],
    })
      .select('_id title sourceVideoUrl hlsUrl duration')
      .lean();

    const { probeDurationFromUrl } = await import('../services/videoProcessor');
    if (typeof probeDurationFromUrl !== 'function') {
      // Fallback: run inline probe
    }

    let updated = 0;
    let failed = 0;
    const results: any[] = [];

    for (const ep of episodes) {
      const source = (ep as any).sourceVideoUrl || '';
      if (!source || /.m3u8(?:[?#]|$)/i.test(source)) {
        failed++;
        results.push({ id: ep._id.toString(), title: ep.title, status: 'skipped', reason: 'No raw source video' });
        continue;
      }

      try {
        // Use ffprobe directly via the imported service
        const { probeVideoDuration } = await import('../services/videoProcessor');
        const duration = await probeVideoDuration(source);

        if (duration && duration > 0) {
          await EpisodeModel.findByIdAndUpdate(ep._id, { duration });
          updated++;
          results.push({ id: ep._id.toString(), title: ep.title, status: 'updated', duration });
        } else {
          failed++;
          results.push({ id: ep._id.toString(), title: ep.title, status: 'failed', reason: 'Could not detect duration' });
        }
      } catch (err: any) {
        failed++;
        results.push({ id: ep._id.toString(), title: ep.title, status: 'failed', reason: err.message });
      }
    }

    return reply.send({
      success: true,
      message: `Backfill complete. Updated: ${updated}, Failed/Skipped: ${failed}`,
      data: { total: episodes.length, updated, failed, results },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error backfilling episode durations');
    return reply.status(500).send({ success: false, error: error.message });
  }
};
