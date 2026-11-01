import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createMediaToolDiagnostics } from '../services/playback/tool-diagnostics.js';

function fakeSpawn({ missingEncoder = null, missingTool = null } = {}, calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      if (missingTool === executable) {
        child.emit('error', Object.assign(new Error('not available'), { code: 'ENOENT' }));
        return;
      }
      const output = args[0] === '-version'
        ? `${executable.toLowerCase().includes('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 7.1.2\n`
        : args[0] === '-encoders'
          ? ` V....D ${missingEncoder === 'libx264' ? 'h264' : 'libx264'} H.264 encoder\n A..... ${missingEncoder === 'aac' ? 'mp3' : 'aac'} AAC encoder\n`
          : ' .E hls Apple HTTP Live Streaming\n';
      child.stdout.end(output);
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
}

test('diagnoses executable paths with spaces and requires the software encoders and HLS muxer', async () => {
  const calls = [];
  const diagnostics = createMediaToolDiagnostics({
    ffmpegPath: 'C:\\Program Files\\MovieStream Tools\\ffmpeg.exe',
    ffprobePath: 'C:\\Program Files\\MovieStream Tools\\ffprobe.exe',
    ffmpegSpawn: fakeSpawn({}, calls),
    ffprobeSpawn: fakeSpawn({}, calls),
  });

  const result = await diagnostics.getDiagnostics();
  assert.equal(result.ffmpeg.available, true);
  assert.equal(result.ffmpeg.version, '7.1.2');
  assert.equal(result.ffmpeg.configuration, 'explicit path');
  assert.deepEqual(result.ffmpeg.requiredEncoders, { libx264: true, aac: true });
  assert.equal(result.ffmpeg.hlsMuxer, true);
  assert.equal(result.ffprobe.available, true);
  assert.equal(result.ffprobe.version, '7.1.2');
  assert.equal(result.transcodingAvailable, true);
  assert.ok(calls.every(({ options }) => options.windowsHide && options.shell === undefined));
  assert.ok(calls.some(({ executable, args }) => (
    executable === 'C:\\Program Files\\MovieStream Tools\\ffmpeg.exe'
      && args[0] === '-encoders'
  )));
  assert.equal(JSON.stringify(result).includes('Program Files'), false);
});

test('reports missing required encoders as unavailable for transcoding', async () => {
  const result = await createMediaToolDiagnostics({
    ffmpegSpawn: fakeSpawn({ missingEncoder: 'libx264' }),
    ffprobeSpawn: fakeSpawn(),
  }).getDiagnostics();

  assert.equal(result.ffmpeg.available, true);
  assert.equal(result.ffmpeg.requiredEncoders.libx264, false);
  assert.equal(result.ffmpeg.requiredEncoders.aac, true);
  assert.equal(result.transcodingAvailable, false);
  assert.deepEqual(result.strategyAvailability, {
    remux: true,
    audioTranscode: true,
    fullTranscode: false,
  });
  assert.ok(result.ffmpeg.errors.some((error) => error.includes('libx264')));
});

test('reports missing executables without exposing their configured paths', async () => {
  const result = await createMediaToolDiagnostics({
    ffmpegPath: 'C:\\Private Folder\\ffmpeg.exe',
    ffprobePath: 'C:\\Private Folder\\ffprobe.exe',
    ffmpegSpawn: fakeSpawn({ missingTool: 'C:\\Private Folder\\ffmpeg.exe' }),
    ffprobeSpawn: fakeSpawn({ missingTool: 'C:\\Private Folder\\ffprobe.exe' }),
  }).getDiagnostics();

  assert.equal(result.ffmpeg.available, false);
  assert.equal(result.ffprobe.available, false);
  assert.equal(result.transcodingAvailable, false);
  assert.match(result.ffmpeg.errors[0], /not found/i);
  assert.match(result.ffprobe.errors[0], /not found/i);
  assert.equal(JSON.stringify(result).includes('Private Folder'), false);
});

test('caches concurrent and recent diagnostics instead of repeatedly launching tools', async () => {
  const calls = [];
  const diagnostics = createMediaToolDiagnostics({
    ffmpegSpawn: fakeSpawn({}, calls),
    ffprobeSpawn: fakeSpawn({}, calls),
  });
  const [first, second] = await Promise.all([
    diagnostics.getDiagnostics(),
    diagnostics.getDiagnostics(),
  ]);
  assert.equal(first, second);
  assert.equal(calls.length, 4);
  await diagnostics.getDiagnostics();
  assert.equal(calls.length, 4);
});
