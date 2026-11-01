import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { libraryApi, movieApi } from '../services/api.js';

const LibraryContext = createContext(null);
const WATCH_KEY = 'moviestream-watch-progress';
const LIST_KEY = 'moviestream-my-list';
const METADATA_KEY = 'moviestream-metadata';
const METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const METADATA_FAILURE_RETRY_MS = 60 * 1000;
const MAX_METADATA_ENTRIES = 500;

function readProgress() {
  try {
    const stored = JSON.parse(localStorage.getItem(WATCH_KEY) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function readMetadataCache() {
  try {
    const stored = readStorage(METADATA_KEY, {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const now = Date.now();
    const entries = Object.entries(stored).flatMap(([id, entry]) => {
      if (entry && typeof entry === 'object'
        && !Array.isArray(entry)
        && Object.hasOwn(entry, 'value')
        && Number.isFinite(entry.updatedAt)) {
        return now - entry.updatedAt < METADATA_TTL_MS ? [[id, entry]] : [];
      }
      return [[id, { value: entry ?? null, updatedAt: now }]];
    });
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    return Object.fromEntries(entries.slice(0, MAX_METADATA_ENTRIES));
  } catch {
    return {};
  }
}

function isQuotaError(error) {
  return error?.name === 'QuotaExceededError'
    || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22
    || error?.code === 1014;
}

export function LibraryProvider({ children }) {
  const [movies, setMovies] = useState([]);
  const [series, setSeries] = useState([]);
  const [collections, setCollections] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scannedAt, setScannedAt] = useState(null);
  const [progress, setProgress] = useState(readProgress);
  const [metadataCache] = useState(readMetadataCache);
  const metadataCacheRef = useRef(metadataCache);
  const [myList, setMyList] = useState(() => {
    const stored = readStorage(LIST_KEY, []);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  });
  const [metadata, setMetadata] = useState(() => Object.fromEntries(
    Object.entries(metadataCache).map(([id, entry]) => [id, entry.value]),
  ));
  const lastProgressWrite = useRef(new Map());
  const lastServerProgressWrite = useRef(new Map());
  const metadataRequests = useRef(new Map());
  const metadataFailures = useRef(new Map());
  const metadataPersistenceDisabled = useRef(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      if (refresh) await movieApi.refresh();
      const result = await libraryApi.overview();
      setMovies(result.movies);
      setScannedAt(result.scannedAt);
      setSeries(result.series);
      setCollections(result.collections);
      setFolders(result.folders ?? []);
      const persistedProgress = Object.fromEntries(Object.entries(result.watchProgress ?? {}).map(([id, item]) => [
        id,
        item.completed
          ? null
          : {
            currentTime: item.positionSeconds,
            duration: item.durationSeconds,
            updatedAt: new Date(item.updatedAt).getTime(),
          },
      ]));
      setProgress((previous) => {
        const merged = { ...previous };
        for (const [id, serverEntry] of Object.entries(persistedProgress)) {
          const localUpdatedAt = Number.isFinite(previous[id]?.updatedAt) ? previous[id].updatedAt : 0;
          const serverUpdatedAt = new Date(result.watchProgress[id].updatedAt).getTime();
          if (Number.isFinite(serverUpdatedAt) && serverUpdatedAt > localUpdatedAt) {
            merged[id] = serverEntry;
          }
        }
        return merged;
      });
    } catch (cause) {
      setError(cause.message || 'The movie library could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  function handleStorageWriteError(key, cause) {
    console.warn(`Browser storage write failed for ${key}: ${cause.message}`);
    if (!isQuotaError(cause)) return;
    metadataPersistenceDisabled.current = true;
    metadataCacheRef.current = {};
    setMetadata({});
    try {
      localStorage.removeItem(METADATA_KEY);
    } catch (error) {
      console.warn(`Browser metadata cache could not be cleared: ${error.message}`);
    }
  }
  useEffect(() => {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(progress));
    } catch (cause) {
      handleStorageWriteError(WATCH_KEY, cause);
    }
  }, [progress]);
  useEffect(() => {
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify(myList));
    } catch (cause) {
      handleStorageWriteError(LIST_KEY, cause);
    }
  }, [myList]);
  useEffect(() => {
    if (metadataPersistenceDisabled.current) return;
    try {
      localStorage.setItem(METADATA_KEY, JSON.stringify(metadataCacheRef.current));
    } catch (cause) {
      handleStorageWriteError(METADATA_KEY, cause);
    }
  }, [metadata]);

  const toggleMyList = useCallback((movieId) => {
    setMyList((previous) => previous.includes(movieId)
      ? previous.filter((id) => id !== movieId)
      : [...previous, movieId]);
  }, []);

  const loadMetadata = useCallback((movieId) => {
    const cached = metadataCacheRef.current[movieId];
    if (cached && Date.now() - cached.updatedAt < METADATA_TTL_MS) return Promise.resolve(cached.value);
    if (cached) {
      delete metadataCacheRef.current[movieId];
      setMetadata((previous) => {
        const next = { ...previous };
        delete next[movieId];
        return next;
      });
    }
    const failedAt = metadataFailures.current.get(movieId);
    if (failedAt && Date.now() - failedAt < METADATA_FAILURE_RETRY_MS) return Promise.resolve(null);
    if (metadataRequests.current.has(movieId)) return metadataRequests.current.get(movieId);
    const request = movieApi.metadata(movieId)
      .then(({ metadata: result }) => {
        const entry = { value: result ?? null, updatedAt: Date.now() };
        metadataFailures.current.delete(movieId);
        metadataCacheRef.current = {
          ...metadataCacheRef.current,
          [movieId]: entry,
        };
        const oldestFirst = Object.entries(metadataCacheRef.current)
          .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        while (oldestFirst.length > MAX_METADATA_ENTRIES) {
          const [oldestId] = oldestFirst.shift();
          delete metadataCacheRef.current[oldestId];
        }
        setMetadata(Object.fromEntries(
          Object.entries(metadataCacheRef.current).map(([id, cacheEntry]) => [id, cacheEntry.value]),
        ));
        return entry.value;
      })
      .catch((cause) => {
        metadataFailures.current.set(movieId, Date.now());
        console.warn(`Optional movie metadata is unavailable: ${cause.message}`);
        return null;
      })
      .finally(() => metadataRequests.current.delete(movieId));
    metadataRequests.current.set(movieId, request);
    return request;
  }, []);

  const saveProgress = useCallback((movieId, currentTime, duration, force = false) => {
    if (!duration || currentTime < 10) return;
    const completed = currentTime / duration >= 0.9;
    const lastSaved = lastProgressWrite.current.get(movieId) ?? 0;
    if (!completed && !force && Math.abs(currentTime - lastSaved) < 5) return;
    lastProgressWrite.current.set(movieId, currentTime);
    setProgress((previous) => ({
      ...previous,
      [movieId]: completed
        ? null
        : { currentTime, duration, updatedAt: Date.now() },
    }));
    const lastServerSaved = lastServerProgressWrite.current.get(movieId) ?? 0;
    if (force || completed || Math.abs(currentTime - lastServerSaved) >= 30) {
      lastServerProgressWrite.current.set(movieId, currentTime);
      libraryApi.saveProgress(movieId, currentTime, duration).catch((cause) => {
        console.warn(`Playback progress could not be saved to the server: ${cause.message}`);
      });
    }
  }, []);

  const value = useMemo(() => ({
    movies, series, collections, folders, loading, error, scannedAt, progress, myList, metadata,
    reload: load, saveProgress, toggleMyList, loadMetadata,
  }), [movies, series, collections, folders, loading, error, scannedAt, progress, myList, metadata, load, saveProgress, toggleMyList, loadMetadata]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  const context = useContext(LibraryContext);
  if (!context) throw new Error('useLibrary must be used within a LibraryProvider.');
  return context;
}
