import { createHash, randomUUID } from 'node:crypto';
import { opendir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isWithinDirectory, validateMediaDirectory } from '../path-safety.js';
import { VIDEO_TYPES } from '../library.js';
import { classifyOrganizerEntries, organizerFileTypes } from './classification.js';

const FILE_TYPES = organizerFileTypes();
const SCANNABLE_TYPES = new Set([
  ...VIDEO_TYPES,
  ...FILE_TYPES.subtitle,
  ...FILE_TYPES.artwork,
  ...FILE_TYPES.metadata,
  ...FILE_TYPES.unsupportedVideo,
]);

export const ORGANIZER_LIMITS = Object.freeze({
  maxEntries: 40000,
  maxFiles: 10000,
  maxDepth: 40,
  maxDurationMs: 20000,
  maxScans: 5,
});

function stableId(relativePath) {
  return createHash('sha256').update(relativePath.toLowerCase()).digest('hex').slice(0, 24);
}

function relativePosix(root, absolutePath) {
  const relativePath = path.relative(root, absolutePath);
  if (relativePath === '') return '';
  if (path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    throw Object.assign(new Error('The scanned path is outside the configured media directory.'), { code: 'PATH_OUTSIDE_ROOT' });
  }
  return relativePath.split(path.sep).join('/');
}

function canonicalStem(record) {
  const extension = path.extname(record.name);
  let stem = path.basename(record.name, extension).toLocaleLowerCase('en-US');
  stem = stem.replace(/[ ._-](?:480p|576p|720p|1080p|1440p|2160p|4320p|4k|8k|uhd|hdr10?|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|b[dr]rip|hdtv|dvdrip|x26[45]|h26[45]|hevc|avc|aac|dts(?:[ ._-]?hd)?|multi[ ._-]?subs?).*$/i, '');
  if (record.classification === 'subtitle') {
    stem = stem.replace(/[ ._-](?:en|eng|fr|fre|fra|de|ger|deu|es|spa|it|ita|ja|jpn|ko|kor|zh|zho|ru|rus|pt|por|sv|swe|da|dan|no|nor|fi|fin|pl|pol|ar|ara|hi|hin|th|tha|tr|tur|el|ell|he|heb)$/i, '');
  }
  return `${path.posix.dirname(record.relativePath).toLocaleLowerCase('en-US')}/${stem}`;
}

function attachGroups(entries) {
  const videos = entries.filter((entry) => entry.kind === 'file' && entry.isVideo);
  const videosByKey = new Map();
  const videosByDirectory = new Map();
  for (const video of videos) {
    const key = canonicalStem(video);
    const withKey = videosByKey.get(key) ?? [];
    withKey.push(video);
    videosByKey.set(key, withKey);
    const directory = path.posix.dirname(video.relativePath).toLocaleLowerCase('en-US');
    const inDirectory = videosByDirectory.get(directory) ?? [];
    inDirectory.push(video);
    videosByDirectory.set(directory, inDirectory);
  }
  return entries.map((entry) => {
    if (entry.kind !== 'file') return entry;
    const key = canonicalStem(entry);
    let relatedVideo = entry.isVideo ? entry : videosByKey.get(key)?.[0] ?? null;
    if (!relatedVideo && entry.classification === 'artwork'
      && /^(?:backdrop|cover|fanart|folder|movie|poster)\d*$/i.test(path.basename(entry.name, entry.extension))) {
      const directory = path.posix.dirname(entry.relativePath).toLocaleLowerCase('en-US');
      const inDirectory = videosByDirectory.get(directory) ?? [];
      if (inDirectory.length === 1) [relatedVideo] = inDirectory;
    }
    const related = Boolean(relatedVideo);
    return {
      ...entry,
      groupId: related
        ? createHash('sha256').update(canonicalStem(relatedVideo)).digest('hex').slice(0, 20)
        : null,
    };
  });
}

