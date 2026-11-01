import { getSeriesMetadata, getSeriesSeasonMetadata } from '../services/metadata.js';
import { buildCatalog, makeCustomCollectionId, validClassification } from '../services/catalog.js';
import { publicMovie } from '../services/library.js';

const MAX_COLLECTION_NAME = 100;
const MAX_COLLECTION_DESCRIPTION = 1000;

function isValidArtworkUrl(value) {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !/["'<>\\\u0000-\u001f]/.test(value);
  } catch {
    return false;
  }
}

function cleanCollectionInput(body, catalog, previous = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : previous.name;
  const description = typeof body.description === 'string' ? body.description.trim() : previous.description ?? '';
  const artworkUrl = body.artworkUrl === undefined ? previous.artworkUrl ?? null : body.artworkUrl || null;
  const movieIds = body.movieIds === undefined ? previous.movieIds ?? [] : body.movieIds;
  if (!name || name.length > MAX_COLLECTION_NAME) {
    return { error: `Collection name must be between 1 and ${MAX_COLLECTION_NAME} characters.` };
  }
  if (typeof description !== 'string' || description.length > MAX_COLLECTION_DESCRIPTION) {
    return { error: `Collection description must not exceed ${MAX_COLLECTION_DESCRIPTION} characters.` };
  }
  if (!isValidArtworkUrl(artworkUrl)) return { error: 'Artwork must be an HTTPS URL.' };
  if (!Array.isArray(movieIds) || movieIds.some((id) => typeof id !== 'string' || !catalog.movies.some((movie) => movie.id === id))) {
    return { error: 'Collections can only contain movies in the scanned library.' };
  }
  return { value: { name, description, artworkUrl, movieIds: [...new Set(movieIds)] } };
}

