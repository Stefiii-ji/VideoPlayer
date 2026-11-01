import { Router } from 'express';

export function createOrganizerRouter(controller) {
  const router = Router();
  router.get('/overview', controller.overview);
  router.post('/scan', controller.scan);
  router.get('/scan/:scanId', controller.scanDetail);
  router.patch('/scan/:scanId/items/:itemId', controller.updateItem);
  router.post('/import', controller.importInventory);
  router.get('/proposals', controller.proposals);
  router.patch('/proposals/:id', controller.updateProposal);
  return router;
}
