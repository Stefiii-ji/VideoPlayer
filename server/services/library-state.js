import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY_STATE = {
  folderOverrides: {},
  customCollections: [],
  watchProgress: {},
};

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const isPlainObject = (entry) => entry !== null
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null);
  const validObjectMap = (entries, isValid) => Object.fromEntries(
    Object.entries(isPlainObject(entries) ? entries : {})
      .filter(([id, entry]) => id.length > 0 && isPlainObject(entry) && isValid(entry)),
  );
  return {
    folderOverrides: validObjectMap(value.folderOverrides, () => true),
    customCollections: Array.isArray(value.customCollections)
      ? value.customCollections.filter((collection) => isPlainObject(collection)
        && typeof collection.id === 'string'
        && typeof collection.name === 'string'
        && Array.isArray(collection.movieIds)
        && collection.movieIds.every((id) => typeof id === 'string'))
      : [],
    watchProgress: validObjectMap(value.watchProgress, (entry) => (
      Number.isFinite(entry.positionSeconds) && Number.isFinite(entry.durationSeconds)
    )),
  };
}

export function createLibraryState(filePath) {
  let writeQueue = Promise.resolve();
  let version = 0;
  const backupPath = `${filePath}.bak`;

  async function loadBackup() {
    try {
      return validateState(JSON.parse(await readFile(backupPath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
      if (error instanceof SyntaxError) {
        console.warn(`Ignoring invalid MovieStream metadata backup: ${backupPath}`);
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  async function read() {
    try {
      return validateState(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
      if (error instanceof SyntaxError) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}`;
        await rename(filePath, corruptPath);
        console.warn(`Corrupt MovieStream metadata moved to: ${corruptPath}`);
        return loadBackup();
      }
      throw error;
    }
  }

  async function writeAtomically(destination, contents) {
    const temporaryPath = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { flag: 'wx' });
      await rename(temporaryPath, destination);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async function update(mutator) {
    const operation = writeQueue.then(async () => {
      const state = await read();
      const previousState = structuredClone(state);
      const result = await mutator(state);
      const directory = path.dirname(filePath);
      await mkdir(directory, { recursive: true });
      const previousContents = `${JSON.stringify(previousState, null, 2)}\n`;
      await writeAtomically(backupPath, previousContents);
      await writeAtomically(filePath, `${JSON.stringify(state, null, 2)}\n`);
      version += 1;
      return result;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return { read, update, getVersion: () => version };
}
