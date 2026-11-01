import assert from 'node:assert/strict';
import test from 'node:test';
import { decidePlayback, ffmpegArguments, sanitizeCapabilities } from '../services/playback/decision.js';

const supportedBrowser = {
  containers: { mp4: true, webm: true },
  videoCodecs: { h264: true, hevc: false, vp9: true },
  audioCodecs: { aac: true, ac3: false },
  audioProfiles: { aac: { lc: true } },
  videoProfiles: { h264: { baseline: true, main: true, high: true } },
  videoLevels: { h264: { high: [40, 41, 51, 52] } },
  mediaCapabilities: {
    h2641080p: { supported: true, smooth: true, powerEfficient: true },
    h2644k: { supported: true, smooth: true, powerEfficient: true },
  },
};

function media({ container = 'mov,mp4,m4a,3gp,3g2,mj2', extension = '.mp4', video = {}, audio = {} } = {}) {
  return {
    container,
    fileExtension: extension,
    video: {
      codec: 'h264',
      profile: 'High',
      level: 40,
      width: 1920,
      height: 1080,
      frameRate: 24,
      pixelFormat: 'yuv420p',
      bitDepth: 8,
      ...video,
    },
    audioStreams: [{ codec: 'aac', profile: 'LC', channels: 2, sampleRate: 48000, ...audio }],
  };
}

test('selects Direct Play for supported MP4, H.264, and AAC', () => {
  assert.equal(decidePlayback(media(), supportedBrowser).strategy, 'direct');
});

test('remuxes supported streams from an incompatible Matroska container', () => {
  const result = decidePlayback(media({ container: 'matroska,webm', extension: '.mkv' }), supportedBrowser);
  assert.equal(result.strategy, 'remux');
});

test('does not treat QuickTime MOV as supported merely because FFprobe lists MP4 aliases', () => {
  const result = decidePlayback(media({ extension: '.mov' }), supportedBrowser);
  assert.equal(result.strategy, 'remux');
});

test('copies video and converts only unsupported audio, including incompatible containers', () => {
  const result = decidePlayback(media({
    container: 'matroska,webm',
    extension: '.mkv',
    audio: { codec: 'ac3' },
  }), supportedBrowser);
  assert.equal(result.strategy, 'audio-transcode');
  const args = ffmpegArguments({ inputPath: 'C:\\private\\movie.mkv', outputDirectory: 'unused', strategy: result.strategy });
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-f')), ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']);
});

test('maps a user-selected audio stream without re-encoding supported video', () => {
  const result = decidePlayback(media({
    audio: { codec: 'aac' },
  }), supportedBrowser);
  assert.equal(result.strategy, 'direct');
  const args = ffmpegArguments({
    inputPath: 'C:\\private\\movie.mkv',
    strategy: 'remux',
    audioStreamIndex: 7,
  });
  assert.equal(args[args.indexOf('-map') + 3], '0:7?');
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-f')), ['-c:v', 'copy', '-c:a', 'copy']);
});

test('selects full transcode for an unsupported video codec', () => {
  const result = decidePlayback(media({ video: { codec: 'hevc', profile: 'Main', level: 153 } }), supportedBrowser);
  assert.equal(result.strategy, 'full-transcode');
});

test('selects a browser-reported H.264 output profile for full transcoding', () => {
  const result = decidePlayback(media({ video: { codec: 'hevc', profile: 'Main', level: 153 } }), {
    ...supportedBrowser,
    videoProfiles: { h264: { baseline: true, main: false, high: false } },
  });
  assert.equal(result.strategy, 'full-transcode');
  assert.equal(result.outputProfile, 'baseline');
  const args = ffmpegArguments({
    inputPath: 'C:\\private\\video.mkv',
    strategy: result.strategy,
    outputProfile: result.outputProfile,
    outputLevel: result.outputLevel,
  });
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-preset')), [
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '4.0',
  ]);
});

