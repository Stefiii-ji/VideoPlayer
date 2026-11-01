import { spawn } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isWithinDirectory } from '../path-safety.js';

const EXTERNAL_FORMATS = new Set(['.srt', '.vtt']);
const EMBEDDED_FORMATS = new Set(['subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text']);
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function decodeSubtitle(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const bytes = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
    }
    return new TextDecoder('utf-16le').decode(bytes);
  }
  const content = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3)
    : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return new TextDecoder('windows-1252').decode(content);
  }
}

export function convertSubtitleToWebVtt(buffer, extension) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_SUBTITLE_BYTES) {
    throw Object.assign(new Error('Subtitle file exceeds the supported size.'), { code: 'SUBTITLE_TOO_LARGE', status: 413 });
  }
  const format = extension.toLowerCase();
  if (!EXTERNAL_FORMATS.has(format)) {
    throw Object.assign(new Error('Subtitle format is not supported.'), { code: 'UNSUPPORTED_SUBTITLE_FORMAT', status: 415 });
  }
  let content = decodeSubtitle(buffer).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (format === '.srt') {
    content = content.replace(
      /^(\s*\d{2}:\d{2}:\d{2}),(\d{1,3})(\s*-->\s*)(\d{2}:\d{2}:\d{2}),(\d{1,3})(.*)$/gm,
      (_match, start, startMilliseconds, separator, end, endMilliseconds, suffix) => (
        `${start}.${startMilliseconds.padEnd(3, '0')}${separator}${end}.${endMilliseconds.padEnd(3, '0')}${suffix}`
      ),
    );
  } else if (/^WEBVTT(?:\s|$)/i.test(content)) {
    content = content.replace(/^WEBVTT[^\n]*/i, 'WEBVTT');
  }
  return `WEBVTT\n\n${content.replace(/^WEBVTT(?:\n+)?/i, '').trim()}\n`;
}

export async function findExternalSubtitles(mediaPath, mediaRoot) {
  const resolvedRoot = await realpath(mediaRoot);
  const resolvedMedia = await realpath(mediaPath);
  if (!isWithinDirectory(resolvedRoot, resolvedMedia)) {
    throw Object.assign(new Error('Movie path is outside the configured library.'), { code: 'PATH_OUTSIDE_LIBRARY', status: 403 });
  }
  const directory = path.dirname(resolvedMedia);
  const stem = path.basename(resolvedMedia, path.extname(resolvedMedia));
  const prefix = `${stem}.`.toLocaleLowerCase();
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile()
      && (entry.name.toLocaleLowerCase().startsWith(prefix)
        || entry.name.toLocaleLowerCase() === `${stem}${path.extname(entry.name).toLowerCase()}`.toLocaleLowerCase())
      && EXTERNAL_FORMATS.has(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry, index) => {
      const extension = path.extname(entry.name).toLowerCase();
      const suffix = path.basename(entry.name, extension).slice(stem.length + 1);
      return {
        id: `external-${index}`,
        kind: 'external',
        label: suffix ? suffix.replace(/[._-]+/g, ' ') : 'External',
        language: suffix || null,
        format: extension.slice(1).toUpperCase(),
        path: path.join(directory, entry.name),
      };
    });
}

export function createSubtitleService({
  executablePath = process.env.FFMPEG_PATH || 'ffmpeg',
  spawnProcess = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  function extractEmbedded(filePath, streamIndex) {
    if (!Number.isInteger(streamIndex) || streamIndex < 0) {
      return Promise.reject(Object.assign(
        new Error('The selected embedded subtitle track is invalid.'),
        { code: 'INVALID_SUBTITLE_TRACK', status: 400 },
      ));
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(executablePath, [
          '-hide_banner', '-loglevel', 'error', '-i', filePath,
          '-map', `0:${streamIndex}`, '-f', 'webvtt', 'pipe:1',
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        reject(Object.assign(new Error('FFmpeg could not extract this subtitle track.'), { code: 'SUBTITLE_EXTRACTION_FAILED', status: 502 }));
        return;
      }

      const chunks = [];
      let bytes = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(Object.assign(new Error('Subtitle extraction timed out.'), { code: 'SUBTITLE_EXTRACTION_TIMEOUT', status: 504 }));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_SUBTITLE_BYTES) {
          child.kill();
          finish(Object.assign(new Error('Extracted subtitle exceeds the supported size.'), { code: 'SUBTITLE_TOO_LARGE', status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      child.once('error', () => finish(Object.assign(
        new Error('FFmpeg could not extract this subtitle track.'),
        { code: 'SUBTITLE_EXTRACTION_FAILED', status: 502 },
      )));
      child.once('close', (code) => {
        if (code !== 0) {
          finish(Object.assign(
            new Error('FFmpeg could not convert this subtitle track to WebVTT.'),
            { code: 'SUBTITLE_EXTRACTION_FAILED', status: 502 },
          ));
          return;
        }
        const output = Buffer.concat(chunks).toString('utf8');
        finish(null, /^WEBVTT(?:\s|$)/i.test(output) ? output : `WEBVTT\n\n${output.trim()}\n`);
      });
    });
  }

  return {
    async convertExternal(filePath, mediaRoot) {
      const linkInfo = await lstat(filePath);
      if (linkInfo.isSymbolicLink()) {
        throw Object.assign(new Error('Subtitle file is unavailable.'), { code: 'SUBTITLE_PATH_INVALID', status: 403 });
      }
      const [resolvedRoot, resolvedFile] = await Promise.all([realpath(mediaRoot), realpath(filePath)]);
      if (!isWithinDirectory(resolvedRoot, resolvedFile)) {
        throw Object.assign(new Error('Subtitle file is outside the configured library.'), { code: 'SUBTITLE_PATH_INVALID', status: 403 });
      }
      const extension = path.extname(filePath).toLowerCase();
      const info = await stat(resolvedFile);
      if (!info.isFile()) {
        throw Object.assign(new Error('Subtitle file is unavailable.'), { code: 'SUBTITLE_UNAVAILABLE', status: 404 });
      }
      if (info.size > MAX_SUBTITLE_BYTES) {
        throw Object.assign(new Error('Subtitle file exceeds the supported size.'), { code: 'SUBTITLE_TOO_LARGE', status: 413 });
      }
      return convertSubtitleToWebVtt(await readFile(resolvedFile), extension);
    },
    extractEmbedded,
    supportsEmbeddedCodec(codec) {
      return EMBEDDED_FORMATS.has(codec?.toLowerCase());
    },
  };
}
