import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isWithinDirectory, scanLibrary, VIDEO_TYPES } from '../services/library.js';

let fixtureRoot;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-test-'));
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('scans supported videos recursively and ignores other files', async () => {
  await mkdir(path.join(fixtureRoot, 'nested', 'second'), { recursive: true });
  await writeFile(path.join(fixtureRoot, 'nested', 'The.Movie.mkv'), Buffer.from('video'));
  await writeFile(path.join(fixtureRoot, 'nested', 'second', 'clip.MP4'), Buffer.from('more'));
  await writeFile(path.join(fixtureRoot, 'notes.txt'), 'not a video');

  const { movies } = await scanLibrary(fixtureRoot);
  assert.equal(VIDEO_TYPES.size, 9);
  assert.equal(movies.length, 2);
  assert.deepEqual(movies.map((movie) => movie.title), ['clip', 'The Movie']);
  assert.equal(movies[1].size, 5);
  assert.equal(movies[1].extension, '.mkv');
  assert.equal(movies[1].releaseYear, null);
  assert.ok(movies.every((movie) => /^[a-f0-9]{24}$/.test(movie.id)));
});

test('extracts a plausible release year for local search', async () => {
  await writeFile(path.join(fixtureRoot, 'A.Great.Film.2024.1080p.mkv'), Buffer.from('video'));
  const { movies } = await scanLibrary(fixtureRoot);
  assert.equal(movies[0].releaseYear, 2024);
  assert.equal(movies[0].title, 'A Great Film');
});

test('removes year delimiters from parenthesized and bracketed movie titles', async () => {
  await writeFile(path.join(fixtureRoot, 'The Harbor (2024).mp4'), Buffer.from('video'));
  await writeFile(path.join(fixtureRoot, 'Quiet Road [2022].mp4'), Buffer.from('video'));
  const { movies } = await scanLibrary(fixtureRoot);
  assert.deepEqual(movies.map((movie) => movie.title), ['Quiet Road', 'The Harbor']);
});

test('removes release and encoding details from displayed movie titles', async () => {
  await writeFile(path.join(fixtureRoot, '01 The.Raid.Redemption.2011.Dual.Audio.1080p.mp4'), Buffer.from('video'));
  const { movies } = await scanLibrary(fixtureRoot);
  assert.equal(movies[0].title, 'The Raid Redemption');
});

test('recognizes every required video extension case-insensitively', async () => {
  for (const extension of VIDEO_TYPES) {
    await writeFile(path.join(fixtureRoot, `movie${extension}`), Buffer.from('video'));
  }
  await writeFile(path.join(fixtureRoot, 'uppercase.MP4'), Buffer.from('video'));
  const { movies } = await scanLibrary(fixtureRoot);
  assert.equal(movies.length, VIDEO_TYPES.size + 1);
});

test('rejects a missing directory and a file used as the library root', async () => {
  await assert.rejects(scanLibrary(path.join(fixtureRoot, 'missing')), { code: 'ENOENT' });
  const file = path.join(fixtureRoot, 'file.txt');
  await writeFile(file, 'not a folder');
  await assert.rejects(scanLibrary(file), /not a directory/i);
  await assert.rejects(scanLibrary(path.parse(path.resolve(fixtureRoot)).root), /cannot be a filesystem root/i);
});

test('path boundary check rejects traversal and accepts files inside the root', () => {
  assert.equal(isWithinDirectory('D:\\Movies', 'D:\\Movies\\nested\\film.mp4'), true);
  assert.equal(isWithinDirectory('D:\\Movies', 'D:\\Movies-old\\film.mp4'), false);
  assert.equal(isWithinDirectory('D:\\Movies', 'D:\\Windows\\win.ini'), false);
});
