import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';

let fixtureRoot;
let movieDirectory;
let transcodeDirectory;
let server;
let app;
let baseUrl;

const probeOutput = JSON.stringify({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '90' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, width: 1920, height: 1080, avg_frame_rate: '24/1', pix_fmt: 'yuv420p' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000' },
    { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'spa', title: 'Spanish surround' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'English' } },
  ],
});

function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = 'SIGTERM';
    process.nextTick(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  onStart(child);
  return child;
}

function completeFfmpegCheck(child, args, missingEncoder = null) {
  const output = args[0] === '-version'
    ? 'ffmpeg version 7.0.0\n'
    : args[0] === '-encoders'
      ? ` V....D ${missingEncoder === 'libx264' ? 'h264' : 'libx264'} H.264 encoder\n A..... ${missingEncoder === 'aac' ? 'mp3' : 'aac'} AAC encoder\n`
      : ' .E hls Apple HTTP Live Streaming\n';
  child.exitCode = 0;
  process.nextTick(() => {
    child.stdout.end(output);
    child.stderr.end();
    child.emit('close', 0, null);
  });
}

function availableFfmpeg({ missingEncoder = null } = {}) {
  return (_executable, args) => fakeChild((child) => {
    if (args[0] === '-version' || args[0] === '-encoders' || args[0] === '-muxers') {
      completeFfmpegCheck(child, args, missingEncoder);
    }
  });
}

function missingFfmpeg() {
  return () => fakeChild((child) => {
    process.nextTick(() => child.emit('error', Object.assign(new Error('missing binary'), { code: 'ENOENT' })));
  });
}

function fakeFfprobe() {
  return (_executable, args) => fakeChild((child) => {
    process.nextTick(() => {
      child.stdout.end(args[0] === '-version' ? 'ffprobe version 7.0.0\n' : probeOutput);
      child.stderr.end();
      child.emit('close', 0, null);
    });
  });
}

