import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function isFilesystemRoot(directory) {
  const resolved = path.resolve(directory);
  const filesystemRoot = path.parse(resolved).root;
  return process.platform === 'win32'
    ? resolved.toLowerCase() === filesystemRoot.toLowerCase()
    : resolved === filesystemRoot;
}

function pathError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function validatePathComponent(component) {
  if (typeof component !== 'string'
    || !component
    || component === '.'
    || component === '..'
    || /[<>:"/\\|?*\u0000-\u001f]/.test(component)
    || /[. ]$/.test(component)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(component)) {
    throw pathError('The path contains an invalid filename.', 'INVALID_LIBRARY_PATH');
  }
  return component;
}

export function validateMediaDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    throw new TypeError('A movie directory must be configured.');
  }
  if (isFilesystemRoot(directory)) {
    throw new Error('The configured movie directory cannot be a filesystem root.');
  }
  return path.resolve(directory);
}

export function isWithinDirectory(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export async function resolvePathWithinRoot(root, relativePath, { allowMissing = false } = {}) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\0')) {
    throw pathError('A non-empty relative path is required.', 'INVALID_LIBRARY_PATH');
  }
  if (path.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || path.win32.parse(relativePath).root) {
    throw pathError('Absolute paths are not allowed.', 'INVALID_LIBRARY_PATH');
  }

  const segments = relativePath.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === '..') {
      throw pathError('Path traversal is not allowed.', 'INVALID_LIBRARY_PATH');
    }
    if (segment && segment !== '.') validatePathComponent(segment);
  }

  const resolvedRoot = await realpath(validateMediaDirectory(root));
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!isWithinDirectory(resolvedRoot, candidate)) {
    throw pathError('The path must be inside the configured library.', 'PATH_OUTSIDE_ROOT');
  }

  let current = resolvedRoot;
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw pathError('Symbolic links and junctions are not allowed.', 'PATH_SYMLINK');
      }
      const resolvedCurrent = await realpath(current);
      if (!isWithinDirectory(resolvedRoot, resolvedCurrent)) {
        throw pathError('The path resolves outside the configured library.', 'PATH_OUTSIDE_ROOT');
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      return candidate;
    }
  }

  return candidate;
}
