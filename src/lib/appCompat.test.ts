import assert from 'node:assert/strict';
import test from 'node:test';
import { describePlanPeriod } from './planPeriod';
import {
  contentIsSeries,
  extractStorageKey,
  resolveContentPlayback,
  resolveStoredMediaUrl,
} from './bannerPlayback';
import { ffmpegThreadCount, rememberBounded } from './spawnCapture';

const signDeps = {
  sign: async (key: string) => `https://signed.example/${key}?X-Amz-Signature=test`,
  publicUrl: async (key: string) => `https://cdn.example/${key}`,
  localFileUrl: () => null,
  absoluteLocal: () => null,
};

test('storage keys are not rewritten as /uploads paths', async () => {
  const relative = await resolveStoredMediaUrl(null, 'media/trailers/hero.mp4', signDeps);
  assert.equal(relative, 'https://signed.example/media/trailers/hero.mp4?X-Amz-Signature=test');

  const hostPrefixed = await resolveStoredMediaUrl(
    null,
    'https://tataiya.in/uploads/media/trailers/hero.mp4',
    signDeps
  );
  assert.equal(hostPrefixed, 'https://signed.example/media/trailers/hero.mp4?X-Amz-Signature=test');
  assert.equal(extractStorageKey('https://bucket.s3.amazonaws.com/hls/movies/1/master.m3u8'), 'hls/movies/1/master.m3u8');
});

test('HLS playlists use the public URL so relative segments stay reachable', async () => {
  const hls = await resolveStoredMediaUrl(null, 'hls/movies/abc/master.m3u8', signDeps);
  assert.equal(hls, 'https://cdn.example/hls/movies/abc/master.m3u8');
});

test('banner playback prefers a direct trailer, then episode, then the movie', async () => {
  const resolve = async (raw: string | null | undefined) => {
    if (!raw) return null;
    if (raw.startsWith('http')) return raw;
    return `https://cdn.example/${raw}`;
  };

  const withTrailer = await resolveContentPlayback(
    {
      contentTrailer: 'media/trailers/movie.mp4',
      contentVideos: ['hls/movies/1/master.m3u8'],
      isSeries: false,
    },
    resolve
  );
  assert.equal(withTrailer.videoUrl, 'https://cdn.example/media/trailers/movie.mp4');
  assert.equal(withTrailer.hlsUrl, withTrailer.videoUrl);
  assert.equal(withTrailer.trailerUrl, withTrailer.videoUrl);
  assert.equal(withTrailer.isTrailer, true);
  assert.equal(withTrailer.startSeconds, 0);

  const series = await resolveContentPlayback(
    {
      episodeTrailer: null,
      episodeVideos: ['media/episodes/ep1.mp4'],
      contentVideos: [],
      episodeDuration: 1200,
      isSeries: true,
    },
    resolve
  );
  assert.equal(series.videoUrl, 'https://cdn.example/media/episodes/ep1.mp4');
  assert.equal(series.isTrailer, false);
  assert.equal(series.isEpisodePreview, true);

  const movie = await resolveContentPlayback(
    {
      contentVideos: ['https://cdn.example/movies/full.mp4'],
      isSeries: false,
      contentDuration: 5400,
    },
    resolve
  );
  assert.equal(movie.playUrl, 'https://cdn.example/movies/full.mp4');
  assert.equal(movie.isTrailer, false);

  const youtube = await resolveContentPlayback(
    {
      contentTrailer: 'https://www.youtube.com/watch?v=abcdefghijk',
      contentVideos: ['media/movies/full.mp4'],
      isSeries: false,
    },
    resolve
  );
  assert.equal(youtube.videoUrl, 'https://cdn.example/media/movies/full.mp4');
});

test('series, tv shows and movies are distinguished from each other', () => {
  assert.equal(contentIsSeries({ contentType: 'series' }, { contentType: 'tvShow' }), true);
  assert.equal(contentIsSeries({ contentType: 'tvShow' }, { _type: 'show' }), true);
  assert.equal(contentIsSeries({ contentType: 'tvShow' }, { contentType: 'movie' }), false);
  assert.equal(contentIsSeries({ contentType: 'movie' }, { contentType: 'movie' }), false);
});

test('plan period labels are not monthly for every duration', () => {
  assert.equal(describePlanPeriod('Month', 1).duration, 'monthly');
  assert.equal(describePlanPeriod('Months', 3).duration, '3 months');
  assert.equal(describePlanPeriod('Months', 6).billingPeriod, '6 months');
  assert.equal(describePlanPeriod('Months', 12).duration, 'yearly');
  assert.equal(describePlanPeriod('Year', 1).period, 'yearly');
  assert.equal(describePlanPeriod('Week', 2).duration, '2 weeks');
  assert.equal(describePlanPeriod('Months', 6).durationValue, 6);
  assert.notEqual(describePlanPeriod('Months', 6).duration.toLowerCase(), 'monthly');
  assert.notEqual(describePlanPeriod('Months', 12).duration.toLowerCase(), 'monthly');
});

test('ffmpeg stderr capture stays bounded and threads default to one', () => {
  let text = '';
  for (let i = 0; i < 1000; i++) text = rememberBounded(text, 'x'.repeat(1000), 24 * 1024);
  assert.equal(text.length, 24 * 1024);
  const previous = process.env.FFMPEG_THREADS;
  delete process.env.FFMPEG_THREADS;
  assert.equal(ffmpegThreadCount(), '1');
  process.env.FFMPEG_THREADS = '4';
  assert.equal(ffmpegThreadCount(), '4');
  if (previous === undefined) delete process.env.FFMPEG_THREADS;
  else process.env.FFMPEG_THREADS = previous;
});
