function sendKnownError(error, res, next) {
  if (!Number.isInteger(error.status) || error.status < 400 || error.status > 499) {
    next(error);
    return;
  }
  res.status(error.status).json({
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createOrganizerController(organizerService) {
  return {
    overview(_req, res) {
      res.json(organizerService.getOverview());
    },

    async scan(_req, res, next) {
      const cancellation = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) cancellation.abort();
      });
      try {
        const summary = await organizerService.startScan({ signal: cancellation.signal });
        res.status(201).json(summary);
      } catch (error) {
        sendKnownError(error, res, next);
      }
    },

    scanDetail(req, res, next) {
      try {
        res.json(organizerService.getScan(req.params.scanId, req.query));
      } catch (error) {
        sendKnownError(error, res, next);
      }
    },

    async importInventory(req, res, next) {
      try {
        const summary = await organizerService.importInventory({
          scanId: req.query.scanId,
          filename: req.query.filename,
          contentType: (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
          buffer: req.body,
        });
        res.status(200).json(summary);
      } catch (error) {
        sendKnownError(error, res, next);
      }
    },

    proposals(req, res, next) {
      try {
        res.json(organizerService.getProposals({
          scanId: req.query.scanId,
          offset: req.query.offset,
          limit: req.query.limit,
        }));
      } catch (error) {
        sendKnownError(error, res, next);
      }
    },

    async updateItem(req, res, next) {
      try {
        if (!isPlainObject(req.body)
          || Object.keys(req.body).some((key) => !['classification', 'title'].includes(key))) {
          return res.status(400).json({ error: 'Provide only classification and optional title fields.' });
        }
        res.json(await organizerService.updateItem({
          scanId: req.params.scanId,
          itemId: req.params.itemId,
          ...req.body,
        }));
      } catch (error) {
        sendKnownError(error, res, next);
      }
    },

    async updateProposal(req, res, next) {
      try {
        if (!isPlainObject(req.body)
          || Object.keys(req.body).some((key) => !['reviewStatus', 'note'].includes(key))) {
          return res.status(400).json({ error: 'Provide only reviewStatus and optional note fields.' });
        }
        res.json(await organizerService.updateProposal({
          id: req.params.id,
          ...req.body,
        }));
      } catch (error) {
        sendKnownError(error, res, next);
      }
    },
  };
}
