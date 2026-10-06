import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { logger } from '../lib/logger';
import { syncTVShowTotalSeasons } from '../lib/seasonStats';
import { EpisodeModel } from '../models/Episode';
import { SeasonModel } from '../models/Season';
import { TVShowModel } from '../models/TVShow';

const SEASON_POPULATE = 'title thumbnail posterImage releaseDate year status';
const SEASON_STATUSES = ['published', 'draft'];

type SeasonInput = {
  tvShowId: Types.ObjectId;
  seasonNumber: number;
  title: string;
  description?: string;
  poster?: string;
  posterImage?: string;
  releaseDate?: Date | null;
  status?: 'published' | 'draft';
};

type SeasonValidation = { ok: true; data: SeasonInput } | { ok: false; error: string };

const validateSeasonBody = (body: unknown) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'A Season request body is required' } as const;
  }

  const value = body as Record<string, unknown>;
  if (typeof value.tvShowId !== 'string' || !Types.ObjectId.isValid(value.tvShowId)) {
    return { ok: false, error: 'A valid tvShowId is required' } as const;
  }

  const seasonNumber = Number(value.seasonNumber);
  if (!Number.isInteger(seasonNumber) || seasonNumber < 1) {
    return { ok: false, error: 'seasonNumber must be an integer greater than or equal to 1' } as const;
  }

  if (typeof value.title !== 'string' || !value.title.trim()) {
    return { ok: false, error: 'title is required' } as const;
  }

  if (value.description !== undefined && value.description !== null && typeof value.description !== 'string') {
    return { ok: false, error: 'description must be a string' } as const;
  }
  if (value.poster !== undefined && value.poster !== null && typeof value.poster !== 'string') {
    return { ok: false, error: 'poster must be a string' } as const;
  }
  if (value.posterImage !== undefined && value.posterImage !== null && typeof value.posterImage !== 'string') {
    return { ok: false, error: 'posterImage must be a string' } as const;
  }
  if (value.status !== undefined && !SEASON_STATUSES.includes(String(value.status))) {
    return { ok: false, error: 'status must be either published or draft' } as const;
  }

  let releaseDate: Date | null | undefined;
  if (value.releaseDate === null || value.releaseDate === '') {
    releaseDate = null;
  } else if (value.releaseDate !== undefined) {
    releaseDate = new Date(String(value.releaseDate));
    if (Number.isNaN(releaseDate.getTime())) {
      return { ok: false, error: 'releaseDate must be a valid date' } as const;
    }
  }

  return {
    ok: true as const,
    data: {
      tvShowId: new Types.ObjectId(value.tvShowId),
      seasonNumber,
      title: value.title.trim(),
      description: typeof value.description === 'string' ? value.description.trim() : undefined,
      poster: typeof value.poster === 'string' ? value.poster : undefined,
      posterImage: typeof value.posterImage === 'string' ? value.posterImage : undefined,
      releaseDate,
      status: typeof value.status === 'string' ? value.status as 'published' | 'draft' : undefined,
    },
  } satisfies SeasonValidation;
};

const formatSeason = (season: any, episodeCount: number) => {
  const show = season.tvShowId && typeof season.tvShowId === 'object' ? season.tvShowId : null;
  const id = season._id?.toString() || season.id?.toString();
  const showId = show?._id?.toString() || season.tvShowId?.toString();
  return {
    ...season,
    id,
    seasonId: `${showId}-${season.seasonNumber}`,
    season: season.seasonNumber,
    showName: show?.title || '',
    thumbnail: season.posterImage || season.poster || show?.thumbnail || '',
    episodeCount,
  };
};

const getEpisodeCount = async (tvShowId: unknown, seasonNumber: number) => {
  return EpisodeModel.countDocuments({ tvShowId, season: seasonNumber });
};