export function createLibraryController({ movieController, stateStore, tmdbApiKey = '' }) {
  let cachedCatalog = null;

  async function getCatalog() {
    const scan = await movieController.getScan();
    const stateVersion = stateStore.getVersion();
    if (cachedCatalog?.scan === scan && cachedCatalog.stateVersion === stateVersion) {
      return cachedCatalog;
    }
    const state = await stateStore.read();
    cachedCatalog = {
      scan,
      state,
      catalog: buildCatalog(scan, state),
      stateVersion,
    };
    return cachedCatalog;
  }

  return {
    async overview(_req, res, next) {
      try {
        const { catalog, state } = await getCatalog();
        res.json({
          root: catalog.rootFolder,
          folders: catalog.getFolderContents(catalog.rootFolder.id)?.children ?? [],
          movies: catalog.movies.map((movie) => ({ ...publicMovie(movie), isEpisode: false })),
          series: catalog.series,
          collections: catalog.collections,
          watchProgress: state.watchProgress,
          scannedAt: movieController.getScannedAt(),
          counts: {
            movies: catalog.movies.length,
            series: catalog.series.length,
            collections: catalog.collections.length,
            folders: catalog.folders.length,
          },
        });
      } catch (error) {
        next(error);
      }
    },
    async folders(_req, res, next) {
      try {
        const { catalog } = await getCatalog();
        const contents = catalog.getFolderContents(catalog.rootFolder.id);
        res.json({ folder: contents });
      } catch (error) {
        next(error);
      }
    },
    async folder(req, res, next) {
      try {
        const { catalog } = await getCatalog();
        const contents = catalog.getFolderContents(req.params.id);
        if (!contents || !catalog.validateFolderPath(req.params.id)) {
          return res.status(404).json({ error: 'Folder not found.' });
        }
        res.json({ folder: contents });
      } catch (error) {
        next(error);
      }
    },
    async classifyFolder(req, res, next) {
      try {
        const { catalog } = await getCatalog();
        if (!catalog.folderById.has(req.params.id)) return res.status(404).json({ error: 'Folder not found.' });
        const { type: requestedType, artworkUrl } = req.body ?? {};
        const type = requestedType === 'folder' ? 'normal' : requestedType;
        if (!validClassification(type)) {
          return res.status(400).json({ error: 'Classification must be series, collection, normal, or excluded.' });
        }
        if (artworkUrl !== undefined && !isValidArtworkUrl(artworkUrl)) {
          return res.status(400).json({ error: 'Artwork must be an HTTPS URL.' });
        }
        if (req.params.id === catalog.rootFolder.id) {
          return res.status(400).json({ error: 'The library root cannot be classified.' });
        }
        const response = await stateStore.update((state) => {
          state.folderOverrides[req.params.id] = {
            ...state.folderOverrides[req.params.id],
            type,
            ...(artworkUrl !== undefined ? { artworkUrl: artworkUrl || null } : {}),
            updatedAt: new Date().toISOString(),
          };
          return state.folderOverrides[req.params.id];
        });
        res.json({
          folderId: req.params.id,
          classification: response.type === 'normal' ? 'folder' : response.type,
          artworkUrl: response.artworkUrl ?? null,
        });
      } catch (error) {
        next(error);
      }
    },
    async series(_req, res, next) {
      try {
        const { catalog } = await getCatalog();
        res.json({ series: catalog.series.map(({ seasons, ...series }) => series), count: catalog.series.length });
      } catch (error) {
        next(error);
      }
    },
    async seriesDetail(req, res, next) {
      try {
        const { catalog } = await getCatalog();
        const series = catalog.seriesById.get(req.params.id);
        if (!series) return res.status(404).json({ error: 'Series not found.' });
        let metadata = null;
        let metadataError = null;
        if (tmdbApiKey) {
          try {
            metadata = await getSeriesMetadata(series.title, tmdbApiKey);
          } catch (error) {
            console.warn(`Optional series metadata is unavailable: ${error.message}`);
            metadataError = 'Online series details are temporarily unavailable.';
          }
        }
        res.json({ series: { ...series, metadata, metadataError } });
      } catch (error) {
        next(error);
      }
    },
    async season(req, res, next) {
      try {
        const { catalog } = await getCatalog();
        const series = catalog.seriesById.get(req.params.id);
        const seasonNumber = Number(req.params.season);
        const season = series?.seasons.find((item) => item.number === seasonNumber);
        if (!season) return res.status(404).json({ error: 'Season not found.' });
        let metadata = null;
        let metadataError = null;
        if (tmdbApiKey) {
          try {
            metadata = await getSeriesSeasonMetadata(series.title, seasonNumber, tmdbApiKey);
          } catch (error) {
            console.warn(`Optional episode metadata is unavailable: ${error.message}`);
            metadataError = 'Online episode titles are temporarily unavailable.';
          }
        }
        const metadataByNumber = new Map((metadata ?? []).map((episode) => [episode.episodeNumber, episode]));
        res.json({
          seriesId: series.id,
          metadataError,
          season: {
            ...season,
            episodes: season.episodes.map((episode) => ({
              ...episode,
              ...metadataByNumber.get(episode.episodeNumber),
              title: episode.title,
              metadataTitle: metadataByNumber.get(episode.episodeNumber)?.title ?? null,
            })),
          },
        });
      } catch (error) {
        next(error);
      }
    },
    async collections(_req, res, next) {
      try {
        const { catalog } = await getCatalog();
        res.json({ collections: catalog.collections, count: catalog.collections.length });
      } catch (error) {
        next(error);
      }
    },
    async createCollection(req, res, next) {
      try {
        const { catalog } = await getCatalog();
        const input = cleanCollectionInput(req.body ?? {}, catalog);
        if (input.error) return res.status(400).json({ error: input.error });
        const collection = {
          id: makeCustomCollectionId(),
          ...input.value,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await stateStore.update((state) => {
          state.customCollections.push(collection);
        });
        res.status(201).json({
          collection: {
            ...collection,
            type: 'custom',
            movies: input.value.movieIds.map((id) => publicMovie(catalog.movieById.get(id))),
          },
        });
      } catch (error) {
        next(error);
      }
    },
    async updateCollection(req, res, next) {
      try {
        const { catalog } = await getCatalog();
        const current = catalog.state.customCollections.find((collection) => collection.id === req.params.id);
        if (!current) return res.status(404).json({ error: 'Custom collection not found.' });
        const input = cleanCollectionInput(req.body ?? {}, catalog, current);
        if (input.error) return res.status(400).json({ error: input.error });
        const updated = await stateStore.update((state) => {
          const index = state.customCollections.findIndex((collection) => collection.id === req.params.id);
          state.customCollections[index] = { ...state.customCollections[index], ...input.value, updatedAt: new Date().toISOString() };
          return state.customCollections[index];
        });
        res.json({
          collection: {
            ...updated,
            type: 'custom',
            movies: updated.movieIds.map((id) => catalog.movieById.get(id)).filter(Boolean).map((movie) => publicMovie(movie)),
          },
        });
      } catch (error) {
        next(error);
      }
    },
    async deleteCollection(req, res, next) {
      try {
        const { catalog } = await getCatalog();
        if (!catalog.state.customCollections.some((collection) => collection.id === req.params.id)) {
          return res.status(404).json({ error: 'Custom collection not found.' });
        }
        await stateStore.update((state) => {
          state.customCollections = state.customCollections.filter((collection) => collection.id !== req.params.id);
        });
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
    async progress(req, res, next) {
      try {
        if (!await movieController.hasMovie(req.params.id)) {
          return res.status(404).json({ error: 'Movie or episode not found.' });
        }
        const { positionSeconds, durationSeconds } = req.body ?? {};
        if (!Number.isFinite(positionSeconds) || positionSeconds < 0
          || !Number.isFinite(durationSeconds) || durationSeconds <= 0
          || positionSeconds > durationSeconds + 5) {
          return res.status(400).json({ error: 'Playback position and duration must be valid non-negative seconds.' });
        }
        const progress = await stateStore.update((state) => {
          const completed = positionSeconds / durationSeconds >= 0.9;
          state.watchProgress[req.params.id] = {
            positionSeconds: Math.min(positionSeconds, durationSeconds),
            durationSeconds,
            completed,
            updatedAt: new Date().toISOString(),
          };
          return state.watchProgress[req.params.id];
        });
        res.json({ progress });
      } catch (error) {
        next(error);
      }
    },
  };
}
