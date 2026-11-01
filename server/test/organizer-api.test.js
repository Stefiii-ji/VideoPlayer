import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';

let fixtureRoot;
let mediaRoot;
let app;
let server;
let baseUrl;

async function startServer() {
  app = createApp({
    movieDirectory: mediaRoot,
    metadataFile: path.join(fixtureRoot, 'state', 'library-state.json'),
    serveClient: false,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await app.locals.shutdown();
  server = null;
  app = null;
}

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-organizer-api-'));
  mediaRoot = path.join(fixtureRoot, 'media');
  await mkdir(mediaRoot);
  await writeFile(path.join(mediaRoot, 'Arrival.2016.mkv'), 'movie fixture');
  await startServer();
});

test.afterEach(async () => {
  await stopServer();
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('organizer scan, details, proposals, and manual review expose relative paths only', async () => {
  const overview = await (await fetch(`${baseUrl}/api/organizer/overview`)).json();
  assert.equal(overview.status, 'not_scanned');

  const scanResponse = await fetch(`${baseUrl}/api/organizer/scan`, { method: 'POST' });
  assert.equal(scanResponse.status, 201);
  const scan = await scanResponse.json();
  assert.equal(scan.status, 'completed');
  assert.equal(scan.classifications.movie, 1);

  const detailResponse = await fetch(`${baseUrl}/api/organizer/scan/${scan.scanId}?limit=10`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.items[0].relativePath, 'Arrival.2016.mkv');
  const filtered = await (await fetch(
    `${baseUrl}/api/organizer/scan/${scan.scanId}?classification=movie&search=arrival`,
  )).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].title, 'Arrival');
  const unsupportedFilter = await fetch(`${baseUrl}/api/organizer/scan/${scan.scanId}?classification=bad`);
  assert.equal(unsupportedFilter.status, 400);

  const proposalResponse = await fetch(`${baseUrl}/api/organizer/proposals?scanId=${scan.scanId}`);
  assert.equal(proposalResponse.status, 200);
  const plan = await proposalResponse.json();
  assert.equal(plan.proposals[0].proposedDestinationRelativePath, 'Movies/Arrival (2016)/Arrival (2016).mkv');
  assert.equal(JSON.stringify({ scan, detail, plan }).toLowerCase().includes(fixtureRoot.toLowerCase()), false);

  const reviewed = await fetch(`${baseUrl}/api/organizer/proposals/${plan.proposals[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewStatus: 'reviewed', note: 'Checked locally.' }),
  });
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json()).reviewStatus, 'reviewed');
  assert.equal((await fetch(`${baseUrl}/api/organizer/move`, { method: 'POST' })).status, 404);
});

test('organizer validates scan pagination, classifications, and import traversal', async () => {
  const scan = await (await fetch(`${baseUrl}/api/organizer/scan`, { method: 'POST' })).json();
  const badPagination = await fetch(`${baseUrl}/api/organizer/scan/${scan.scanId}?limit=999`);
  assert.equal(badPagination.status, 400);

  const item = (await (await fetch(`${baseUrl}/api/organizer/scan/${scan.scanId}`)).json()).items[0];
  const badCorrection = await fetch(`${baseUrl}/api/organizer/scan/${scan.scanId}/items/${item.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classification: 'delete' }),
  });
  assert.equal(badCorrection.status, 400);

  const traversalImport = await fetch(
    `${baseUrl}/api/organizer/import?scanId=${scan.scanId}&filename=inventory.csv`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'Name,RelativePath\nOutside,../outside.mkv\n',
    },
  );
  assert.equal(traversalImport.status, 400);
  assert.match((await traversalImport.json()).error, /invalid relative path/i);

  const absoluteImport = await fetch(
    `${baseUrl}/api/organizer/import?scanId=${scan.scanId}&filename=inventory.csv`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'Name,RelativePath\nOutside,F:\\\\outside.mkv\n',
    },
  );
  assert.equal(absoluteImport.status, 400);
});

test('inventory upload compares reference rows without changing scanned files', async () => {
  const scan = await (await fetch(`${baseUrl}/api/organizer/scan`, { method: 'POST' })).json();
  const response = await fetch(
    `${baseUrl}/api/organizer/import?scanId=${scan.scanId}&filename=MovieInventory.csv`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'Name,RelativePath,Folder,Extension,SizeGB,SizeMB,Modified\nArrival.2016.mkv,Arrival.2016.mkv,,.mkv,,,today\n',
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.inventory.matchedCount, 1);
  assert.equal(result.inventory.recordCount, 1);
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(mediaRoot, 'Arrival.2016.mkv'), 'utf8'), 'movie fixture');
});
