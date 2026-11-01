import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';
import {
  getMovieMetadata,
  getSeriesSeasonMetadata,
} from '../services/metadata.js';

function jsonResponse(data) {
  return { ok: true, json: async () => data };
}

test('passes the requested year to movie search and retries without it on a miss', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(url);
    calls.push(parsedUrl);
    if (parsedUrl.pathname === '/3/search/movie' && parsedUrl.searchParams.has('year')) {
      return jsonResponse({ results: [] });
    }
    if (parsedUrl.pathname === '/3/search/movie') {
      return jsonResponse({
        results: [{
          id: 123,
          release_date: '2021-06-01',
          overview: 'A sample film',
          genre_ids: [28],
        }],
      });
    }
    return jsonResponse({ runtime: 100, genres: [{ name: 'Action' }] });
  };
  try {
    const metadata = await getMovieMetadata('Year Test Film', 'v3-year-test', { year: 2021 });
    assert.equal(calls[0].searchParams.get('year'), '2021');
    assert.equal(calls[1].searchParams.has('year'), false);
    assert.equal(metadata.releaseYear, 2021);
    assert.deepEqual(metadata.genres, ['Action']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses an eight-second abort signal and reports timeout errors clearly', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  let timeoutMs;
  AbortSignal.timeout = (milliseconds) => {
    timeoutMs = milliseconds;
    return AbortSignal.abort(new DOMException('Request timed out', 'TimeoutError'));
  };
  globalThis.fetch = async (_url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw signal.reason;
  };
  try {
    await assert.rejects(
      getMovieMetadata('Timeout Test Film', 'v3-timeout-test'),
      /TMDB request timed out after 8 seconds/,
    );
    assert.equal(timeoutMs, 8_000);
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

test('caches successful movie metadata and deduplicates concurrent requests', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    callCount += 1;
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/3/search/movie') {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ results: [{ id: 124, overview: 'Cached', release_date: '2022-01-01' }] });
    }
    return jsonResponse({ runtime: 90, genres: [] });
  };
  try {
    const first = getMovieMetadata('Cache Test Film', 'v3-cache-test');
    const duplicate = getMovieMetadata('Cache Test Film', 'v3-cache-test');
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    assert.deepEqual(duplicateResult, firstResult);
    assert.equal(callCount, 2);

    await getMovieMetadata('Cache Test Film', 'v3-cache-test');
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caches the series search ID across season metadata requests', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(url);
    calls.push(parsedUrl.pathname);
    if (parsedUrl.pathname === '/3/search/tv') return jsonResponse({ results: [{ id: 567 }] });
    return jsonResponse({ episodes: [] });
  };
  try {
    await getSeriesSeasonMetadata('Cached Search Series', 1, 'v3-series-cache-test');
    await getSeriesSeasonMetadata('Cached Search Series', 2, 'v3-series-cache-test');
    assert.equal(calls.filter((pathname) => pathname === '/3/search/tv').length, 1);
    assert.equal(calls.filter((pathname) => pathname.includes('/season/')).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses query parameters for v3 keys and bearer auth for v4 tokens', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (new URL(url).pathname === '/3/search/movie') {
      return jsonResponse({ results: [{ id: requests.length, release_date: '2020-01-01' }] });
    }
    return jsonResponse({ runtime: 90, genres: [] });
  };
  try {
    await getMovieMetadata('V3 Key Film', 'v3-style-key-test');
    assert.equal(requests[0].url.searchParams.get('api_key'), 'v3-style-key-test');
    assert.equal(requests[0].options.headers.Authorization, undefined);

    requests.length = 0;
    const token = 'eyJv4-style-token-test';
    await getMovieMetadata('V4 Key Film', token);
    assert.equal(requests[0].url.searchParams.has('api_key'), false);
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns a soft movie metadata failure from the API when TMDB fails', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-metadata-api-'));
  const mediaDirectory = path.join(fixtureRoot, 'media');
  await mkdir(mediaDirectory);
  await writeFile(path.join(mediaDirectory, 'Metadata Failure Film (2021).mp4'), 'fixture');
  const originalFetch = globalThis.fetch;
  const app = createApp({
    movieDirectory: mediaDirectory,
    tmdbApiKey: 'v3-endpoint-error-test',
    serveClient: false,
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const listResponse = await originalFetch(`${baseUrl}/api/movies`);
    const { movies } = await listResponse.json();
    globalThis.fetch = async () => { throw new Error('TMDB is offline'); };
    const response = await originalFetch(`${baseUrl}/api/movies/${movies[0].id}/metadata`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      metadata: null,
      metadataError: 'Online movie metadata is temporarily unavailable.',
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.locals.shutdown();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
