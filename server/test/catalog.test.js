import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCatalog } from '../services/catalog.js';
import { createLibraryState } from '../services/library-state.js';
import { createMovieId, scanLibrary } from '../services/library.js';

let fixtureRoot;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-catalog-'));
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('preserves nested folders and groups named episodes into seasons', async () => {
  const episodeFolder = path.join(fixtureRoot, 'Web Series', 'Breaking Bad', 'Season 01');
  await mkdir(episodeFolder, { recursive: true });
  const firstEpisode = path.join(episodeFolder, 'Breaking.Bad.S01E01.mkv');
  const secondEpisode = path.join(episodeFolder, 'Breaking.Bad.S01E02.mkv');
  await writeFile(firstEpisode, Buffer.from('episode one'));
  await writeFile(secondEpisode, Buffer.from('episode two'));
  await mkdir(path.join(fixtureRoot, 'Movies', 'Interstellar folder'), { recursive: true });
  await writeFile(path.join(fixtureRoot, 'Movies', 'Interstellar folder', 'Interstellar.2014.mp4'), Buffer.from('movie'));

  const scan = await scanLibrary(fixtureRoot);
  const catalog = buildCatalog(scan);
  const root = catalog.getFolderContents(catalog.rootFolder.id);
  const webSeriesFolder = root.children.find((folder) => folder.name === 'Web Series');
  const shows = catalog.getFolderContents(webSeriesFolder.id);
  const breakingBad = shows.children.find((folder) => folder.name === 'Breaking Bad');
  const series = catalog.seriesById.get(breakingBad.id);

  assert.ok(breakingBad);
  assert.equal(series.episodeCount, 2);
  assert.deepEqual(series.seasons.map((season) => season.number), [1]);
  assert.deepEqual(series.seasons[0].episodes.map((episode) => episode.episodeNumber), [1, 2]);
  assert.equal(series.seasons[0].episodes[0].title, 'Breaking Bad S01E01');
  assert.equal(catalog.movies.length, 1);
  assert.equal(catalog.movies[0].title, 'Interstellar');
  assert.equal(root.children.some((folder) => folder.relativePath === 'Movies'), true);
  assert.equal(JSON.stringify(root).includes(fixtureRoot), false);
  assert.equal(await readFile(firstEpisode, 'utf8'), 'episode one');
});

test('stores manual folder classification and custom collection changes across store instances', async () => {
  const metadataPath = path.join(fixtureRoot, 'app-data', 'library-state.json');
  const store = createLibraryState(metadataPath);
  await store.update((state) => {
    state.folderOverrides['folder-id'] = { type: 'series' };
    state.customCollections.push({ id: 'custom-1', name: 'Favorites', movieIds: ['movie-1'] });
    state.watchProgress['movie-1'] = { positionSeconds: 30, durationSeconds: 100, completed: false };
  });

  const reloaded = await createLibraryState(metadataPath).read();
  assert.equal(reloaded.folderOverrides['folder-id'].type, 'series');
  assert.equal(reloaded.customCollections[0].name, 'Favorites');
  assert.equal(reloaded.watchProgress['movie-1'].positionSeconds, 30);
});

test('does not classify a plain folder as a series or collection automatically', async () => {
  await mkdir(path.join(fixtureRoot, 'Random Folder'), { recursive: true });
  await writeFile(path.join(fixtureRoot, 'Random Folder', 'One.mp4'), Buffer.from('one'));
  const catalog = buildCatalog(await scanLibrary(fixtureRoot));
  const folder = catalog.folders.find((item) => item.name === 'Random Folder');
  assert.equal(catalog.folderById.get(folder.id).relativePath, 'Random Folder');
  assert.equal(catalog.folders.find((item) => item.id === folder.id).classification, 'folder');
});

test('manual classifications support nonstandard episodes and movie collections', async () => {
  const seriesFolder = path.join(fixtureRoot, 'My Show');
  const collectionFolder = path.join(fixtureRoot, 'Weekend Picks');
  await mkdir(seriesFolder, { recursive: true });
  await mkdir(collectionFolder, { recursive: true });
  await writeFile(path.join(seriesFolder, '01 - Pilot.mp4'), Buffer.from('pilot'));
  await writeFile(path.join(seriesFolder, '02 - The Next Day.mp4'), Buffer.from('next'));
  await writeFile(path.join(collectionFolder, 'Film One.mp4'), Buffer.from('one'));
  await writeFile(path.join(collectionFolder, 'Film Two.mp4'), Buffer.from('two'));

  const scan = await scanLibrary(fixtureRoot);
  const state = {
    folderOverrides: {
      [createMovieId('My Show')]: { type: 'series' },
      [createMovieId('Weekend Picks')]: { type: 'collection' },
    },
    customCollections: [],
    watchProgress: {},
  };
  const catalog = buildCatalog(scan, state);
  const series = catalog.seriesById.get(createMovieId('My Show'));
  assert.equal(series.episodeCount, 2);
  assert.deepEqual(series.seasons[0].episodes.map((episode) => episode.episodeNumber), [1, 2]);
  assert.equal(catalog.collections.some((collection) => collection.id === createMovieId('Weekend Picks')), true);
  assert.equal(catalog.movies.some((movie) => movie.title === 'Pilot'), false);
});
