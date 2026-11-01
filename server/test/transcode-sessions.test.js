import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTranscodeSessionManager } from '../services/playback/session-manager.js';

let fixtureRoot;
let mediaDirectory;
let tempDirectory;
let mediaPath;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-sessions-'));
  mediaDirectory = path.join(fixtureRoot, 'media');
  tempDirectory = path.join(fixtureRoot, 'temporary');
  await mkdir(mediaDirectory);
  mediaPath = path.join(mediaDirectory, 'sample.mkv');
  await writeFile(mediaPath, 'original media fixture');
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function fakeSpawn({ fail = false, writePlaylist = true, missingEncoder = null, onKill = () => {} } = {}) {
  return (_executable, args, options) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      onKill();
      child.signalCode = 'SIGTERM';
      process.nextTick(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    if (args[0] === '-version') {
      child.exitCode = 0;
      process.nextTick(() => {
        child.stdout.end('ffmpeg version 7.0.0\n');
        child.emit('close', 0, null);
      });
      return child;
    }
    if (args[0] === '-encoders') {
      child.exitCode = 0;
      process.nextTick(() => {
        child.stdout.end(` V....D ${missingEncoder === 'libx264' ? 'h264' : 'libx264'} H.264 encoder\n A..... ${missingEncoder === 'aac' ? 'mp3' : 'aac'} AAC encoder\n`);
        child.emit('close', 0, null);
      });
      return child;
    }
    if (args[0] === '-muxers') {
      child.exitCode = 0;
      process.nextTick(() => {
        child.stdout.end(' .E hls Apple HTTP Live Streaming\n');
        child.emit('close', 0, null);
      });
      return child;
    }
    if (fail) {
      child.exitCode = 1;
      process.nextTick(() => {
        child.stderr.end('private source path must not be returned');
        child.emit('close', 1, null);
      });
      return child;
    }
    if (!writePlaylist) return child;
    void (async () => {
      await writeFile(path.join(options.cwd, 'init.mp4'), 'init');
      await writeFile(path.join(options.cwd, 'segment-000000.m4s'), 'segment');
      await writeFile(path.join(options.cwd, 'index.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nsegment-000000.m4s\n');
    })();
    return child;
  };
}

function createManager(options = {}) {
  return createTranscodeSessionManager({
    mediaDirectory,
    tempDirectory,
    spawnProcess: fakeSpawn(options),
    ...options,
  });
}

function createOptions(movieId, requestKey = `request-${Math.random().toString(36).slice(2, 14)}`) {
  return {
    movieId,
    inputPath: mediaPath,
    strategy: 'full-transcode',
    requestKey,
  };
}

test('creates an isolated HLS session and serves only its validated assets', async () => {
  const manager = createManager();
  try {
    const session = await manager.create(createOptions('a'.repeat(24)));
    assert.match(session.id, /^[0-9a-f-]{36}$/i);
    assert.notEqual(session.directory, mediaDirectory);
    assert.equal(manager.activeCount, 1);
    const playlist = await manager.readAsset('a'.repeat(24), session.id, 'index.m3u8');
    assert.match(playlist.body, /EXTM3U/);
    assert.equal(playlist.contentType, 'application/vnd.apple.mpegurl');
    const init = await manager.readAsset('a'.repeat(24), session.id, 'init.mp4');
    assert.equal(init.contentType, 'video/mp4');
    assert.equal((await readFile(path.join(session.directory, 'segment-000000.m4s'), 'utf8')), 'segment');
    await assert.rejects(manager.readAsset('b'.repeat(24), session.id, 'index.m3u8'), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(manager.readAsset('a'.repeat(24), session.id, '..'), { code: 'INVALID_SESSION_ASSET' });
  } finally {
    await manager.dispose();
  }
});

test('deduplicates repeated transcode requests with the same movie and request key', async () => {
  let processCount = 0;
  const spawn = fakeSpawn();
  const deduplicatingManager = createTranscodeSessionManager({
    mediaDirectory,
    tempDirectory,
    spawnProcess: (...args) => {
      processCount += 1;
      return spawn(...args);
    },
  });
  try {
    const options = createOptions('c'.repeat(24), 'request-deduplicate');
    const [first, second] = await Promise.all([
      deduplicatingManager.create(options),
      deduplicatingManager.create(options),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(processCount, 4);
  } finally {
    await deduplicatingManager.dispose();
  }
});

test('enforces the configured concurrent-session limit', async () => {
  const manager = createManager({ maxConcurrent: 1 });
  try {
    await manager.create(createOptions('d'.repeat(24), 'request-first-session'));
    await assert.rejects(
      manager.create(createOptions('e'.repeat(24), 'request-second-session')),
      { code: 'TRANSCODE_LIMIT', status: 429 },
    );
  } finally {
    await manager.dispose();
  }
});

test('allows remux when libx264 is missing but rejects full video transcoding', async () => {
  const manager = createManager({ missingEncoder: 'libx264' });
  try {
    const remux = await manager.create({
      ...createOptions('a'.repeat(24), 'request-remux-without-x264'),
      strategy: 'remux',
    });
    assert.equal(remux.strategy, 'remux');
    await manager.stopSession(remux.id);
    await assert.rejects(
      manager.create({
        ...createOptions('b'.repeat(24), 'request-full-without-x264'),
        strategy: 'full-transcode',
      }),
      { code: 'FFMPEG_UNAVAILABLE', status: 503 },
    );
  } finally {
    await manager.dispose();
  }
});

test('rejects source paths outside the configured media root', async () => {
  const outsidePath = path.join(fixtureRoot, 'outside.mkv');
  await writeFile(outsidePath, 'must not be transcoded');
  const manager = createManager();
  await assert.rejects(
    manager.create({ ...createOptions('3'.repeat(24)), inputPath: outsidePath }),
    { code: 'PATH_OUTSIDE_LIBRARY', status: 403 },
  );
  await manager.dispose();
});

test('heartbeats extend active sessions and expired sessions are cleaned up', async () => {
  let time = Date.now();
  const manager = createTranscodeSessionManager({
    mediaDirectory,
    tempDirectory,
    spawnProcess: fakeSpawn(),
    sessionTtlMs: 2_000,
    now: () => time,
  });
  const movieId = '4'.repeat(24);
  const session = await manager.create(createOptions(movieId));
  time += 1_500;
  assert.equal(manager.touchSession(movieId, session.id).state, 'running');
  time += 1_500;
  assert.equal(manager.getSession(movieId, session.id).id, session.id);
  time += 2_001;
  assert.throws(() => manager.getSession(movieId, session.id), { code: 'SESSION_EXPIRED' });
  await manager.dispose();
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('failed sessions cannot extend their expiry through status checks', async () => {
  let time = Date.now();
  const manager = createTranscodeSessionManager({
    mediaDirectory,
    tempDirectory,
    spawnProcess: fakeSpawn(),
    sessionTtlMs: 2_000,
    now: () => time,
  });
  const movieId = '6'.repeat(24);
  const session = await manager.create(createOptions(movieId));
  session.process.exitCode = 1;
  session.process.emit('close', 1, null);
  const failedAt = session.lastAccessAt;
  time += 1_500;
  assert.equal(manager.touchSession(movieId, session.id).state, 'failed');
  assert.equal(session.lastAccessAt, failedAt);
  time += 501;
  assert.throws(() => manager.getSession(movieId, session.id), { code: 'SESSION_EXPIRED' });
  await manager.dispose();
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('removes temporary files and reports FFmpeg failures without source paths', async () => {
  const manager = createManager({ fail: true });
  await assert.rejects(
    manager.create(createOptions('f'.repeat(24))),
    (error) => error.code === 'FFMPEG_FAILED' && !error.message.includes(mediaDirectory),
  );
  assert.deepEqual(await readdir(tempDirectory), []);
  await manager.dispose();
});

test('enforces FFmpeg process timeouts and cleans partial session output', async () => {
  const manager = createManager({ writePlaylist: false, processTimeoutMs: 20 });
  await assert.rejects(
    manager.create(createOptions('5'.repeat(24))),
    (error) => error.code === 'FFMPEG_FAILED' && /time limit/.test(error.message),
  );
  await manager.dispose();
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('kills running processes and removes all session files during shutdown', async () => {
  let killCount = 0;
  const manager = createManager({ onKill: () => { killCount += 1; } });
  await manager.create(createOptions('1'.repeat(24)));
  await manager.dispose();
  assert.equal(killCount, 1);
  assert.deepEqual(await readdir(tempDirectory), []);
  assert.equal((await readFile(mediaPath, 'utf8')), 'original media fixture');
});

test('removes stale session directories safely during initialization', async () => {
  await mkdir(tempDirectory);
  const staleDirectory = path.join(tempDirectory, 'session-stale');
  await mkdir(staleDirectory);
  await writeFile(path.join(staleDirectory, 'old.tmp'), 'stale');
  const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(staleDirectory, oldTime, oldTime);
  const manager = createManager({ staleAgeMs: 60 * 60 * 1000 });
  try {
    await manager.create(createOptions('2'.repeat(24)));
    await assert.rejects(readFile(path.join(staleDirectory, 'old.tmp')));
  } finally {
    await manager.dispose();
  }
});
