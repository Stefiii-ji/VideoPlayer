import { Router } from 'express';

export function createMovieRouter(controller) {
  const router = Router();
  router.get('/', controller.list);
  router.post('/refresh', controller.refresh);
  router.post('/:id/playback', controller.playback);
  router.get('/:id/subtitles', controller.subtitles);
  router.get('/:id/subtitles/:subtitleId.vtt', controller.subtitle);
  router.get('/:id/playback-sessions/:sessionId', controller.playbackSessionStatus);
  router.get('/:id/playback-sessions/:sessionId/:filename', controller.playbackAsset);
  router.delete('/:id/playback-sessions/:sessionId', controller.stopPlayback);
  router.get('/:id/stream', controller.stream);
  router.get('/:id/metadata', controller.metadata);
  router.get('/:id', controller.detail);
  router.get('/:id/transcode', controller.transcode);
  return router;
}
