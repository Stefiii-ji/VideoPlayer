import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFfprobeService, parseProbeOutput } from '../services/playback/ffprobe.js';

let fixtureRoot;
let mediaPath;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-ffprobe-'));
  mediaPath = path.join(fixtureRoot, 'sample.mp4');
  await writeFile(mediaPath, 'temporary media fixture');
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function probeDocument() {
  return JSON.stringify({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '90.5', bit_rate: '1200000' },
    streams: [
      {
        index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40,
        width: 1920, height: 1080, avg_frame_rate: '24000/1001', pix_fmt: 'yuv420p',
      },
      { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
    ],
  });
}

function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  onStart(child);
  return child;
}

function successfulProbeSpawn(output, count = { value: 0 }) {
  return (_executable, args) => {
    count.value += 1;
    return fakeChild((child) => {
      process.nextTick(() => {
        child.stdout.end(output);
        child.stderr.end();
        child.emit('close', 0, null);
      });
    });
  };
}

test('parses structured stream metadata without exposing the source path', async () => {
  const service = createFfprobeService({ spawnProcess: successfulProbeSpawn(probeDocument()) });
  const metadata = await service.probe(mediaPath);
  assert.equal(metadata.container, 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.equal(metadata.duration, 90.5);
  assert.equal(metadata.fileExtension, '.mp4');
  assert.equal(metadata.video.codec, 'h264');
  assert.equal(metadata.video.frameRate, 24000 / 1001);
  assert.equal(metadata.video.bitDepth, 8);
  assert.equal(metadata.audioStreams[0].sampleRate, 48000);
  assert.deepEqual(metadata.subtitleStreams.map((stream) => stream.language), ['eng']);
  assert.equal(JSON.stringify(metadata).includes(fixtureRoot), false);
});

test('caches probe results by file identity and invalidates after a file changes', async () => {
  const calls = { value: 0 };
  const service = createFfprobeService({
    spawnProcess: successfulProbeSpawn(probeDocument(), calls),
  });
  await service.probe(mediaPath);
  await service.probe(mediaPath);
  assert.equal(calls.value, 1);
  await writeFile(mediaPath, 'a changed temporary media fixture with another size');
  await service.probe(mediaPath);
  assert.equal(calls.value, 2);
});

test('reports malformed FFprobe JSON explicitly', () => {
  assert.throws(
    () => parseProbeOutput('{broken', 10),
    (error) => error.code === 'FFPROBE_INVALID_OUTPUT',
  );
});

test('rejects malformed FFprobe stream entries', () => {
  assert.throws(
    () => parseProbeOutput(JSON.stringify({ format: {}, streams: [null] }), 10),
    (error) => error.code === 'FFPROBE_INVALID_OUTPUT',
  );
});

test('reports invalid media when FFprobe exits unsuccessfully', async () => {
  const service = createFfprobeService({
    spawnProcess: () => fakeChild((child) => {
      process.nextTick(() => {
        child.stderr.end('Invalid data found');
        child.stdout.end();
        child.emit('close', 1, null);
      });
    }),
  });
  await assert.rejects(service.probe(mediaPath), { code: 'FFPROBE_INVALID_MEDIA' });
});

test('reports missing FFprobe executables without leaking process details', async () => {
  const service = createFfprobeService({
    spawnProcess: () => fakeChild((child) => {
      process.nextTick(() => child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' })));
    }),
  });
  await assert.rejects(service.probe(mediaPath), {
    code: 'FFPROBE_UNAVAILABLE',
    message: /Configure FFPROBE_PATH/,
  });
});

test('times out a hung FFprobe process', async () => {
  let killed = false;
  const service = createFfprobeService({
    timeoutMs: 5,
    spawnProcess: () => fakeChild((child) => {
      child.kill = () => { killed = true; return true; };
    }),
  });
  await assert.rejects(service.probe(mediaPath), { code: 'FFPROBE_TIMEOUT' });
  assert.equal(killed, true);
});

test('rejects probe metadata without a video stream', () => {
  assert.throws(
    () => parseProbeOutput(JSON.stringify({ format: {}, streams: [] }), 10),
    (error) => error.code === 'FFPROBE_INVALID_MEDIA',
  );
});
