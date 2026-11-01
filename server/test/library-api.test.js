import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';

let fixtureRoot;
let mediaRoot;
let metadataFile;
let server;
let baseUrl;

async function startServer() {
  server = createApp({
    movieDirectory: mediaRoot,
    metadataFile,
    clientUrls: ['http://localhost:5173'],
    serveClient: false,
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = null;
}

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-library-api-'));
  mediaRoot = path.join(fixtureRoot, 'media');
  metadataFile = path.join(fixtureRoot, 'app-data', 'library-state.json');
  await mkdir(path.join(mediaRoot, 'Web Series', 'The Sample Show', 'Season 01'), { recursive: true });
  await mkdir(path.join(mediaRoot, 'Collections', 'Sample Collection'), { recursive: true });
  await writeFile(path.join(mediaRoot, 'Web Series', 'The Sample Show', 'Season 01', 'The.Sample.Show.S01E01.mp4'), Buffer.from('0123456789'));
  await writeFile(path.join(mediaRoot, 'Collections', 'Sample Collection', 'A Film.mp4'), Buffer.from('film'));
  await writeFile(path.join(mediaRoot, 'Collections', 'Sample Collection', 'B Film.mp4'), Buffer.from('film'));
  await startServer();
});

test.afterEach(async () => {
  await stopServer();
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('exposes safe folder, series, collection, and progress APIs with persistent metadata', async () => {
  const overviewResponse = await fetch(`${baseUrl}/api/library`);
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(overview.movies.length, 2);
  assert.equal(overview.series.length, 1);
  assert.equal(overview.series[0].title, 'The Sample Show');
  assert.equal(overview.collections.some((item) => item.name === 'Sample Collection'), true);
  assert.equal(JSON.stringify(overview).includes(mediaRoot), false);
  assert.equal(overview.series[0].relativePath, 'Web Series/The Sample Show');

  const rootResponse = await fetch(`${baseUrl}/api/library/folders`);
  const root = (await rootResponse.json()).folder;
  const webSeriesFolder = root.children.find((folder) => folder.name === 'Web Series');
  const showFolder = (await (await fetch(`${baseUrl}/api/library/folders/${webSeriesFolder.id}`)).json()).folder.children[0];
  assert.equal(showFolder.seriesId, overview.series[0].id);
  const episode = overview.series[0].seasons[0].episodes[0];

  const nestedStream = await fetch(`${baseUrl}/api/movies/${episode.id}/stream`, { headers: { Range: 'bytes=3-5' } });
  assert.equal(nestedStream.status, 206);
  assert.equal(await nestedStream.text(), '345');

  const savedProgress = await fetch(`${baseUrl}/api/library/progress/${episode.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positionSeconds: 30, durationSeconds: 100 }),
  });
  assert.equal(savedProgress.status, 200);

  const collectionMovie = overview.movies.find((movie) => movie.title === 'A Film');
  const createCollection = await fetch(`${baseUrl}/api/library/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Favorites', movieIds: [collectionMovie.id] }),
  });
  assert.equal(createCollection.status, 201);
  const { collection } = await createCollection.json();
  assert.equal(collection.movies[0].title, 'A Film');

  const updatedCollection = await fetch(`${baseUrl}/api/library/collections/${collection.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Favorite Films',
      description: 'Our local picks',
      artworkUrl: 'https://images.example/favorites.jpg',
      movieIds: [],
    }),
  });
  assert.equal(updatedCollection.status, 200);
  assert.equal((await updatedCollection.json()).collection.movies.length, 0);
  const addMovieBack = await fetch(`${baseUrl}/api/library/collections/${collection.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Favorite Films',
      description: 'Our local picks',
      artworkUrl: 'https://images.example/favorites.jpg',
      movieIds: [collectionMovie.id],
    }),
  });
  assert.equal((await addMovieBack.json()).collection.movies.length, 1);

  await stopServer();
  await startServer();
  const persisted = await (await fetch(`${baseUrl}/api/library`)).json();
  assert.equal(persisted.collections.some((item) => item.id === collection.id), true);
  assert.equal(persisted.collections.find((item) => item.id === collection.id).name, 'Favorite Films');
  assert.equal(persisted.watchProgress[episode.id].positionSeconds, 30);

  const unsafeFolder = await fetch(`${baseUrl}/api/library/folders/${'f'.repeat(24)}`);
  assert.equal(unsafeFolder.status, 404);
  const badProgress = await fetch(`${baseUrl}/api/library/progress/${episode.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positionSeconds: 95, durationSeconds: 100 }),
  });
  assert.equal(badProgress.status, 200);
  assert.equal((await badProgress.json()).progress.completed, true);

  const deleted = await fetch(`${baseUrl}/api/library/collections/${collection.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  const afterDelete = await (await fetch(`${baseUrl}/api/library/collections`)).json();
  assert.equal(afterDelete.collections.some((item) => item.id === collection.id), false);
});

test('excludes a classified folder from library results without changing the media file', async () => {
  const overview = await (await fetch(`${baseUrl}/api/library`)).json();
  const movie = overview.movies.find((item) => item.title === 'A Film');
  const before = await import('node:fs/promises').then(({ readFile }) => readFile(path.join(mediaRoot, 'Collections', 'Sample Collection', 'A Film.mp4')));
  const folder = overview.folders.find((item) => item.name === 'Collections');
  const collectionFolder = (await (await fetch(`${baseUrl}/api/library/folders/${folder.id}`)).json()).folder.children[0];
  const response = await fetch(`${baseUrl}/api/library/folders/${folder.id}/classification`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'excluded' }),
  });
  assert.equal(response.status, 200);
  const after = await (await fetch(`${baseUrl}/api/library`)).json();
  assert.equal(after.movies.some((item) => item.id === movie.id), false);
  assert.equal(after.folders.some((item) => item.id === folder.id), false);
  assert.equal((await fetch(`${baseUrl}/api/library/folders/${collectionFolder.id}`)).status, 404);
  assert.deepEqual(await import('node:fs/promises').then(({ readFile }) => readFile(path.join(mediaRoot, 'Collections', 'Sample Collection', 'A Film.mp4'))), before);
});

