import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';
import {
  isWithinDirectory,
  resolvePathWithinRoot,
  validateMediaDirectory,
  validatePathComponent,
} from '../services/path-safety.js';

let fixtureRoot;
let mediaRoot;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-path-safety-'));
  mediaRoot = path.join(fixtureRoot, 'media');
  await mkdir(mediaRoot);
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('validates media-root configuration without requiring it to exist', () => {
  assert.equal(validateMediaDirectory(mediaRoot), path.resolve(mediaRoot));
  assert.equal(validateMediaDirectory(path.join(fixtureRoot, 'not-created')), path.join(fixtureRoot, 'not-created'));
  assert.throws(() => validateMediaDirectory(''), /must be configured/i);
  assert.throws(() => validateMediaDirectory('invalid\0root'), /must be configured/i);
  assert.throws(() => validateMediaDirectory(path.parse(mediaRoot).root), /filesystem root/i);
  assert.throws(() => createApp({ movieDirectory: path.parse(mediaRoot).root }), /filesystem root/i);
});

test('rejects absolute paths and traversal in either separator style', async () => {
  await assert.rejects(resolvePathWithinRoot(mediaRoot, '..\\outside'), {
    code: 'INVALID_LIBRARY_PATH',
  });
  await assert.rejects(resolvePathWithinRoot(mediaRoot, '../outside'), {
    code: 'INVALID_LIBRARY_PATH',
  });
  await assert.rejects(resolvePathWithinRoot(mediaRoot, path.join(fixtureRoot, 'outside')), {
    code: 'INVALID_LIBRARY_PATH',
  });
  await assert.rejects(resolvePathWithinRoot(mediaRoot, 'folder/CON.txt'), {
    code: 'INVALID_LIBRARY_PATH',
  });
});

test('accepts existing descendants and contained missing destinations', async () => {
  await mkdir(path.join(mediaRoot, 'films'));
  await writeFile(path.join(mediaRoot, 'films', 'sample.mp4'), 'fixture');

  assert.equal(
    await resolvePathWithinRoot(mediaRoot, 'films/sample.mp4'),
    path.join(mediaRoot, 'films', 'sample.mp4'),
  );
  assert.equal(
    await resolvePathWithinRoot(mediaRoot, 'new-folder/new-file.mp4', { allowMissing: true }),
    path.join(mediaRoot, 'new-folder', 'new-file.mp4'),
  );
  await assert.rejects(access(path.join(mediaRoot, 'new-folder')), { code: 'ENOENT' });
  await assert.rejects(resolvePathWithinRoot(mediaRoot, 'missing/source.mp4'), { code: 'ENOENT' });
});

test('rejects symbolic links and junctions within the configured tree', async (context) => {
  const outside = path.join(fixtureRoot, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.mp4'), 'fixture');

  try {
    await symlink(outside, path.join(mediaRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
      context.skip(`The environment does not permit creating a test link (${error.code}).`);
      return;
    }
    throw error;
  }

  assert.equal(
    isWithinDirectory(mediaRoot, await realpath(path.join(mediaRoot, 'linked', 'secret.mp4'))),
    false,
  );
  await assert.rejects(resolvePathWithinRoot(mediaRoot, 'linked/secret.mp4'), {
    code: 'PATH_SYMLINK',
  });
});

test('rejects broken symbolic links and junctions', async (context) => {
  const target = path.join(fixtureRoot, 'removed-target');
  const link = path.join(mediaRoot, 'broken-link');
  await mkdir(target);

  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
      context.skip(`The environment does not permit creating a test link (${error.code}).`);
      return;
    }
    throw error;
  }

  await rm(target, { recursive: true });
  await assert.rejects(resolvePathWithinRoot(mediaRoot, 'broken-link/child.mp4'), {
    code: 'PATH_SYMLINK',
  });
});

test('path-boundary checks reject sibling-prefix and root paths', () => {
  assert.equal(isWithinDirectory(mediaRoot, path.join(mediaRoot, 'nested', 'film.mp4')), true);
  assert.equal(isWithinDirectory(mediaRoot, mediaRoot), false);
  assert.equal(isWithinDirectory(mediaRoot, `${mediaRoot}-outside`), false);
});

test('Windows path comparisons ignore casing without accepting sibling prefixes', (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows case-insensitive path semantics are only available on Windows.');
    return;
  }

  assert.equal(isWithinDirectory(mediaRoot.toUpperCase(), path.join(mediaRoot, 'film.mkv').toLowerCase()), true);
  assert.equal(isWithinDirectory(mediaRoot.toUpperCase(), `${mediaRoot.toUpperCase()}-outside\\film.mkv`), false);
});

test('rejects invalid Windows filename components', () => {
  assert.equal(validatePathComponent('A movie (2024).mkv'), 'A movie (2024).mkv');
  for (const component of ['bad:name.mkv', 'trailing-dot.', 'trailing-space ', 'NUL.txt']) {
    assert.throws(() => validatePathComponent(component), { code: 'INVALID_LIBRARY_PATH' });
  }
});