export const getSeasons = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { tvShowId?: string };
    const filter: Record<string, unknown> = {};
    if (query.tvShowId) {
      if (!Types.ObjectId.isValid(query.tvShowId)) {
        return reply.status(400).send({ success: false, error: 'tvShowId must be a valid ObjectId' });
      }
      filter.tvShowId = new Types.ObjectId(query.tvShowId);
    }

    const seasons = await SeasonModel.find(filter)
      .populate('tvShowId', SEASON_POPULATE)
      .sort({ tvShowId: 1, seasonNumber: 1 })
      .lean();

    const episodeGroups = seasons.length
      ? await EpisodeModel.aggregate([
          { $match: { tvShowId: { $in: seasons.map((season: any) => season.tvShowId?._id) } } },
          {
            $group: {
              _id: { tvShowId: '$tvShowId', season: '$season' },
              episodeCount: { $sum: 1 },
            },
          },
        ])
      : [];
    const episodeCounts = new Map(
      episodeGroups.map((group: any) => [`${group._id.tvShowId}:${group._id.season}`, group.episodeCount])
    );

    const data = seasons.map((season: any) => {
      const showId = season.tvShowId?._id || season.tvShowId;
      const key = `${showId}:${season.seasonNumber}`;
      return formatSeason(season, episodeCounts.get(key) || 0);
    });

    return reply.send({ success: true, data, total: data.length });
  } catch (error: any) {
    logger.error({ error }, 'Error getting seasons');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createSeason = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const validated = validateSeasonBody(request.body);
    if (!validated.ok) {
      return reply.status(400).send({ success: false, error: validated.error });
    }

    const showExists = await TVShowModel.exists({ _id: validated.data.tvShowId });
    if (!showExists) {
      return reply.status(404).send({ success: false, error: 'TV Show not found' });
    }

    const season = await SeasonModel.create(validated.data);
    await syncTVShowTotalSeasons(season.tvShowId);
    const savedSeason = await SeasonModel.findById(season._id).populate('tvShowId', SEASON_POPULATE).lean();
    const episodeCount = await getEpisodeCount(season.tvShowId, season.seasonNumber);

    return reply.status(201).send({ success: true, data: formatSeason(savedSeason, episodeCount) });
  } catch (error: any) {
    logger.error({ error }, 'Error creating season');
    if (error?.code === 11000) {
      return reply.status(409).send({ success: false, error: 'This TV Show already has that season number' });
    }
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return reply.status(400).send({ success: false, error: error.message });
    }
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateSeason = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Season id must be a valid ObjectId' });
    }

    const validated = validateSeasonBody(request.body);
    if (!validated.ok) {
      return reply.status(400).send({ success: false, error: validated.error });
    }

    const showExists = await TVShowModel.exists({ _id: validated.data.tvShowId });
    if (!showExists) {
      return reply.status(404).send({ success: false, error: 'TV Show not found' });
    }

    const existingSeason = await SeasonModel.findById(id).lean();
    if (!existingSeason) {
      return reply.status(404).send({ success: false, error: 'Season not found' });
    }

    const season = await SeasonModel.findByIdAndUpdate(id, { $set: validated.data }, { new: true, runValidators: true })
      .populate('tvShowId', SEASON_POPULATE)
      .lean();
    await syncTVShowTotalSeasons(existingSeason.tvShowId);
    if (season?.tvShowId) await syncTVShowTotalSeasons((season.tvShowId as any)._id || season.tvShowId as any);

    return reply.send({
      success: true,
      data: formatSeason(season, await getEpisodeCount((season?.tvShowId as any)?._id || season?.tvShowId, season?.seasonNumber || 0)),
    });
  } catch (error: any) {
    logger.error({ error }, 'Error updating season');
    if (error?.code === 11000) {
      return reply.status(409).send({ success: false, error: 'This TV Show already has that season number' });
    }
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return reply.status(400).send({ success: false, error: error.message });
    }
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteSeason = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Season id must be a valid ObjectId' });
    }

    const season = await SeasonModel.findById(id).lean();
    if (!season) {
      return reply.status(404).send({ success: false, error: 'Season not found' });
    }

    const hasEpisodes = await EpisodeModel.exists({ tvShowId: season.tvShowId, season: season.seasonNumber });
    if (hasEpisodes) {
      return reply.status(409).send({ success: false, error: "Delete this season's episodes before deleting the season" });
    }

    await SeasonModel.deleteOne({ _id: id });
    await syncTVShowTotalSeasons(season.tvShowId);
    return reply.send({ success: true, message: 'Season deleted successfully' });
  } catch (error: any) {
    logger.error({ error }, 'Error deleting season');
    return reply.status(500).send({ success: false, error: error.message });
  }
};