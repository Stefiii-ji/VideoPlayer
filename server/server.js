import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMovieController } from './controllers/movies.js';
import { createLibraryController } from './controllers/library.js';
import { createOrganizerController } from './controllers/organizer.js';
import { createLibraryState } from './services/library-state.js';
import { createOrganizerService } from './services/organizer/index.js';
import { validateMediaDirectory } from './services/path-safety.js';
import { createFfprobeService } from './services/playback/ffprobe.js';
import { createTranscodeSessionManager } from './services/playback/session-manager.js';
import { createMediaToolDiagnostics } from './services/playback/tool-diagnostics.js';
import { createSubtitleService } from './services/playback/subtitles.js';
import { createMovieRouter } from './routes/movies.js';
import { createLibraryRouter } from './routes/library.js';
import { createOrganizerRouter } from './routes/organizer.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function isSameHostOrigin(origin, host, protocol) {
  if (!origin || !host || !protocol) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === `${protocol}:`
      && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function createApp({
  movieDirectory = process.env.MOVIE_DIRECTORY ?? 'F:/Movies',
  clientUrls = (process.env.CLIENT_URL ?? 'http://localhost:5173').split(',').map((url) => url.trim()),
  tmdbApiKey = process.env.TMDB_API_KEY ?? '',
  metadataFile = process.env.MOVIESTREAM_METADATA_FILE || path.join(currentDirectory, 'data', 'library-state.json'),
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  transcodeDirectory = process.env.MOVIESTREAM_TRANSCODE_DIRECTORY || path.join(os.tmpdir(), 'moviestream-transcodes'),
  maxConcurrentTranscodes = Number(process.env.MOVIESTREAM_MAX_TRANSCODES ?? 2),
  ffmpegSpawn,
  ffprobeSpawn,
  serveClient = true,
} = {}) {
  movieDirectory = validateMediaDirectory(movieDirectory);
  if (!Number.isInteger(maxConcurrentTranscodes) || maxConcurrentTranscodes < 1 || maxConcurrentTranscodes > 16) {
    throw new TypeError('MOVIESTREAM_MAX_TRANSCODES must be an integer between 1 and 16.');
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestHost = req.get('host');
    const requestProtocol = req.protocol;
    cors({
      origin(origin, callback) {
        if (!origin || clientUrls.includes(origin) || isSameHostOrigin(origin, requestHost, requestProtocol)) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} is not allowed by MovieStream CORS policy.`));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Range'],
      exposedHeaders: ['Accept-Ranges', 'Content-Length', 'Content-Range', 'Content-Type'],
    })(req, res, next);
  });
  app.use('/api/organizer/import', express.raw({
    type: '*/*',
    limit: '5mb',
  }));
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  const mediaToolDiagnostics = createMediaToolDiagnostics({
    ffmpegPath,
    ffprobePath,
    ...(ffmpegSpawn ? { ffmpegSpawn } : {}),
    ...(ffprobeSpawn ? { ffprobeSpawn } : {}),
  });
  app.get('/api/system/diagnostics', async (_req, res, next) => {
    try {
      res.json(await mediaToolDiagnostics.getDiagnostics());
    } catch (error) {
      next(error);
    }
  });
  const ffprobeService = createFfprobeService({
    executablePath: ffprobePath,
    ...(ffprobeSpawn ? { spawnProcess: ffprobeSpawn } : {}),
  });
  const transcodeSessions = createTranscodeSessionManager({
    mediaDirectory: movieDirectory,
    tempDirectory: transcodeDirectory,
    executablePath: ffmpegPath,
    maxConcurrent: maxConcurrentTranscodes,
    mediaToolDiagnostics,
    ...(ffmpegSpawn ? { spawnProcess: ffmpegSpawn } : {}),
  });
  const subtitleService = createSubtitleService({
    executablePath: ffmpegPath,
    ...(ffmpegSpawn ? { spawnProcess: ffmpegSpawn } : {}),
  });
  const movieController = createMovieController({
    movieDirectory,
    tmdbApiKey,
    ffprobeService,
    transcodeSessions,
    subtitleService,
  });
  app.locals.shutdown = () => transcodeSessions.dispose();
  app.use('/api/movies', createMovieRouter(movieController));
  app.use('/api/library', createLibraryRouter(createLibraryController({
    movieController,
    stateStore: createLibraryState(metadataFile),
    tmdbApiKey,
  })));
  app.use('/api/organizer', createOrganizerRouter(createOrganizerController(
    createOrganizerService({ movieDirectory }),
  )));

  if (serveClient) {
    const clientDist = path.resolve(currentDirectory, '..', 'client', 'dist');
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(clientDist, 'index.html'), (error) => {
        if (error) next();
      });
    });
  }

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy(error);
    const status = error.message?.includes('CORS policy') ? 403
      : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    console.error(error.message);
    const message = status === 403
      ? 'Request origin is not allowed.'
      : status === 413
        ? 'Request body exceeds the allowed size.'
        : status === 400
          ? 'Request body is invalid.'
          : 'MovieStream could not complete the request.';
    res.status(status).json({ error: message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5000);
  const host = process.env.HOST ?? '0.0.0.0';
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`MovieStream listening on http://${host}:${port}`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    try {
      await app.locals.shutdown();
    } catch (error) {
      console.error(`MovieStream shutdown failed (${error.code ?? 'UNKNOWN'}).`);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