export async function scanOrganizerLibrary(directory, {
  signal,
  now = () => Date.now(),
  limits = ORGANIZER_LIMITS,
  openDirectory = opendir,
} = {}) {
  const configuredRoot = validateMediaDirectory(directory);
  const rootInfo = await lstat(configuredRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw Object.assign(new Error('The configured movie path is not a directory.'), { code: 'INVALID_MEDIA_DIRECTORY' });
  }
  const root = await realpath(configuredRoot);

  const startedAt = now();
  const entries = [];
  const warnings = [];
  let visitedEntries = 0;
  let scannedFiles = 0;
  let truncated = false;

  async function visit(absoluteDirectory, depth) {
    if (signal?.aborted) {
      truncated = true;
      warnings.push('Scan stopped after cancellation was requested.');
      return;
    }
    if (depth > limits.maxDepth) {
      truncated = true;
      warnings.push(`Scan stopped at the maximum folder depth (${limits.maxDepth}).`);
      return;
    }
    if (now() - startedAt >= limits.maxDurationMs) {
      truncated = true;
      warnings.push(`Scan stopped at the ${limits.maxDurationMs} ms time limit.`);
      return;
    }

    let directoryHandle;
    try {
      directoryHandle = await openDirectory(absoluteDirectory);
    } catch (error) {
      truncated = true;
      warnings.push(`Could not read folder "${relativePosix(root, absoluteDirectory)}" (${error.code ?? 'ACCESS_ERROR'}).`);
      return;
    }

    try {
      for await (const entry of directoryHandle) {
        if (signal?.aborted) {
          truncated = true;
          warnings.push('Scan stopped after cancellation was requested.');
          return;
        }
        if (now() - startedAt >= limits.maxDurationMs) {
          truncated = true;
          warnings.push(`Scan stopped at the ${limits.maxDurationMs} ms time limit.`);
          return;
        }
        visitedEntries += 1;
        if (visitedEntries > limits.maxEntries) {
          truncated = true;
          warnings.push(`Scan stopped at the ${limits.maxEntries} entry limit.`);
          return;
        }

        const absolutePath = path.join(absoluteDirectory, entry.name);
        const relativePath = relativePosix(root, absolutePath);
        let info;
        try {
          info = await lstat(absolutePath);
        } catch (error) {
          truncated = true;
          warnings.push(`Could not inspect "${relativePath}" (${error.code ?? 'ACCESS_ERROR'}).`);
          continue;
        }
        if (info.isSymbolicLink()) continue;

        if (info.isDirectory()) {
          let resolvedDirectory;
          try {
            resolvedDirectory = await realpath(absolutePath);
          } catch (error) {
            truncated = true;
            warnings.push(`Could not resolve folder "${relativePath}" (${error.code ?? 'ACCESS_ERROR'}).`);
            continue;
          }
          if (!isWithinDirectory(root, resolvedDirectory)) {
            truncated = true;
            warnings.push(`Skipped folder outside the configured media directory: "${relativePath}".`);
            continue;
          }
          entries.push({
            id: stableId(relativePath),
            kind: 'directory',
            name: entry.name,
            relativePath,
            size: null,
            extension: null,
            modifiedAt: Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null,
            isVideo: false,
          });
          await visit(absolutePath, depth + 1);
          if (truncated) return;
          continue;
        }

        if (!info.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (!SCANNABLE_TYPES.has(extension)) continue;
        if (scannedFiles >= limits.maxFiles) {
          truncated = true;
          warnings.push(`Scan stopped at the ${limits.maxFiles} file limit.`);
          return;
        }
        entries.push({
          id: stableId(relativePath),
          kind: 'file',
          name: entry.name,
          relativePath,
          size: info.size,
          extension,
          modifiedAt: Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null,
          isVideo: VIDEO_TYPES.has(extension),
        });
        scannedFiles += 1;
      }
    } catch (error) {
      truncated = true;
      warnings.push(`Could not finish reading folder "${relativePosix(root, absoluteDirectory)}" (${error.code ?? 'ACCESS_ERROR'}).`);
    }
  }

  await visit(root, 0);
  const classified = attachGroups(classifyOrganizerEntries(entries));
  return {
    scanId: randomUUID(),
    scannedAt: new Date().toISOString(),
    durationMs: Math.max(0, now() - startedAt),
    truncated,
    warnings: [...new Set(warnings)],
    entries: classified,
    visitedEntries,
  };
}