test('rejects H.264 pixel formats with unsupported chroma or bit depth', () => {
  for (const pixelFormat of ['yuv422p', 'yuv444p', 'yuv420p10le', 'unknown']) {
    const result = decidePlayback(media({ video: { pixelFormat } }), supportedBrowser);
    assert.equal(result.strategy, 'full-transcode', pixelFormat);
    assert.match(result.reason, /pixel format/);
  }
});

test('rejects non-4:2:0 pixel formats for VP8', () => {
  const result = decidePlayback(media({
    video: { codec: 'vp8', profile: null, level: null, pixelFormat: 'yuv422p' },
  }), {
    ...supportedBrowser,
    videoCodecs: { ...supportedBrowser.videoCodecs, vp8: true },
    containers: { ...supportedBrowser.containers, mp4: false, webm: true },
    audioCodecs: { ...supportedBrowser.audioCodecs, aac: false },
  });
  assert.equal(result.strategy, 'full-transcode');
  assert.match(result.reason, /pixel format/);
});

test('selects a level that supports the encoded macroblock rate and frame size', () => {
  const browser = {
    ...supportedBrowser,
    videoProfiles: { h264: { high: true } },
    videoLevels: { h264: { high: [40, 41, 51, 52, 61] } },
  };
  const result1440p60 = decidePlayback(media({
    video: { codec: 'hevc', profile: 'Main', width: 2560, height: 1440, frameRate: 60 },
  }), browser);
  assert.equal(result1440p60.outputLevel, 51);

  const result8k30 = decidePlayback(media({
    video: { codec: 'hevc', profile: 'Main', width: 7680, height: 4320, frameRate: 30 },
  }), browser);
  assert.equal(result8k30.outputLevel, 61);
  const args = ffmpegArguments({
    inputPath: 'C:\\private\\8k.mkv',
    strategy: result8k30.strategy,
    outputProfile: result8k30.outputProfile,
    outputLevel: result8k30.outputLevel,
  });
  assert.deepEqual(args.slice(args.indexOf('-profile:v'), args.indexOf('-preset')), [
    '-profile:v', 'high', '-level:v', '6.1',
  ]);
});

test('uses Direct Play with an explicit warning when probe metadata is missing', () => {
  const result = decidePlayback(null, supportedBrowser);
  assert.equal(result.strategy, 'direct');
  assert.match(result.warning, /could not be fully inspected/);
});

test('preserves a supported 4K source and recommends 1080p only when 4K is unsupported', () => {
  const source = media({ video: { width: 3840, height: 2160, level: 51 } });
  assert.equal(decidePlayback(source, supportedBrowser).strategy, 'direct');
  const fallback = decidePlayback(source, {
    ...supportedBrowser,
    mediaCapabilities: {
      h2641080p: { supported: true },
      h2644k: { supported: false },
    },
  });
  assert.equal(fallback.strategy, 'full-transcode');
  assert.equal(fallback.resolution, 1080);
});

test('recommends 1080p when the browser reports supported 4K decoding is not smooth', () => {
  const result = decidePlayback(media({ video: { width: 3840, height: 2160, level: 51 } }), {
    ...supportedBrowser,
    mediaCapabilities: {
      h2641080p: { supported: true, smooth: true },
      h2644k: { supported: true, smooth: false },
    },
  });
  assert.equal(result.strategy, 'full-transcode');
  assert.equal(result.resolution, 1080);
});

