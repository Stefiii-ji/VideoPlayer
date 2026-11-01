import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { libraryApi, movieApi } from '../services/api.js';

const LibraryContext = createContext(null);
const WATCH_KEY = 'moviestream-watch-progress';
const LIST_KEY = 'moviestream-my-list';
const METADATA_KEY = 'moviestream-metadata';

function readProgress() {
  try {
    return JSON.parse(localStorage.getItem(WATCH_KEY) || '{}');
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

export function LibraryProvider({ children }) {
  const [movies, setMovies] = useState([]);
  const [series, setSeries] = useState([]);
  const [collections, setCollections] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scannedAt, setScannedAt] = useState(null);
  const [progress, setProgress] = useState(readProgress);
  const [myList, setMyList] = useState(() => {
    const stored = readStorage(LIST_KEY, []);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  });
  const [metadata, setMetadata] = useState(() => {
    const stored = readStorage(METADATA_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  });
  const lastProgressWrite = useRef(new Map());
  const lastServerProgressWrite = useRef(new Map());
  const metadataRequests = useRef(new Map());

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
        item.completed ? null : {
          currentTime: item.positionSeconds,
          duration: item.durationSeconds,
          updatedAt: new Date(item.updatedAt).getTime(),
        },
      ]));
      setProgress((previous) => ({ ...previous, ...persistedProgress }));
    } catch (cause) {
      setError(cause.message || 'The movie library could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    localStorage.setItem(WATCH_KEY, JSON.stringify(progress));
  }, [progress]);
  useEffect(() => {
    localStorage.setItem(LIST_KEY, JSON.stringify(myList));
  }, [myList]);
  useEffect(() => {
    localStorage.setItem(METADATA_KEY, JSON.stringify(metadata));
  }, [metadata]);

  const toggleMyList = useCallback((movieId) => {
    setMyList((previous) => previous.includes(movieId)
      ? previous.filter((id) => id !== movieId)
      : [...previous, movieId]);
  }, []);

  const loadMetadata = useCallback(async (movieId) => {
    if (Object.hasOwn(metadata, movieId)) return metadata[movieId];
    if (metadataRequests.current.has(movieId)) return metadataRequests.current.get(movieId);
    const request = movieApi.metadata(movieId)
      .then(({ metadata: result }) => {
        setMetadata((previous) => ({ ...previous, [movieId]: result }));
        return result;
      })
      .finally(() => metadataRequests.current.delete(movieId));
    metadataRequests.current.set(movieId, request);
    return request;
  }, [metadata]);

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
