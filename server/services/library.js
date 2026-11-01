import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateMediaDirectory } from './path-safety.js';

export { isWithinDirectory } from './path-safety.js';

export const VIDEO_TYPES = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v', '.mpeg', '.mpg',
]);

export function createMovieId(relativePath) {
  return createHash('sha256').update(relativePath.toLowerCase()).digest('hex').slice(0, 24);
}

function titleFromFilename(filename) {
  const rawTitle = path.basename(filename, path.extname(filename)).replace(/[._]/g, ' ');
  const qualityMarker = /\b(?:480p|720p|1080p|2160p|4k|8k|uhd|hdr10?|web[- ]?(?:dl|rip)|blu[- ]?ray|b[dr]rip|hdtv|dvdrip|x26[45]|h26[45]|hevc|avc|aac|ddp?\d(?:\.\d)?|dts(?:[- ]?hd)?|esubs?|multi[- ]?subs?|dual[- ]?audio|proper|repack|yts(?:\.?mx)?)\b/i.exec(rawTitle);
  const releaseYear = /\b(?:19|20)\d{2}\b/.exec(rawTitle);
  const cutAt = Math.min(
    qualityMarker?.index ?? rawTitle.length,
    releaseYear && releaseYear.index > 0 ? releaseYear.index : rawTitle.length,
  );
  return rawTitle.slice(0, cutAt)
    .replace(/^\s*\d{1,3}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(?:\(|\[)$/, '');
}

function yearFromFilename(filename) {
  const year = path.basename(filename).match(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/)?.[1];
  return year ? Number(year) : null;
}

export async function scanLibrary(directory) {
  const configuredRoot = validateMediaDirectory(directory);
  const root = await realpath(configuredRoot);
  validateMediaDirectory(root);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error('The configured movie path is not a directory.');

  const movies = [];
  const folders = [];
  async function visit(folder) {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        const info = await stat(absolutePath);
        folders.push({
          id: createMovieId(path.relative(root, absolutePath)),
          name: entry.name,
          relativePath: path.relative(root, absolutePath),
          modifiedAt: info.mtime.toISOString(),
        });
        await visit(absolutePath);
      } else if (entry.isFile() && VIDEO_TYPES.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(absolutePath);
        const relativePath = path.relative(root, absolutePath);
        const ext = path.extname(entry.name).toLowerCase();
        movies.push({
          id: createMovieId(relativePath),
          title: titleFromFilename(entry.name),
          releaseYear: yearFromFilename(entry.name),
          relativePath,
          size: info.size,
          extension: ext,
          modifiedAt: info.mtime.toISOString(),
          mimeType: mimeTypeFor(ext),
          absolutePath,
        });
      }
    }
  }

  await visit(root);
  movies.sort((a, b) => a.title.localeCompare(b.title));
  folders.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { root, movies, folders };
}

export function mimeTypeFor(extension) {
  return ({
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.m4p': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.wmv': 'video/x-ms-wmv',
    '.webm': 'video/webm',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
  })[extension.toLowerCase()] ?? 'application/octet-stream';
}

export function publicMovie(movie, metadata = {}) {
  const { absolutePath: _absolutePath, relativePath, ...safeMovie } = movie;
  return {
    ...safeMovie,
    relativePath: relativePath.split(path.sep).join('/'),
    ...metadata,
  };
}