test('configures a reported 1080p H.264 fallback in the actual FFmpeg arguments', () => {
  const result = decidePlayback(media({
    video: { width: 3840, height: 2160, level: 51 },
  }), {
    ...supportedBrowser,
    videoLevels: { h264: { high: [40, 41, 42, 51] } },
    mediaCapabilities: {
      h2641080p: { supported: true, smooth: true },
      h2644k: { supported: false },
    },
  });
  assert.equal(result.strategy, 'full-transcode');
  assert.equal(result.resolution, 1080);
  assert.equal(result.outputProfile, 'high');
  assert.equal(result.outputLevel, 40);
  const args = ffmpegArguments({
    inputPath: 'C:\\private\\4k.mkv',
    strategy: result.strategy,
    resolution: result.resolution,
    outputProfile: result.outputProfile,
    outputLevel: result.outputLevel,
  });
  assert.deepEqual(args.slice(args.indexOf('-profile:v'), args.indexOf('-preset')), [
    '-profile:v', 'high', '-level:v', '4.0',
  ]);
  assert.deepEqual(args.slice(args.indexOf('-vf'), args.indexOf('-c:a')), ['-vf', 'scale=-2:1080']);
});

test('caps excessive source frame rates and downscales 4K only with a supported 1080p60 report', () => {
  const result = decidePlayback(media({
    video: { width: 3840, height: 2160, level: 52, frameRate: 120 },
  }), {
    ...supportedBrowser,
    mediaCapabilities: {
      ...supportedBrowser.mediaCapabilities,
      h2641080p60: { supported: true, smooth: true },
      h2644k60: { supported: true, smooth: false },
    },
  });
  assert.equal(result.strategy, 'full-transcode');
  assert.equal(result.resolution, 1080);
  assert.equal(result.outputFrameRate, 60);
  const args = ffmpegArguments({
    inputPath: 'C:\\private\\4k.mkv',
    strategy: result.strategy,
    resolution: result.resolution,
    outputFrameRate: result.outputFrameRate,
  });
  assert.deepEqual(args.slice(args.indexOf('-vf'), args.indexOf('-c:a')), ['-vf', 'scale=-2:1080']);
  assert.equal(args.includes('60'), true);
});

test('rejects an unsupported H.264 level and conservatively falls back', () => {
  const result = decidePlayback(media({ video: { level: 52 } }), {
    ...supportedBrowser,
    videoLevels: { h264: { high: [40] } },
  });
  assert.equal(result.strategy, 'full-transcode');
});

test('rejects unsupported VP9 profiles and converts non-LC AAC audio', () => {
  const vp9 = decidePlayback(media({
    video: { codec: 'vp9', profile: 'Profile 2', level: 40, bitDepth: 10 },
  }), {
    ...supportedBrowser,
    videoCodecs: { ...supportedBrowser.videoCodecs, vp9: true },
    videoProfiles: { vp9: { profile2: true } },
    videoLevels: { vp9: { profile2: [40] } },
  });
  assert.equal(vp9.strategy, 'full-transcode');

  const aac = decidePlayback(media({ audio: { profile: 'HE-AAC' } }), supportedBrowser);
  assert.equal(aac.strategy, 'audio-transcode');
});

test('sanitizes browser reports and ignores arbitrary capability values', () => {
  const result = sanitizeCapabilities({
    containers: { mp4: 'yes', unknown: true },
    videoCodecs: { h264: true, unsupported: true },
    videoLevels: { h264: { high: [40, '51', 53, 999] } },
    mediaCapabilities: { h2644k: { supported: true, path: 'C:\\private\\file' } },
  });
  assert.deepEqual(result.containers, {});
  assert.deepEqual(result.videoCodecs, { h264: true });
  assert.deepEqual(result.videoLevels.h264.high, [40]);
  assert.deepEqual(result.mediaCapabilities.h2644k, { supported: true });
});

test('builds safe HLS arguments with stream copy for remux and no shell command', () => {
  const args = ffmpegArguments({
    inputPath: 'C:\\private\\movie; & echo unsafe.mkv',
    outputDirectory: 'unused',
    strategy: 'remux',
  });
  assert.equal(args.includes('C:\\private\\movie; & echo unsafe.mkv'), true);
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-f')), ['-c:v', 'copy', '-c:a', 'copy']);
  assert.equal(args.includes('temp_file'), true);
  assert.equal(args.at(-1), 'index.m3u8');
});
