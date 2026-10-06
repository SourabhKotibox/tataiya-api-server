import { Types } from 'mongoose';
import { EpisodeModel } from '../models/Episode';
import { SeasonModel } from '../models/Season';
import { TVShowModel } from '../models/TVShow';
import { logger } from './logger';

export const syncTVShowTotalSeasons = async (tvShowId?: Types.ObjectId | string | null) => {
  if (!tvShowId) return;

  try {
    const showObjectId = typeof tvShowId === 'string' ? new Types.ObjectId(tvShowId) : tvShowId;
    const [seasonNumbers, episodeSeasons] = await Promise.all([
      SeasonModel.distinct('seasonNumber', { tvShowId: showObjectId }),
      EpisodeModel.distinct('season', { tvShowId: showObjectId }),
    ]);
    const totalSeasons = new Set([...seasonNumbers, ...episodeSeasons]).size;
    await TVShowModel.findByIdAndUpdate(showObjectId, { $set: { totalSeasons } });
  } catch (err) {
    logger.error({ err, tvShowId }, 'Failed to sync TVShow totalSeasons');
  }
};