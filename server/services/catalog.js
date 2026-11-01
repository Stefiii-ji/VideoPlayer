import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMovieId, isWithinDirectory, publicMovie, scanLibrary } from './library.js';

const EPISODE_PATTERN = /(?:^|[\s._-])S(\d{1,2})[\s._-]*E(\d{1,3})(?:\b|[\s._-])/i;
const EPISODE_ALT_PATTERN = /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:\b|[\s._-])/i;
const SEASON_FOLDER_PATTERN = /^(?:season|series|s)[\s._-]*(\d{1,2})$/i;
const SPECIALS_PATTERN = /^(?:specials?|extras?)$/i;
const COLLECTION_NAME_PATTERN = /\b(?:collections?|franchises?|saga|trilogy|quadrilogy|complete|box[ ._-]?set|universe)\b/i;
const COLLECTION_CONTAINER_PATTERN = /^(?:collections?|franchises|movie collections)$/i;
const VALID_CLASSIFICATIONS = new Set(['series', 'collection', 'normal', 'excluded']);

function normalizedKey(value) {
  return value.toLocaleLowerCase('en-US');
}

function foldersForPath(relativePath) {
  const parsed = path.parse(relativePath.replace(/[\\/]/g, path.sep));
  const directory = parsed.dir;
  return directory ? directory.split(path.sep) : [];
}

