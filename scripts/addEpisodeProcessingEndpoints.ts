import fs from 'fs';
import path from 'path';

const controllerPath = path.resolve('src/controllers/episodeController.ts');
let content = fs.readFileSync(controllerPath, 'utf8');

const processingEndpoints = `
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
    
    if (!source || /\.m3u8(?:[?#]|$)/i.test(source)) {
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
`;

if (!content.includes('export const getEpisodeProcessingStatus')) {
  content += '\n' + processingEndpoints;
  fs.writeFileSync(controllerPath, content);
  console.log('Endpoints added to episodeController.ts');
} else {
  console.log('Endpoints already exist in episodeController.ts');
}