function generatingFfmpeg() {
  return (_executable, args, options) => fakeChild((child) => {
    if (args[0] === '-version' || args[0] === '-encoders' || args[0] === '-muxers') {
      completeFfmpegCheck(child, args);
      return;
    }
    void writeFile(path.join(options.cwd, 'index.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nsegment-000000.m4s\n');
  });
}

function ffmpegWithSubtitleOutput(transcodeArguments) {
  const generate = generatingFfmpeg();
  return (executable, args, options) => {
    if (args.includes('webvtt')) {
      return fakeChild((child) => {
        process.nextTick(() => {
          child.stdout.end('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEmbedded fixture\n');
          child.stderr.end();
          child.emit('close', 0, null);
        });
      });
    }
    if (args.at(-1) === 'index.m3u8') transcodeArguments.push(args);
    return generate(executable, args, options);
  };
}

async function startApp({ ffmpegSpawn = availableFfmpeg(), ffprobeSpawn = fakeFfprobe() } = {}) {
  app = createApp({
    movieDirectory,
    transcodeDirectory,
    ffmpegPath: 'mock-ffmpeg',
    ffprobePath: 'mock-ffprobe',
    ffmpegSpawn,
    ffprobeSpawn,
    clientUrls: ['http://localhost:5173'],
    serveClient: false,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-playback-api-'));
  movieDirectory = path.join(fixtureRoot, 'media');
  transcodeDirectory = path.join(fixtureRoot, 'temporary');
  await mkdir(movieDirectory);
  await writeFile(path.join(movieDirectory, 'sample.mp4'), 'temporary fixture');
});

test.afterEach(async () => {
  if (app) await app.locals.shutdown();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(fixtureRoot, { recursive: true, force: true });
  app = undefined;
  server = undefined;
});

async function getMovieId() {
  const response = await fetch(`${baseUrl}/api/movies`);
  assert.equal(response.status, 200);
  return (await response.json()).movies[0].id;
}

const browserCapabilities = {
  containers: { mp4: true },
  videoCodecs: { h264: true },
  audioCodecs: { aac: true },
  audioProfiles: { aac: { lc: true } },
  videoProfiles: { h264: { high: true } },
  videoLevels: { h264: { high: [40] } },
  mediaCapabilities: { h2641080p: { supported: true } },
};

test('returns a Direct Play decision without disclosing the media path', async () => {
  await startApp();
  const id = await getMovieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capabilities: browserCapabilities, requestKey: 'playback-direct-001' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.decision.strategy, 'direct');
  assert.equal(body.url, `/api/movies/${id}/stream`);
  assert.equal(JSON.stringify(body).includes(movieDirectory), false);
});

test('lists and serves external and embedded subtitles and switches audio without video re-encoding', async () => {
  const subtitlePath = path.join(movieDirectory, 'sample.en.srt');
  const subtitleSource = '1\r\n00:00:01,000 --> 00:00:02,000\r\nCaf\u00e9 fixture\r\n';
  await writeFile(subtitlePath, subtitleSource, 'utf8');
  const transcodeArguments = [];
  await startApp({ ffmpegSpawn: ffmpegWithSubtitleOutput(transcodeArguments) });
  const id = await getMovieId();

  const listed = await fetch(`${baseUrl}/api/movies/${id}/subtitles`);
  assert.equal(listed.status, 200);
  const subtitleList = await listed.json();
  assert.deepEqual(subtitleList.subtitles.map(({ id: trackId, kind }) => ({ id: trackId, kind })), [
    { id: 'embedded-3', kind: 'embedded' },
    { id: 'external-0', kind: 'external' },
  ]);
  assert.equal(JSON.stringify(subtitleList).includes(movieDirectory), false);

  const external = await fetch(`${baseUrl}/api/movies/${id}/subtitles/external-0.vtt`);
  assert.equal(external.headers.get('content-type'), 'text/vtt; charset=utf-8');
  assert.match(await external.text(), /Caf\u00e9 fixture/);
  const embedded = await fetch(`${baseUrl}/api/movies/${id}/subtitles/embedded-3.vtt`);
  assert.match(await embedded.text(), /Embedded fixture/);

  const originalBytes = await readFile(path.join(movieDirectory, 'sample.mp4'));
  const response = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capabilities: browserCapabilities,
      audioStreamIndex: 2,
      requestKey: 'playback-spanish-001',
    }),
  });
  assert.equal(response.status, 200);
  const playback = await response.json();
  assert.equal(playback.decision.strategy, 'audio-transcode');
  assert.equal(playback.metadata.audioStreams.length, 2);
  assert.equal(playback.metadata.audioStreams[1].language, 'spa');
  assert.ok(transcodeArguments.length > 0);
  const args = transcodeArguments[0];
  assert.equal(args[args.indexOf('-map') + 3], '0:2?');
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-b:a')), ['-c:v', 'copy', '-c:a', 'aac']);
  assert.deepEqual(
    await readFile(path.join(movieDirectory, 'sample.mp4')),
    originalBytes,
  );
  assert.equal(await readFile(subtitlePath, 'utf8'), subtitleSource);
  await fetch(`${baseUrl}/api/movies/${id}/playback-sessions/${playback.sessionId}`, { method: 'DELETE' });
});

test('allows a same-host LAN frontend origin forwarded by the Vite development proxy', async () => {
  await startApp();
  const origin = 'http://192.168.1.35:5173';
  const response = await new Promise((resolve, reject) => {
    const requestToServer = request(baseUrl, {
      path: '/api/health',
      headers: {
        Origin: origin,
        Host: new URL(origin).host,
      },
    }, (incomingResponse) => {
      incomingResponse.resume();
      incomingResponse.once('end', () => resolve(incomingResponse));
    });
    requestToServer.once('error', reject);
    requestToServer.end();
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], origin);
});

test('allows the configured localhost frontend origin', async () => {
  await startApp();
  const origin = 'http://localhost:5173';
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: origin },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
});

test('reports safe FFmpeg, FFprobe, encoder, and HLS diagnostics', async () => {
  await startApp();
  const response = await fetch(`${baseUrl}/api/system/diagnostics`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ffmpeg.available, true);
  assert.equal(body.ffmpeg.version, '7.0.0');
  assert.deepEqual(body.ffmpeg.requiredEncoders, { libx264: true, aac: true });
  assert.equal(body.ffmpeg.hlsMuxer, true);
  assert.equal(body.ffprobe.available, true);
  assert.equal(body.ffprobe.version, '7.0.0');
  assert.equal(body.transcodingAvailable, true);
  assert.equal(JSON.stringify(body).includes(fixtureRoot), false);
  assert.equal(JSON.stringify(body).includes('mock-ffmpeg'), false);
});

