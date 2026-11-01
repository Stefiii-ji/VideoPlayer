import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';

let fixtureRoot;
let movieDirectory;
let server;
let app;
let baseUrl;

async function startApp(accessToken = '') {
  app = createApp({
    movieDirectory,
    accessToken,
    serveClient: false,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-auth-'));
  movieDirectory = path.join(fixtureRoot, 'media');
  await mkdir(movieDirectory);
});

test.afterEach(async () => {
  if (app) await app.locals.shutdown();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(fixtureRoot, { recursive: true, force: true });
  app = undefined;
  server = undefined;
});

test('does not require authentication when no access token is configured', async () => {
  await startApp();

  const status = await fetch(`${baseUrl}/api/auth/status`);
  assert.deepEqual(await status.json(), { required: false, authenticated: false });
  assert.equal((await fetch(`${baseUrl}/api/movies`)).status, 200);
});

test('requires a valid cookie and accepts the configured token through login', async () => {
  await startApp('test-access-token');

  const status = await fetch(`${baseUrl}/api/auth/status`);
  assert.deepEqual(await status.json(), { required: true, authenticated: false });
  assert.equal((await fetch(`${baseUrl}/api/movies`)).status, 401);

  const wrongLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  });
  assert.equal(wrongLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test-access-token' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(';', 1)[0];

  const authenticatedStatus = await fetch(`${baseUrl}/api/auth/status`, {
    headers: { Cookie: cookie },
  });
  assert.deepEqual(await authenticatedStatus.json(), { required: true, authenticated: true });
  assert.equal((await fetch(`${baseUrl}/api/movies`, { headers: { Cookie: cookie } })).status, 200);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('keeps GET /api/health public when authentication is required', async () => {
  await startApp('test-access-token');

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(`${baseUrl}/api/health`, { method: 'POST' })).status, 401);
});

test('rate limits repeated login failures', async () => {
  await startApp('test-access-token');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  });
  assert.equal(limited.status, 429);
});
