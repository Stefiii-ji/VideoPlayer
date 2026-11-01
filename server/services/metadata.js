export async function getMovieMetadata(title, apiKey) {
  if (!apiKey) return null;
  const url = new URL('https://api.themoviedb.org/3/search/movie');
  url.searchParams.set('query', title);
  url.searchParams.set('api_key', apiKey);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDB metadata request failed (${response.status}).`);
  const data = await response.json();
  const result = data.results?.[0];
  if (!result) return null;
  const detailUrl = new URL(`https://api.themoviedb.org/3/movie/${result.id}`);
  detailUrl.searchParams.set('api_key', apiKey);
  const detailResponse = await fetch(detailUrl);
  if (!detailResponse.ok) throw new Error(`TMDB movie details request failed (${detailResponse.status}).`);
  const details = await detailResponse.json();
  const genreNames = new Map([
    [28, 'Action'], [12, 'Adventure'], [16, 'Animation'], [35, 'Comedy'],
    [80, 'Crime'], [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'],
    [14, 'Fantasy'], [36, 'History'], [27, 'Horror'], [10402, 'Music'],
    [9648, 'Mystery'], [10749, 'Romance'], [878, 'Science Fiction'],
    [10770, 'TV Movie'], [53, 'Thriller'], [10752, 'War'], [37, 'Western'],
  ]);
  return {
    description: result.overview ?? '',
    releaseYear: result.release_date ? Number(result.release_date.slice(0, 4)) : null,
    genres: details.genres?.map((genre) => genre.name)
      ?? (result.genre_ids ?? []).map((genreId) => genreNames.get(genreId)).filter(Boolean),
    rating: result.vote_average ?? null,
    runtime: details.runtime ?? null,
    posterUrl: result.poster_path
      ? `https://image.tmdb.org/t/p/w500${result.poster_path}`
      : null,
    backdropUrl: result.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}`
      : null,
  };
}

export async function getSeriesMetadata(title, apiKey) {
  if (!apiKey) return null;
  const searchUrl = new URL('https://api.themoviedb.org/3/search/tv');
  searchUrl.searchParams.set('query', title);
  searchUrl.searchParams.set('api_key', apiKey);
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) throw new Error(`TMDB series search failed (${searchResponse.status}).`);
  const result = (await searchResponse.json()).results?.[0];
  if (!result) return null;
  const detailUrl = new URL(`https://api.themoviedb.org/3/tv/${result.id}`);
  detailUrl.searchParams.set('api_key', apiKey);
  const detailResponse = await fetch(detailUrl);
  if (!detailResponse.ok) throw new Error(`TMDB series details failed (${detailResponse.status}).`);
  const details = await detailResponse.json();
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
}

export async function getSeriesSeasonMetadata(title, seasonNumber, apiKey) {
  if (!apiKey) return null;
  const searchUrl = new URL('https://api.themoviedb.org/3/search/tv');
  searchUrl.searchParams.set('query', title);
  searchUrl.searchParams.set('api_key', apiKey);
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) throw new Error(`TMDB series search failed (${searchResponse.status}).`);
  const result = (await searchResponse.json()).results?.[0];
  if (!result) return null;
  const seasonUrl = new URL(`https://api.themoviedb.org/3/tv/${result.id}/season/${seasonNumber}`);
  seasonUrl.searchParams.set('api_key', apiKey);
  const seasonResponse = await fetch(seasonUrl);
  if (!seasonResponse.ok) throw new Error(`TMDB season metadata request failed (${seasonResponse.status}).`);
  const season = await seasonResponse.json();
  return (season.episodes ?? []).map((episode) => ({
    episodeNumber: episode.episode_number,
    title: episode.name,
    description: episode.overview ?? '',
    runtime: episode.runtime ?? null,
  }));
}
