import { performance } from 'node:perf_hooks';
import { buildCatalog } from '../services/catalog.js';
import { createLibraryController } from '../controllers/library.js';

const movieCount = 20_000;
const scan = {
  root: 'C:/benchmark-media',
  folders: [],
  movies: Array.from({ length: movieCount }, (_, index) => {
    const id = index.toString(16).padStart(24, '0');
    return {
      id,
      title: `Benchmark Movie ${index}`,
      releaseYear: 2000 + (index % 25),
      relativePath: `Movie ${index}.mp4`,
      size: 1_000_000 + index,
      extension: '.mp4',
      modifiedAt: '2025-01-01T00:00:00.000Z',
      mimeType: 'video/mp4',
      absolutePath: `C:/benchmark-media/Movie ${index}.mp4`,
    };
  }),
};
const state = { folderOverrides: {}, customCollections: [], watchProgress: {} };

function measure(operation) {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

const buildMs = measure(() => buildCatalog(scan, state));
const movieController = {
  getScan: async () => scan,
  getScannedAt: () => '2025-01-01T00:00:00.000Z',
};
const stateStore = { read: async () => state, getVersion: () => 0 };
const controller = createLibraryController({ movieController, stateStore });
const response = { json() {} };
const getCatalogMs = await (async () => {
  const startedAt = performance.now();
  await controller.overview({}, response, (error) => { throw error; });
  return performance.now() - startedAt;
})();
const cachedRequestCount = 20;
const cachedRequestStartedAt = performance.now();
for (let index = 0; index < cachedRequestCount; index += 1) {
  await controller.overview({}, response, (error) => { throw error; });
}
const cachedGetCatalogMs = (performance.now() - cachedRequestStartedAt) / cachedRequestCount;

console.log(`Movies: ${movieCount}`);
console.log(`buildCatalog: ${buildMs.toFixed(2)} ms`);
console.log(`Full getCatalog path (library overview, cold): ${getCatalogMs.toFixed(2)} ms`);
console.log(`Full getCatalog path (library overview, cached avg of ${cachedRequestCount}): ${cachedGetCatalogMs.toFixed(2)} ms`);
