import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';
import { parseByteRange } from '../controllers/movies.js';

let fixtureRoot;
let server;
let baseUrl;
let readStreams;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-http-'));
  await mkdir(path.join(fixtureRoot, 'nested'));
  await writeFile(path.join(fixtureRoot, 'nested', 'sample.mp4'), Buffer.from('0123456789'));
  readStreams = [];
  server = createApp({
    movieDirectory: fixtureRoot,
    clientUrls: ['http://localhost:5173'],
    readStreamFactory: (...args) => {
      const stream = createReadStream(...args);
      readStreams.push(stream);
      return stream;
    },
    serveClient: false,
  })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function movieId() {
  const response = await fetch(`${baseUrl}/api/movies`);
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.movies[0].id;
}

test('lists movies without disclosing absolute filesystem paths', async () => {
  const response = await fetch(`${baseUrl}/api/movies`);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.movies[0].title, 'sample');
  assert.equal(body.movies[0].relativePath, 'nested/sample.mp4');
  assert.equal(JSON.stringify(body).includes(fixtureRoot), false);
});

test('streams full response and requested byte ranges with correct headers', async () => {
  const id = await movieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/stream`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('content-length'), '4');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), '2345');

  const full = await fetch(`${baseUrl}/api/movies/${id}/stream`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '10');
  assert.equal(await full.text(), '0123456789');
});

test('destroys the file stream when a range request is aborted midway', async () => {
  const id = await movieId();
  const fileSize = 64 * 1024 * 1024;
  await writeFile(path.join(fixtureRoot, 'nested', 'sample.mp4'), Buffer.alloc(fileSize, 97));
  const abortController = new AbortController();
  const response = await fetch(`${baseUrl}/api/movies/${id}/stream`, {
    headers: { Range: `bytes=0-${fileSize - 1}` },
    signal: abortController.signal,
  });
  assert.equal(response.status, 206);
  assert.equal(readStreams.length, 1);
  const stream = readStreams[0];
  const streamClosed = new Promise((resolve) => stream.once('close', resolve));
  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  abortController.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  await streamClosed;
  assert.equal(stream.destroyed, true);
  assert.ok(stream.bytesRead < fileSize, `expected an incomplete read, got ${stream.bytesRead} bytes`);
});

test('rejects invalid IDs, unknown IDs, and unsatisfiable ranges', async () => {
  assert.equal((await fetch(`${baseUrl}/api/movies/..%2F..%2Fsecret/stream`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/movies/not-an-id/stream`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/movies/${'a'.repeat(24)}/stream`)).status, 404);
  const id = await movieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/stream`, { headers: { Range: 'bytes=50-60' } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */10');
});

test('rejects cross-origin browser requests outside the configured client origin', async () => {
  const response = await fetch(`${baseUrl}/api/movies`, {
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(response.status, 403);
});

test('returns not found when a catalogued file is removed', async () => {
  const id = await movieId();
  await rm(path.join(fixtureRoot, 'nested', 'sample.mp4'));
  const response = await fetch(`${baseUrl}/api/movies/${id}/stream`);
  assert.equal(response.status, 404);
});

test('parses suffix and open-ended ranges and refuses malformed ranges', () => {
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=not-a-range', 10), { invalid: true });
  assert.deepEqual(parseByteRange('bytes=1-2,4-5', 10), { invalid: true });
});
