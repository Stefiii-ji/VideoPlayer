const CACHE_LIMIT = 200;
const CACHE_HIT_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MISS_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const cache = new Map();

function cached(key, operation) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.promise;
  }
  if (existing) cache.delete(key);

  const entry = { expiresAt: Infinity, promise: null };
  entry.promise = Promise.resolve()
    .then(operation)
    .then((value) => {
      entry.expiresAt = Date.now() + (value == null ? CACHE_MISS_TTL_MS : CACHE_HIT_TTL_MS);
      return value;
    }, (error) => {
      entry.expiresAt = Date.now() + CACHE_MISS_TTL_MS;
      throw error;
    });
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return entry.promise;
}

function cacheKey(kind, apiKey, ...parts) {
  return JSON.stringify([kind, apiKey, ...parts]);
}

async function requestTmdb(path, apiKey, params, failureMessage) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const headers = {};
  if (apiKey.startsWith('eyJ')) headers.Authorization = `Bearer ${apiKey}`;
  else url.searchParams.set('api_key', apiKey);

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers,
      signal,
    });
    if (!response.ok) throw new Error(`${failureMessage} (${response.status}).`);
    return await response.json();
  } catch (error) {
    if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error(`TMDB request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  }
}

async function searchSeries(title, apiKey) {
  return cached(cacheKey('series-search', apiKey, title), async () => {
    const data = await requestTmdb('/search/tv', apiKey, { query: title }, 'TMDB series search failed');
    return data.results?.[0] ?? null;
  });
}

const movieGenres = new Map([
  [28, 'Action'], [12, 'Adventure'], [16, 'Animation'], [35, 'Comedy'],
  [80, 'Crime'], [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'],
  [14, 'Fantasy'], [36, 'History'], [27, 'Horror'], [10402, 'Music'],
  [9648, 'Mystery'], [10749, 'Romance'], [878, 'Science Fiction'],
  [10770, 'TV Movie'], [53, 'Thriller'], [10752, 'War'], [37, 'Western'],
]);

export async function getMovieMetadata(title, apiKey, { year } = {}) {
  if (!apiKey) return null;
  return cached(cacheKey('movie', apiKey, title, year ?? null), async () => {
    const searchMovie = async (searchYear) => {
      const data = await requestTmdb(
        '/search/movie',
        apiKey,
        { query: title, year: searchYear },
        'TMDB metadata request failed',
      );
      return data.results?.[0] ?? null;
    };
    const result = await searchMovie(year);
    const match = result ?? (year ? await searchMovie(undefined) : null);
    if (!match) return null;

    const details = await requestTmdb(
      `/movie/${match.id}`,
      apiKey,
      {},
      'TMDB movie details request failed',
    );
    return {
      description: match.overview ?? '',
      releaseYear: match.release_date ? Number(match.release_date.slice(0, 4)) : null,
      genres: details.genres?.map((genre) => genre.name)
        ?? (match.genre_ids ?? []).map((genreId) => movieGenres.get(genreId)).filter(Boolean),
      rating: match.vote_average ?? null,
      runtime: details.runtime ?? null,
      posterUrl: match.poster_path
        ? `https://image.tmdb.org/t/p/w500${match.poster_path}`
        : null,
      backdropUrl: match.backdrop_path
        ? `https://image.tmdb.org/t/p/w1280${match.backdrop_path}`
        : null,
    };
  });
}

export async function getSeriesMetadata(title, apiKey) {
  if (!apiKey) return null;
  return cached(cacheKey('series', apiKey, title), async () => {
    const result = await searchSeries(title, apiKey);
    if (!result) return null;
    const details = await requestTmdb(
      `/tv/${result.id}`,
      apiKey,
      {},
      'TMDB series details failed',
    );
    return {
      id: result.id,
      title: details.name ?? result.name,
      description: details.overview ?? result.overview ?? '',
      releaseYear: details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : null,
      genres: (details.genres ?? []).map((genre) => genre.name),
      rating: details.vote_average ?? result.vote_average ?? null,
      posterUrl: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
      backdropUrl: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
      seasons: (details.seasons ?? []).map((season) => ({
        number: season.season_number,
        title: season.name,
        episodeCount: season.episode_count,
      })),
    };
  });
}

export async function getSeriesSeasonMetadata(title, seasonNumber, apiKey) {
  if (!apiKey) return null;
  return cached(cacheKey('series-season', apiKey, title, seasonNumber), async () => {
    const result = await searchSeries(title, apiKey);
    if (!result) return null;
    const season = await requestTmdb(
      `/tv/${result.id}/season/${seasonNumber}`,
      apiKey,
      {},
      'TMDB season metadata request failed',
    );
    return (season.episodes ?? []).map((episode) => ({
      episodeNumber: episode.episode_number,
      title: episode.name,
      description: episode.overview ?? '',
      runtime: episode.runtime ?? null,
    }));
  });
}
