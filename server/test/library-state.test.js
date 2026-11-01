import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLibraryState } from '../services/library-state.js';

let fixtureRoot;
let statePath;

const emptyState = {
  folderOverrides: {},
  customCollections: [],
  watchProgress: {},
};

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-library-state-'));
  statePath = path.join(fixtureRoot, 'library-state.json');
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('reads a valid state file', async () => {
  const expected = {
    folderOverrides: { folder1: { type: 'series' } },
    customCollections: [{ id: 'favorites', name: 'Favorites', movieIds: ['movie1'] }],
    watchProgress: { movie1: { positionSeconds: 30, durationSeconds: 100 } },
  };
  await writeFile(statePath, JSON.stringify(expected));

  assert.deepEqual(await createLibraryState(statePath).read(), expected);
});

test('returns an empty state when the state file is missing', async () => {
  assert.deepEqual(await createLibraryState(statePath).read(), emptyState);
});

test('moves corrupt state aside and restores a valid backup', async () => {
  const backup = {
    folderOverrides: { folder1: { type: 'collection' } },
    customCollections: [],
    watchProgress: { movie1: { positionSeconds: 45, durationSeconds: 120 } },
  };
  await writeFile(statePath, '{invalid');
  await writeFile(`${statePath}.bak`, JSON.stringify(backup));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.deepEqual(await createLibraryState(statePath).read(), backup);
  } finally {
    console.warn = originalWarn;
  }

  const files = await readdir(fixtureRoot);
  const corruptFile = files.find((filename) => filename.startsWith('library-state.json.corrupt-'));
  assert.ok(corruptFile);
  assert.equal(await readFile(path.join(fixtureRoot, corruptFile), 'utf8'), '{invalid');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Corrupt MovieStream metadata moved to:/);
});

test('moves corrupt state aside and falls back to empty state without a valid backup', async () => {
  await writeFile(statePath, '{invalid');
  await writeFile(`${statePath}.bak`, 'also invalid');
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.deepEqual(await createLibraryState(statePath).read(), emptyState);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /Ignoring invalid MovieStream metadata backup:/);
  assert.ok((await readdir(fixtureRoot)).some((filename) => filename.startsWith('library-state.json.corrupt-')));
});

test('drops invalid nested state entries while retaining valid entries', async () => {
  await writeFile(statePath, JSON.stringify({
    folderOverrides: {
      validFolder: { type: 'series' },
      invalidArray: ['not', 'an', 'object'],
      invalidNull: null,
    },
    customCollections: [
      { id: 'valid', name: 'Valid', movieIds: ['movie1', 'movie2'] },
      { id: 2, name: 'Bad id', movieIds: [] },
      { id: 'bad-movies', name: 'Bad movie IDs', movieIds: ['movie1', 2] },
      { id: 'bad-shape', name: 'Bad shape', movieIds: {} },
    ],
    watchProgress: {
      validMovie: { positionSeconds: 30, durationSeconds: 100 },
      invalidArray: [],
      invalidPosition: { positionSeconds: '30', durationSeconds: 100 },
      invalidDuration: { positionSeconds: 30, durationSeconds: Infinity },
    },
  }));

  assert.deepEqual(await createLibraryState(statePath).read(), {
    folderOverrides: { validFolder: { type: 'series' } },
    customCollections: [{ id: 'valid', name: 'Valid', movieIds: ['movie1', 'movie2'] }],
    watchProgress: { validMovie: { positionSeconds: 30, durationSeconds: 100 } },
  });
});

test('atomically backs up the previous valid state after each successful update', async () => {
  const store = createLibraryState(statePath);
  await store.update((state) => {
    state.watchProgress.movie1 = { positionSeconds: 10, durationSeconds: 100 };
  });
  const previous = await readFile(statePath, 'utf8');

  await store.update((state) => {
    state.watchProgress.movie1.positionSeconds = 20;
  });

  assert.equal(await readFile(`${statePath}.bak`, 'utf8'), previous);
  assert.equal((await store.read()).watchProgress.movie1.positionSeconds, 20);
});