test('rejects invalid IDs and fallback selections', async () => {
  await startApp();
  const invalidId = await fetch(`${baseUrl}/api/movies/not-an-id/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(invalidId.status, 400);
  const id = await getMovieId();
  const invalidFallback = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fallback: '../path' }),
  });
  assert.equal(invalidFallback.status, 400);
});

test('reports unavailable FFmpeg with an actionable original-file fallback', async () => {
  await startApp({ ffmpegSpawn: missingFfmpeg() });
  const id = await getMovieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capabilities: {
        ...browserCapabilities,
        videoCodecs: { h264: false },
      },
      requestKey: 'playback-unavailable-001',
    }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'FFMPEG_UNAVAILABLE');
  assert.equal(body.decision.transcodingAvailable, false);
  assert.equal(body.fallbackUrl, `/api/movies/${id}/stream`);
  assert.equal(JSON.stringify(body).includes(movieDirectory), false);
});

test('rejects full transcoding when libx264 is missing while exposing the precise diagnostic', async () => {
  await startApp({ ffmpegSpawn: availableFfmpeg({ missingEncoder: 'libx264' }) });
  const id = await getMovieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capabilities: {
        ...browserCapabilities,
        videoCodecs: { h264: false },
      },
      requestKey: 'playback-no-x264-001',
    }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'FFMPEG_UNAVAILABLE');
  assert.equal(body.decision.transcodingAvailable, false);

  const diagnostics = await fetch(`${baseUrl}/api/system/diagnostics`);
  const report = await diagnostics.json();
  assert.equal(report.strategyAvailability.remux, true);
  assert.equal(report.strategyAvailability.fullTranscode, false);
  assert.ok(report.ffmpeg.errors.some((error) => error.includes('libx264')));
});

test('allows an explicit non-destructive original-file fallback', async () => {
  await startApp({ ffmpegSpawn: missingFfmpeg() });
  const id = await getMovieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fallback: 'original' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.decision.strategy, 'direct');
  assert.equal(body.url, `/api/movies/${id}/stream`);
});

test('falls back to the original stream when FFprobe is unavailable', async () => {
  await startApp({
    ffprobeSpawn: () => fakeChild((child) => {
      process.nextTick(() => child.emit('error', Object.assign(new Error('missing probe'), { code: 'ENOENT' })));
    }),
  });
  const id = await getMovieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capabilities: browserCapabilities }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.decision.strategy, 'direct');
  assert.match(body.warning, /FFprobe is unavailable/);
});

test('creates, heartbeats, serves, and stops a managed playback session', async () => {
  await startApp({ ffmpegSpawn: generatingFfmpeg() });
  const id = await getMovieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capabilities: {
        ...browserCapabilities,
        videoCodecs: { h264: false },
      },
      requestKey: 'playback-managed-001',
    }),
  });
  assert.equal(response.status, 200);
  const playback = await response.json();
  assert.equal(playback.decision.strategy, 'full-transcode');

  const statusUrl = `${baseUrl}/api/movies/${id}/playback-sessions/${playback.sessionId}`;
  const statusResponse = await fetch(statusUrl);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).state, 'running');

  const playlist = await fetch(`${statusUrl}/index.m3u8`);
  assert.equal(playlist.status, 200);
  assert.match(playlist.headers.get('content-type'), /^application\/vnd\.apple\.mpegurl(?:;|$)/);
  assert.match(await playlist.text(), /EXTM3U/);

  const stopped = await fetch(statusUrl, { method: 'DELETE' });
  assert.equal(stopped.status, 204);
  assert.equal((await fetch(statusUrl)).status, 404);
});

test('the unused legacy transcode URL does not create playback sessions', async () => {
  await startApp();
  const id = await getMovieId();
  const response = await fetch(`${baseUrl}/api/movies/${id}/transcode`);
  assert.equal(response.status, 404);
});
