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
  return {
    folderOverrides: value.folderOverrides && typeof value.folderOverrides === 'object' ? value.folderOverrides : {},
    customCollections: Array.isArray(value.customCollections) ? value.customCollections : [],
    watchProgress: value.watchProgress && typeof value.watchProgress === 'object' ? value.watchProgress : {},
  };
}

export function createLibraryState(filePath) {
  let writeQueue = Promise.resolve();

  async function read() {
    try {
      return validateState(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
      if (error instanceof SyntaxError) {
        throw new Error(`Local MovieStream metadata is invalid JSON: ${filePath}`);
      }
      throw error;
    }
  }

  async function update(mutator) {
    const operation = writeQueue.then(async () => {
      const state = await read();
      const result = await mutator(state);
      const directory = path.dirname(filePath);
      await mkdir(directory, { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      return result;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return { read, update };
}