test('invalidates the cached catalog after classification, collection, progress, and scan changes', async () => {
  const initial = await (await fetch(`${baseUrl}/api/library`)).json();
  const seriesFolder = initial.folders.find((folder) => folder.name === 'Web Series');
  const showFolder = (await (await fetch(`${baseUrl}/api/library/folders/${seriesFolder.id}`)).json())
    .folder.children[0];
  const classification = await fetch(`${baseUrl}/api/library/folders/${showFolder.id}/classification`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'series',
      artworkUrl: 'https://images.example/show-poster.jpg',
    }),
  });
  assert.equal(classification.status, 200);
  const afterClassification = await (await fetch(`${baseUrl}/api/library/folders/${showFolder.id}`)).json();
  assert.equal(afterClassification.folder.artworkUrl, 'https://images.example/show-poster.jpg');

  const collectionMovie = initial.movies.find((movie) => movie.title === 'A Film');
  const collectionResponse = await fetch(`${baseUrl}/api/library/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cache Invalidation', movieIds: [collectionMovie.id] }),
  });
  assert.equal(collectionResponse.status, 201);
  const { collection } = await collectionResponse.json();
  const afterCollectionUpdate = await (await fetch(`${baseUrl}/api/library`)).json();
  assert.equal(afterCollectionUpdate.collections.some((item) => item.id === collection.id), true);

  const episode = initial.series[0].seasons[0].episodes[0];
  const progressResponse = await fetch(`${baseUrl}/api/library/progress/${episode.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positionSeconds: 30, durationSeconds: 100 }),
  });
  assert.equal(progressResponse.status, 200);
  const afterProgressUpdate = await (await fetch(`${baseUrl}/api/library`)).json();
  assert.equal(afterProgressUpdate.watchProgress[episode.id].positionSeconds, 30);

  await writeFile(path.join(mediaRoot, 'New Scan Movie.mp4'), 'new media');
  const refresh = await fetch(`${baseUrl}/api/movies/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 200);
  const afterRescan = await (await fetch(`${baseUrl}/api/library`)).json();
  assert.equal(afterRescan.movies.some((movie) => movie.title === 'New Scan Movie'), true);
});