function seasonFromMovie(movie) {
  const match = EPISODE_PATTERN.exec(movie.title) ?? EPISODE_PATTERN.exec(path.basename(movie.relativePath))
    ?? EPISODE_ALT_PATTERN.exec(movie.title) ?? EPISODE_ALT_PATTERN.exec(path.basename(movie.relativePath));
  if (match) return { season: Number(match[1]), episode: Number(match[2]) };

  const seasonFolder = foldersForPath(movie.relativePath).map((part) => SEASON_FOLDER_PATTERN.exec(part)).find(Boolean);
  if (seasonFolder) {
    const episodeMatch = /(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i.exec(movie.title)
      ?? /(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i.exec(path.basename(movie.relativePath));
    if (episodeMatch) return { season: Number(seasonFolder[1]), episode: Number(episodeMatch[1]) };
  }
  const parentSeason = foldersForPath(movie.relativePath).map((part) => SPECIALS_PATTERN.test(part)).includes(true);
  if (parentSeason) {
    const episodeMatch = /(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i.exec(movie.title)
      ?? /(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i.exec(path.basename(movie.relativePath));
    if (episodeMatch) return { season: 0, episode: Number(episodeMatch[1]) };
  }
  return null;
}

function findSeriesFolder(movie, foldersByRelativePath, episode) {
  const folderParts = foldersForPath(movie.relativePath);
  const seasonIndex = folderParts.findIndex((part) => SEASON_FOLDER_PATTERN.test(part) || SPECIALS_PATTERN.test(part));
  const candidateParts = seasonIndex >= 0 ? folderParts.slice(0, seasonIndex) : folderParts;
  if (!candidateParts.length) return null;

  const relativePath = candidateParts.join(path.sep);
  if (!relativePath) return null;
  const folder = foldersByRelativePath.get(normalizedKey(relativePath));
  if (!folder) return null;
  return { folder, episode };
}

export function buildCatalog(scan, state = { folderOverrides: {}, customCollections: [], watchProgress: {} }) {
  const { root, movies } = scan;
  const folders = [];
  const rootFolder = {
    id: createMovieId(''),
    name: path.basename(root),
    relativePath: '',
    parentId: null,
    children: [],
    movieIds: [],
    modifiedAt: null,
  };
  const folderByRelativePath = new Map([['', rootFolder]]);

  for (const record of scan.folders ?? []) {
    const relativePath = record.relativePath;
    const parentPath = path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath);
    const parent = folderByRelativePath.get(normalizedKey(parentPath));
    if (!parent) continue;
    const folder = {
      id: record.id,
      name: record.name,
      relativePath,
      parentId: parent.id,
      children: [],
      movieIds: [],
      modifiedAt: record.modifiedAt,
    };
    folderByRelativePath.set(normalizedKey(relativePath), folder);
    parent.children.push(folder.id);
    folders.push(folder);
  }
  for (const movie of movies) {
    const parentPath = path.dirname(movie.relativePath) === '.' ? '' : path.dirname(movie.relativePath);
    const parent = folderByRelativePath.get(normalizedKey(parentPath));
    if (parent) parent.movieIds.push(movie.id);
  }
  const folderById = new Map([rootFolder, ...folders].map((folder) => [folder.id, folder]));
  const movieById = new Map(movies.map((movie) => [movie.id, movie]));
  for (const folder of [rootFolder, ...folders]) {
    folder.children.sort((a, b) => folderById.get(a).name.localeCompare(folderById.get(b).name));
    folder.movieIds.sort((a, b) => movieById.get(a).title.localeCompare(movieById.get(b).title));
  }
  const foldersByRelativePath = new Map([rootFolder, ...folders].map((folder) => [normalizedKey(folder.relativePath), folder]));
  const overrides = state.folderOverrides ?? {};

  const seriesByFolderId = new Map();
  const isExcludedPath = (relativePath) => foldersForPath(relativePath)
    .reduce((parts, name) => {
      parts.push(parts.length ? path.join(parts.at(-1), name) : name);
      return parts;
    }, [])
    .some((folderPath) => overrides[createMovieId(folderPath)]?.type === 'excluded');
  for (const movie of movies) {
    const ancestorPaths = foldersForPath(movie.relativePath).reduce((parts, name) => {
      parts.push(parts.length ? path.join(parts.at(-1), name) : name);
      return parts;
    }, []);
    const nearestOverride = ancestorPaths
      .map((relativePath) => ({ folder: foldersByRelativePath.get(normalizedKey(relativePath)), type: overrides[createMovieId(relativePath)]?.type }))
      .filter((entry) => entry.type)
      .at(-1);
    if (nearestOverride && nearestOverride.type !== 'series') continue;

    const parsedEpisode = seasonFromMovie(movie);
    const seriesFolder = nearestOverride
      ? { folder: nearestOverride.folder, episode: parsedEpisode ?? {
        season: inferSeason(nearestOverride.folder, movie, folders) ?? 1,
        episode: inferredEpisode(movie),
      } }
      : parsedEpisode ? findSeriesFolder(movie, foldersByRelativePath, parsedEpisode) : null;
    if (!seriesFolder || !seriesFolder.episode || !Number.isInteger(seriesFolder.episode.season)
      || !Number.isInteger(seriesFolder.episode.episode)) continue;
    const item = seriesByFolderId.get(seriesFolder.folder.id) ?? { folder: seriesFolder.folder, episodes: [] };
    item.episodes.push({ movie, ...seriesFolder.episode });
    seriesByFolderId.set(seriesFolder.folder.id, item);
  }

  const series = [...seriesByFolderId.values()].filter(({ folder }) => !isExcludedPath(folder.relativePath)).map(({ folder, episodes }) => {
    const seasons = new Map();
    for (const entry of episodes) {
      const season = seasons.get(entry.season) ?? { number: entry.season, episodes: [] };
      season.episodes.push({
        ...publicMovie(entry.movie),
        episodeNumber: entry.episode,
        seasonNumber: entry.season,
        watched: Boolean(state.watchProgress?.[entry.movie.id]?.completed),
        progress: state.watchProgress?.[entry.movie.id] ?? null,
      });
      seasons.set(entry.season, season);
    }
    return {
      id: folder.id,
      title: cleanFolderTitle(folder.name),
      folderId: folder.id,
      relativePath: folder.relativePath.split(path.sep).join('/'),
      episodeCount: episodes.length,
      seasons: [...seasons.values()]
        .map((season) => ({ ...season, episodes: season.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber) }))
        .sort((a, b) => a.number - b.number),
      posterUrl: overrides[folder.id]?.artworkUrl ?? null,
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
  const seriesById = new Map(series.map((item) => [item.id, item]));
  const episodeIds = new Set(series.flatMap((item) => item.seasons.flatMap((season) => season.episodes.map((episode) => episode.id))));
  const visibleMovieIds = new Set(movies.filter((movie) => !episodeIds.has(movie.id) && !isExcludedPath(movie.relativePath)).map((movie) => movie.id));

  const folderViews = folders.map((folder) => {
    const children = folder.children.map((id) => folderById.get(id));
    const descendantMovies = movies.filter((movie) => movie.relativePath.startsWith(`${folder.relativePath}${path.sep}`));
    const descendantFolders = folders.filter((child) => child.relativePath.startsWith(`${folder.relativePath}${path.sep}`));
    const classification = overrides[folder.id]?.type ?? inferFolderType(folder, seriesById.has(folder.id));
    const ownMovies = folder.movieIds.map((id) => movieById.get(id));
    const modifiedAt = [folder.modifiedAt, ...descendantFolders.map((item) => item.modifiedAt), ...descendantMovies.map((item) => item.modifiedAt)]
      .filter(Boolean).sort().at(-1) ?? null;
    return {
      id: folder.id,
      name: cleanFolderTitle(folder.name),
      relativePath: folder.relativePath.split(path.sep).join('/'),
      parentId: folder.parentId,
      folderCount: children.filter((child) => overrides[child.id]?.type !== 'excluded' && !isExcludedPath(child.relativePath)).length,
      movieCount: descendantMovies.filter((movie) => visibleMovieIds.has(movie.id)).length,
      episodeCount: descendantMovies.filter((movie) => episodeIds.has(movie.id) && !isExcludedPath(movie.relativePath)).length,
      modifiedAt,
      year: descendantMovies.reduce((latest, movie) => Math.max(latest, movie.releaseYear ?? 0), 0) || null,
      classification: publicClassification(classification),
      artworkUrl: overrides[folder.id]?.artworkUrl ?? null,
      children: children
        .map((child) => folderViewSummary(child, folders, movies, episodeIds, overrides, seriesById, isExcludedPath))
        .filter((child) => child.classification !== 'excluded' && !isExcludedPath(child.relativePath)),
      movies: ownMovies.filter((movie) => !episodeIds.has(movie.id)).map((movie) => publicMovie(movie)),
      seriesId: seriesById.has(folder.id) ? folder.id : null,
    };
  });
  const folderViewById = new Map(folderViews.map((folder) => [folder.id, folder]));
  const rootContents = {
    id: rootFolder.id,
    name: rootFolder.name,
    relativePath: '',
    parentId: null,
    folderCount: rootFolder.children.filter((id) => {
      const folder = folderById.get(id);
      return overrides[id]?.type !== 'excluded' && !isExcludedPath(folder.relativePath);
    }).length,
    movieCount: visibleMovieIds.size,
    episodeCount: movies.filter((movie) => episodeIds.has(movie.id) && !isExcludedPath(movie.relativePath)).length,
    children: rootFolder.children.map((id) => folderViewById.get(id))
      .filter((folder) => folder.classification !== 'excluded' && !isExcludedPath(folder.relativePath)),
    movies: rootFolder.movieIds.map((id) => movieById.get(id)).filter((movie) => !episodeIds.has(movie.id)).map((movie) => publicMovie(movie)),
  };

  const autoCollections = folders
    .filter((folder) => {
      const view = folderViewById.get(folder.id);
      return view.classification === 'collection' && view.movieCount > 0;
    })
    .map((folder) => {
      const view = folderViewById.get(folder.id);
      const descendantMovies = movies.filter((movie) =>
        movie.relativePath.startsWith(`${folder.relativePath}${path.sep}`) && visibleMovieIds.has(movie.id));
      return {
        id: folder.id,
        name: view.name,
        relativePath: view.relativePath,
        type: 'folder',
        description: '',
        artworkUrl: view.artworkUrl,
        movieCount: descendantMovies.length,
        movies: descendantMovies.map((movie) => publicMovie(movie)),
      };
    });
  const customCollections = (state.customCollections ?? []).map((collection) => ({
    ...collection,
    type: 'custom',
    movies: (collection.movieIds ?? []).filter((id) => visibleMovieIds.has(id)).map((id) => movieById.get(id)).filter(Boolean).map((movie) => publicMovie(movie)),
  }));
  const folderLookup = new Map(folderViews.map((folder) => [folder.id, folder]));

  function getFolderContents(id) {
    const folder = id === rootFolder.id ? rootContents : folderViewById.get(id);
    if (!folder) return null;
    const breadcrumbs = [];
    let cursor = folder;
    while (cursor && cursor.parentId) {
      breadcrumbs.unshift({ id: cursor.id, name: cursor.name });
      cursor = folderLookup.get(cursor.parentId);
    }
    breadcrumbs.unshift({ id: rootFolder.id, name: rootFolder.name });
    return { ...folder, breadcrumbs };
  }

  function validateFolderPath(id) {
    const folder = folderLookup.get(id);
    if (!folder || folder.classification === 'excluded' || isExcludedPath(folder.relativePath)) return null;
    const resolved = path.resolve(root, folder.relativePath);
    if (resolved !== root && !isWithinDirectory(root, resolved)) return null;
    return folder;
  }

  return {
    rootFolder: { id: rootFolder.id, name: rootFolder.name },
    folders: folderViews.filter((folder) => folder.classification !== 'excluded' && !isExcludedPath(folder.relativePath)),
    folderById: folderLookup,
    getFolderContents,
    validateFolderPath,
    series,
    seriesById,
    collections: [...autoCollections, ...customCollections],
    movies: movies.filter((movie) => visibleMovieIds.has(movie.id)),
    allMovies: movies,
    movieById,
    episodeIds,
    overrides,
    state,
  };
}

function cleanFolderTitle(value) {
  return value
    .replace(/[\s._-]+\bS\d{1,2}\b.*$/i, '')
    .replace(/\s+(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?.*$/i, '')
    .replace(/\s*[-–|]\s*(?:action|adventure|animation|comedy|crime|drama|fantasy|horror|romance|sci[ ._-]?fi|thriller)\b.*$/i, '')
    .replace(/[._]/g, ' ')
    .replace(/\b(?:1080p|720p|2160p|4k|web[ ._-]?dl|web[ ._-]?rip|bluray|bdrip|x26[45]|h26[45]|hevc)\b/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s()[\]_-]+$/g, '')
    .trim();
}

function inferSeason(folder, movie, allFolders) {
  const parent = foldersForPath(movie.relativePath).map((part) => SEASON_FOLDER_PATTERN.exec(part)).find(Boolean);
  if (parent) return Number(parent[1]);
  const directory = path.dirname(movie.relativePath);
  const seasonFolder = allFolders.find((candidate) => normalizedKey(candidate.relativePath) === normalizedKey(directory));
  const fromName = seasonFolder?.name.match(/season[\s._-]*(\d{1,2})/i);
  return fromName ? Number(fromName[1]) : null;
}

function inferredEpisode(movie) {
  const match = /(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i.exec(movie.title)
    ?? /(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i.exec(path.basename(movie.relativePath))
    ?? /(?:^|[\s._-])(\d{1,3})(?:[\s._-]|$)/.exec(path.basename(movie.relativePath));
  return match ? Number(match[1]) : null;
}

function inferFolderType(folder, hasSeries) {
  if (hasSeries) return 'series';
  if (COLLECTION_NAME_PATTERN.test(folder.name) && !COLLECTION_CONTAINER_PATTERN.test(folder.name)) return 'collection';
  const parentIsCollection = folder.relativePath.split(path.sep).slice(0, -1).some((part) => COLLECTION_NAME_PATTERN.test(part));
  if (parentIsCollection) return 'collection';
  return 'folder';
}

function folderViewSummary(folder, allFolders, movies, episodeIds, overrides, seriesById, isExcludedPath) {
  const children = folder.children.map((id) => allFolders.find((item) => item.id === id)).filter(Boolean);
  const descendants = movies.filter((movie) => movie.relativePath.startsWith(`${folder.relativePath}${path.sep}`));
  const descendantFolders = allFolders.filter((item) => item.relativePath.startsWith(`${folder.relativePath}${path.sep}`));
  const classification = overrides[folder.id]?.type ?? inferFolderType(folder, seriesById.has(folder.id));
  const modifiedAt = [folder.modifiedAt, ...descendantFolders.map((item) => item.modifiedAt), ...descendants.map((item) => item.modifiedAt)]
    .filter(Boolean).sort().at(-1) ?? null;
  return {
    id: folder.id,
    name: cleanFolderTitle(folder.name),
    relativePath: folder.relativePath.split(path.sep).join('/'),
    parentId: folder.parentId,
    folderCount: children.filter((child) => overrides[child.id]?.type !== 'excluded' && !isExcludedPath(child.relativePath)).length,
    movieCount: descendants.filter((movie) => !episodeIds.has(movie.id) && !isExcludedPath(movie.relativePath)).length,
    episodeCount: descendants.filter((movie) => episodeIds.has(movie.id) && !isExcludedPath(movie.relativePath)).length,
    modifiedAt,
    year: descendants.reduce((latest, movie) => Math.max(latest, movie.releaseYear ?? 0), 0) || null,
    classification: publicClassification(classification),
    artworkUrl: overrides[folder.id]?.artworkUrl ?? null,
    seriesId: seriesById.has(folder.id) ? folder.id : null,
  };
}

export function makeCustomCollectionId() {
  return `custom-${randomUUID()}`;
}

export function validClassification(value) {
  return VALID_CLASSIFICATIONS.has(value);
}

function publicClassification(value) {
  return value === 'normal' ? 'folder' : value;
}
