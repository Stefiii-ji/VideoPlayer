import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const CACHE_LIMIT = 500;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function parseRate(value) {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === 'N/A') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bitDepth(pixelFormat, rawDepth) {
  const declared = numberOrNull(rawDepth);
  if (declared) return declared;
  const format = pixelFormat ?? '';
  const packed = /^p0?(\d{2})(?:le|be)?$/i.exec(format);
  if (packed) return Number(packed[1]);
  const match = /(?:p|le|be)(\d{2})/.exec(format);
  if (match) return Number(match[1]);
  if (/^(?:yuv|yuva|gbr)\w*p$|^(?:nv12|nv21|yuyv422|uyvy422|rgb24|bgr24|rgba|bgra|gray)$/.test(format)) return 8;
  return null;
}

export function parseProbeOutput(output, fileSize, fileExtension = null) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw Object.assign(new Error('FFprobe returned malformed metadata.'), { code: 'FFPROBE_INVALID_OUTPUT' });
  }
  if (!value
    || typeof value !== 'object'
    || !value.format
    || typeof value.format !== 'object'
    || Array.isArray(value.format)
    || !Array.isArray(value.streams)
    || value.streams.some((stream) => !stream || typeof stream !== 'object' || Array.isArray(stream))) {
    throw Object.assign(new Error('FFprobe returned incomplete media metadata.'), { code: 'FFPROBE_INVALID_OUTPUT' });
  }
  const videoStreams = value.streams.filter((stream) => stream.codec_type === 'video').map((stream) => ({
    index: numberOrNull(stream.index),
    codec: typeof stream.codec_name === 'string' ? stream.codec_name.toLowerCase() : null,
    profile: typeof stream.profile === 'string' ? stream.profile : null,
    level: numberOrNull(stream.level),
    width: numberOrNull(stream.width),
    height: numberOrNull(stream.height),
    frameRate: parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate),
    pixelFormat: typeof stream.pix_fmt === 'string' ? stream.pix_fmt : null,
    bitDepth: bitDepth(stream.pix_fmt, stream.bits_per_raw_sample),
  }));
  const audioStreams = value.streams.filter((stream) => stream.codec_type === 'audio').map((stream) => ({
    index: numberOrNull(stream.index),
    codec: typeof stream.codec_name === 'string' ? stream.codec_name.toLowerCase() : null,
    profile: typeof stream.profile === 'string' ? stream.profile : null,
    channels: numberOrNull(stream.channels),
    channelLayout: typeof stream.channel_layout === 'string' ? stream.channel_layout : null,
    sampleRate: numberOrNull(stream.sample_rate),
    language: typeof stream.tags?.language === 'string' ? stream.tags.language : null,
    title: typeof stream.tags?.title === 'string' ? stream.tags.title : null,
    isDefault: stream.disposition?.default === 1,
  }));
  const subtitleStreams = value.streams.filter((stream) => stream.codec_type === 'subtitle').map((stream) => ({
    index: numberOrNull(stream.index),
    codec: typeof stream.codec_name === 'string' ? stream.codec_name.toLowerCase() : null,
    language: typeof stream.tags?.language === 'string' ? stream.tags.language : null,
    title: typeof stream.tags?.title === 'string' ? stream.tags.title : null,
    isDefault: stream.disposition?.default === 1,
  }));

  if (videoStreams.length === 0) {
    throw Object.assign(new Error('The selected file has no video stream.'), { code: 'FFPROBE_INVALID_MEDIA' });
  }

  return {
    container: typeof value.format.format_name === 'string' ? value.format.format_name : null,
    duration: numberOrNull(value.format.duration),
    bitrate: numberOrNull(value.format.bit_rate),
    fileSize,
    fileExtension,
    video: videoStreams[0],
    audioStreams,
    subtitleStreams,
  };
}

export function createFfprobeService({
  executablePath = process.env.FFPROBE_PATH || 'ffprobe',
  spawnProcess = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const cache = new Map();

  async function probe(filePath) {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw Object.assign(new Error('The selected media path is not a file.'), { code: 'FFPROBE_INVALID_MEDIA' });
    }
    const resolvedPath = path.resolve(filePath);
    const cacheKey = `${resolvedPath.toLowerCase()}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.metadata;
    if (cached) cache.delete(cacheKey);

    const output = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(executablePath, [
          '-v', 'error',
          '-show_format',
          '-show_streams',
          '-of', 'json',
          resolvedPath,
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(Object.assign(
          new Error('FFprobe is unavailable. Configure FFPROBE_PATH or install FFmpeg and add ffprobe to PATH.'),
          { code: 'FFPROBE_UNAVAILABLE', cause: error },
        ));
        return;
      }

      const chunks = [];
      let outputBytes = 0;
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        finish(Object.assign(new Error('FFprobe timed out while inspecting the media.'), { code: 'FFPROBE_TIMEOUT' }));
        child.kill();
      }, timeoutMs);

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      }

      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          finish(Object.assign(new Error('FFprobe metadata exceeded the allowed size.'), { code: 'FFPROBE_OUTPUT_LIMIT' }));
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length);
      });
      child.once('error', (error) => finish(Object.assign(
        new Error('FFprobe is unavailable. Configure FFPROBE_PATH or install FFmpeg and add ffprobe to PATH.'),
        { code: 'FFPROBE_UNAVAILABLE', cause: error },
      )));
      child.once('close', (code) => {
        if (code !== 0) {
          finish(Object.assign(
            new Error(stderr.trim() || `FFprobe exited with status ${code}.`),
            { code: 'FFPROBE_INVALID_MEDIA' },
          ));
          return;
        }
        finish(null, Buffer.concat(chunks).toString('utf8'));
      });
    });

    const metadata = parseProbeOutput(output, info.size, path.extname(resolvedPath).toLowerCase());
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { metadata, expiresAt: now() + CACHE_TTL_MS });
    return metadata;
  }

  return {
    probe,
    clearCache() {
      cache.clear();
    },
  };
}
