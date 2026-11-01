import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
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
const accessCookieName = 'moviestream_access';
const loginFailureLimit = 5;
const loginFailureWindowMs = 15 * 60 * 1000;

function tokensMatch(candidate, expected) {
  if (typeof candidate !== 'string' || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function readAccessCookie(req) {
  const cookie = req.headers.cookie?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${accessCookieName}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(accessCookieName.length + 1));
  } catch {
    return null;
  }
}

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
  movieDirectory = process.env.MOVIE_DIRECTORY,
  clientUrls = (process.env.CLIENT_URL ?? 'http://localhost:5173').split(',').map((url) => url.trim()),
  tmdbApiKey = process.env.TMDB_API_KEY ?? '',
  metadataFile = process.env.MOVIESTREAM_METADATA_FILE || path.join(currentDirectory, 'data', 'library-state.json'),
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  transcodeDirectory = process.env.MOVIESTREAM_TRANSCODE_DIRECTORY || path.join(os.tmpdir(), 'moviestream-transcodes'),
  maxConcurrentTranscodes = Number(process.env.MOVIESTREAM_MAX_TRANSCODES?.trim() || 2),
  accessToken = process.env.MOVIESTREAM_ACCESS_TOKEN ?? '',
  ffmpegSpawn,
  ffprobeSpawn,
  readStreamFactory = createReadStream,
  serveClient = true,
} = {}) {
  if (typeof movieDirectory !== 'string' || !movieDirectory.trim()) {
    throw new Error('Set MOVIE_DIRECTORY in server/.env to an existing movie library folder.');
  }
  movieDirectory = validateMediaDirectory(movieDirectory);
  let movieDirectoryInfo;
  try {
    movieDirectoryInfo = statSync(movieDirectory);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new Error(`MOVIE_DIRECTORY does not exist: ${movieDirectory}`);
    }
    throw error;
  }
  if (!movieDirectoryInfo.isDirectory()) {
    throw new Error(`MOVIE_DIRECTORY must be an existing directory: ${movieDirectory}`);
  }
  if (!Number.isInteger(maxConcurrentTranscodes) || maxConcurrentTranscodes < 1 || maxConcurrentTranscodes > 16) {
    throw new TypeError('MOVIESTREAM_MAX_TRANSCODES must be an integer between 1 and 16.');
  }
  const app = express();
  const loginFailures = new Map();
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
      credentials: true,
    })(req, res, next);
  });
  app.use('/api/organizer/import', express.raw({
    type: '*/*',
    limit: '5mb',
  }));
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/auth/status', (req, res) => {
    const required = accessToken.length > 0;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      required,
      authenticated: required && tokensMatch(readAccessCookie(req), accessToken),
    });
  });
  app.post('/api/auth/login', (req, res) => {
    const now = Date.now();
    const clientKey = req.ip;
    let failure = loginFailures.get(clientKey);
    if (failure?.resetAt <= now) {
      loginFailures.delete(clientKey);
      failure = undefined;
    }
    if (failure?.count >= loginFailureLimit) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.', code: 'LOGIN_RATE_LIMITED' });
    }
    if (!tokensMatch(req.body?.token, accessToken)) {
      if (!failure) {
        failure = { count: 0, resetAt: now + loginFailureWindowMs };
        loginFailures.set(clientKey, failure);
      }
      failure.count += 1;
      return res.status(401).json({ error: 'Invalid access token.', code: 'INVALID_ACCESS_TOKEN' });
    }
    loginFailures.delete(clientKey);
    const secure = req.secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${accessCookieName}=${encodeURIComponent(accessToken)}; Path=/api; HttpOnly; SameSite=Lax${secure}`,
    );
    res.json({ authenticated: true });
  });
  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader(
      'Set-Cookie',
      `${accessCookieName}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
    res.json({ authenticated: false });
  });
  app.use('/api', (req, res, next) => {
    if (!accessToken || (req.method === 'GET' && req.path === '/health')) return next();
    if ((req.method === 'GET' && req.path === '/auth/status')
      || (req.method === 'POST' && ['/auth/login', '/auth/logout'].includes(req.path))) {
      return next();
    }
    if (!tokensMatch(readAccessCookie(req), accessToken)) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }
    return next();
  });
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
    readStreamFactory,
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
