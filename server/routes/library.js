import { Router } from 'express';

export function createLibraryRouter(controller) {
  const router = Router();
  router.get('/', controller.overview);
  router.get('/folders', controller.folders);
  router.get('/folders/:id', controller.folder);
  router.patch('/folders/:id/classification', controller.classifyFolder);
  router.get('/series', controller.series);
  router.get('/series/:id/seasons/:season', controller.season);
  router.get('/series/:id', controller.seriesDetail);
  router.get('/collections', controller.collections);
  router.post('/collections', controller.createCollection);
  router.put('/collections/:id', controller.updateCollection);
  router.delete('/collections/:id', controller.deleteCollection);
  router.put('/progress/:id', controller.progress);
  return router;
}
