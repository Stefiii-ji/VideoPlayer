import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithinDirectory, validateMediaDirectory } from '../path-safety.js';
import { ffmpegArguments } from './decision.js';
import { createMediaToolDiagnostics } from './tool-diagnostics.js';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEY_PATTERN = /^[a-zA-Z0-9._-]{8,100}$/;
const ASSET_PATTERN = /^(?:index\.m3u8|init\.mp4|segment-\d{6}\.m4s)$/;
const MAX_PLAYLIST_BYTES = 256 * 1024;
const DEFAULT_SESSION_LIMIT = 2;
const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PROCESS_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

function playbackError(message, code, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function reportCleanupFailure(error) {
  console.error(`Playback session cleanup failed (${error.code ?? 'UNKNOWN'}).`);
}

function isSessionActive(session) {
  if (['starting', 'running'].includes(session.state)) return true;
  return Boolean(session.process
    && !session.processError
    && session.process.exitCode == null
    && session.process.signalCode == null);
}

export function createTranscodeSessionManager({
  mediaDirectory,
  tempDirectory = path.join(os.tmpdir(), 'moviestream-transcodes'),
  executablePath = process.env.FFMPEG_PATH || 'ffmpeg',
  spawnProcess = spawn,
  maxConcurrent = DEFAULT_SESSION_LIMIT,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  processTimeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  staleAgeMs = DEFAULT_STALE_AGE_MS,
  mediaToolDiagnostics,
  now = Date.now,
} = {}) {
  const sessions = new Map();
  const requestSessions = new Map();
  const pendingRequests = new Map();
  let reservations = 0;
  let canonicalMediaDirectory;
  let canonicalTempDirectory;
  let initialization;
  let disposed = false;
  const toolDiagnostics = mediaToolDiagnostics ?? createMediaToolDiagnostics({
    ffmpegPath: executablePath,
    ffprobePath: null,
    ffmpegSpawn: spawnProcess,
    timeoutMs: 3_000,
    now,
  });

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        canonicalMediaDirectory = await realpath(validateMediaDirectory(mediaDirectory));
        const configuredTempRoot = validateMediaDirectory(tempDirectory);
        await mkdir(configuredTempRoot, { recursive: true });
        canonicalTempDirectory = await realpath(configuredTempRoot);
        if (canonicalTempDirectory === canonicalMediaDirectory
          || isWithinDirectory(canonicalMediaDirectory, canonicalTempDirectory)
          || isWithinDirectory(canonicalTempDirectory, canonicalMediaDirectory)) {
          throw playbackError('The transcode temporary directory must be separate from the media library.', 'INVALID_TRANSCODE_DIRECTORY', 500);
        }
        await cleanStaleSessions();
      })();
    }
    return initialization;
  }

  async function cleanStaleSessions() {
    const entries = await readdir(canonicalTempDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('session-') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const directory = path.join(canonicalTempDirectory, entry.name);
      const info = await lstat(directory);
      if (now() - info.mtimeMs < staleAgeMs) continue;
      const resolved = await realpath(directory);
      if (isWithinDirectory(canonicalTempDirectory, resolved)) {
        await rm(resolved, { recursive: true, force: false });
      }
    }
  }

  function getSession(movieId, sessionId) {
    if (!SESSION_ID_PATTERN.test(sessionId ?? '')) {
      throw playbackError('Invalid playback session ID.', 'INVALID_SESSION_ID', 400);
    }
    const session = sessions.get(sessionId);
    if (!session || session.movieId !== movieId) {
      throw playbackError('Playback session not found.', 'SESSION_NOT_FOUND', 404);
    }
    if (now() - session.lastAccessAt > sessionTtlMs) {
      void stopSession(sessionId).catch(reportCleanupFailure);
      throw playbackError('Playback session expired.', 'SESSION_EXPIRED', 410);
    }
    if (session.state !== 'failed') session.lastAccessAt = now();
    return session;
  }

  async function checkAvailable(strategy = 'full-transcode') {
    const diagnostics = await toolDiagnostics.getDiagnostics();
    const availabilityKey = strategy === 'audio-transcode' ? 'audioTranscode'
      : strategy === 'remux' ? 'remux'
        : 'fullTranscode';
    return diagnostics.strategyAvailability[availabilityKey];
  }

  function create(options) {
    const { movieId, requestKey } = options;
    const { strategy, startSeconds = 0 } = options;
    if (!/^[a-f0-9]{24}$/i.test(movieId ?? '')) {
      throw playbackError('Invalid movie ID.', 'INVALID_MOVIE_ID', 400);
    }
    if (!['remux', 'audio-transcode', 'full-transcode'].includes(strategy)) {
      throw playbackError('The requested playback strategy is invalid.', 'INVALID_PLAYBACK_STRATEGY', 400);
    }
    if (!REQUEST_KEY_PATTERN.test(requestKey ?? '')) {
      throw playbackError('A valid playback request key is required.', 'INVALID_REQUEST_KEY', 400);
    }
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 86_400) {
      throw playbackError('The playback start time is invalid.', 'INVALID_START_TIME', 400);
    }
    const requestId = `${movieId}:${requestKey}`;
    const pending = pendingRequests.get(requestId);
    if (pending) return pending;
    const operation = createSession({ ...options, requestId });
    pendingRequests.set(requestId, operation);
    return operation.finally(() => pendingRequests.delete(requestId));
  }

  async function createSession({
    movieId,
    inputPath,
    strategy,
    audioStreamIndex = null,
    resolution = null,
    outputProfile = 'baseline',
    outputLevel = null,
    outputFrameRate = null,
    startSeconds = 0,
    requestKey,
    requestId,
  }) {
    await initialize();
    if (disposed) throw playbackError('Playback sessions are shutting down.', 'SERVER_SHUTTING_DOWN', 503);
    if (typeof inputPath !== 'string' || !inputPath) {
      throw playbackError('A validated movie file is required.', 'INVALID_MEDIA_PATH', 400);
    }
    const resolvedInputPath = await realpath(inputPath);
    if (!isWithinDirectory(canonicalMediaDirectory, resolvedInputPath)) {
      throw playbackError('Movie path is outside the configured library.', 'PATH_OUTSIDE_LIBRARY', 403);
    }
    const inputInfo = await stat(resolvedInputPath);
    if (!inputInfo.isFile()) {
      throw playbackError('Movie file is unavailable.', 'MOVIE_UNAVAILABLE', 404);
    }

    const existingId = requestSessions.get(requestId);
    const existing = existingId && sessions.get(existingId);
    if (existing && existing.state !== 'failed' && existing.state !== 'stopped') {
      existing.lastAccessAt = now();
      return existing;
    }
    requestSessions.delete(requestId);

    const available = await checkAvailable(strategy);
    if (disposed) throw playbackError('Playback sessions are shutting down.', 'SERVER_SHUTTING_DOWN', 503);
    if (!available) {
      throw playbackError(
        'FFmpeg is unavailable. Configure FFMPEG_PATH or install FFmpeg and add it to PATH.',
        'FFMPEG_UNAVAILABLE',
        503,
      );
    }
    const activeCount = [...sessions.values()].filter(isSessionActive).length;
    if (activeCount + reservations >= maxConcurrent) {
      throw playbackError('The maximum number of simultaneous transcodes has been reached.', 'TRANSCODE_LIMIT', 429);
    }

    reservations += 1;
    let directory;
    try {
      directory = await mkdtemp(path.join(canonicalTempDirectory, 'session-'));
      if (disposed) {
        await rm(directory, { recursive: true, force: true });
        throw playbackError('Playback sessions are shutting down.', 'SERVER_SHUTTING_DOWN', 503);
      }
    } finally {
      reservations -= 1;
    }
    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      movieId,
      requestId,
      directory,
      state: 'starting',
      strategy,
      startedAt: now(),
      lastAccessAt: now(),
      error: null,
      stderr: '',
      process: null,
      timeout: null,
      stopPromise: null,
    };
    sessions.set(sessionId, session);
    requestSessions.set(requestId, sessionId);

    try {
      session.process = spawnProcess(executablePath, ffmpegArguments({
        inputPath: resolvedInputPath,
        strategy,
        audioStreamIndex,
        resolution,
        outputProfile,
        outputLevel,
        outputFrameRate,
        startSeconds,
      }), {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        cwd: directory,
      });
    } catch (error) {
      session.state = 'failed';
      session.error = 'FFmpeg could not be started.';
      await stopSession(sessionId);
      throw playbackError(session.error, 'FFMPEG_UNAVAILABLE', 503);
    }

    session.timeout = setTimeout(() => {
      session.error = 'FFmpeg exceeded the playback session time limit.';
      session.state = 'failed';
      session.process?.kill();
    }, processTimeoutMs);
    session.process.stderr.on('data', (chunk) => {
      session.stderr = `${session.stderr}${chunk.toString()}`.slice(-8192);
    });
    session.process.once('error', (error) => {
      session.state = 'failed';
      session.error = error.code === 'ENOENT'
        ? 'FFmpeg is unavailable. Configure FFMPEG_PATH or install FFmpeg and add it to PATH.'
        : 'FFmpeg could not process this media.';
      session.processError = error;
      clearTimeout(session.timeout);
    });
    session.process.once('close', (code) => {
      clearTimeout(session.timeout);
      if (session.state === 'stopped') return;
      if (code === 0) session.state = 'completed';
      else {
        session.state = 'failed';
        session.error ??= 'FFmpeg could not process this media.';
      }
    });
    session.state = 'running';
    try {
      await waitForPlaylist(session);
    } catch (error) {
      await stopSession(sessionId);
      throw error;
    }
    return session;
  }

  async function waitForPlaylist(session) {
    const playlist = path.join(session.directory, 'index.m3u8');
    const deadline = now() + 30_000;
    while (now() < deadline) {
      if (session.state === 'stopped') {
        throw playbackError('The playback session ended before it was ready.', 'PLAYBACK_CANCELLED', 503);
      }
      try {
        await access(playlist);
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (session.state === 'failed') {
        throw playbackError(session.error || 'FFmpeg could not prepare the playback stream.', 'FFMPEG_FAILED', 502);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    session.process?.kill();
    throw playbackError('FFmpeg did not produce a playback playlist in time.', 'FFMPEG_START_TIMEOUT', 504);
  }

  async function readAsset(movieId, sessionId, filename) {
    if (!ASSET_PATTERN.test(filename ?? '')) {
      throw playbackError('Invalid playback asset.', 'INVALID_SESSION_ASSET', 404);
    }
    const session = getSession(movieId, sessionId);
    await initialize();
    if (session.state === 'failed') {
      throw playbackError(session.error || 'FFmpeg could not prepare the playback stream.', 'FFMPEG_FAILED', 502);
    }
    const filePath = path.join(session.directory, filename);
    const directoryInfo = await lstat(session.directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw playbackError('Playback session storage is unavailable.', 'SESSION_STORAGE_INVALID', 500);
    }
    const resolvedDirectory = await realpath(session.directory);
    const resolvedFile = await realpath(filePath);
    if (!isWithinDirectory(canonicalTempDirectory, resolvedDirectory)
      || !isWithinDirectory(resolvedDirectory, resolvedFile)) {
      throw playbackError('Playback asset is outside its session directory.', 'SESSION_PATH_INVALID', 403);
    }
    const fileInfo = await stat(resolvedFile);
    if (!fileInfo.isFile()) throw playbackError('Playback asset is unavailable.', 'SESSION_ASSET_NOT_FOUND', 404);
    if (filename === 'index.m3u8') {
      if (fileInfo.size > MAX_PLAYLIST_BYTES) {
        throw playbackError('The playback playlist exceeded the allowed size.', 'PLAYLIST_TOO_LARGE', 500);
      }
      return { contentType: 'application/vnd.apple.mpegurl', body: await readFile(resolvedFile, 'utf8') };
    }
    return {
      contentType: filename === 'init.mp4' ? 'video/mp4' : 'video/iso.segment',
      body: createReadStream(resolvedFile),
    };
  }

  function touchSession(movieId, sessionId) {
    const session = getSession(movieId, sessionId);
    return { sessionId: session.id, state: session.state, strategy: session.strategy };
  }

  async function stopSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.stopPromise) return session.stopPromise;
    session.stopPromise = (async () => {
      clearTimeout(session.timeout);
      if (session.process && session.process.exitCode == null && session.process.signalCode == null) {
        session.state = 'stopped';
        session.process.kill();
        const closed = await new Promise((resolve) => {
          if (session.process.exitCode !== null || session.process.signalCode !== null) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => resolve(false), 2_000);
          session.process.once('close', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (!closed
          && session.process.exitCode == null
          && session.process.signalCode == null) {
          session.state = 'failed';
          throw playbackError('FFmpeg did not stop after cancellation.', 'FFMPEG_STOP_TIMEOUT', 503);
        }
      }
      await rm(session.directory, { recursive: true, force: true });
      sessions.delete(sessionId);
      requestSessions.delete(session.requestId);
    })().catch((error) => {
      if (session.state === 'stopped') session.state = 'failed';
      session.stopPromise = null;
      throw error;
    });
    return session.stopPromise;
  }

  const expiryTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (now() - session.lastAccessAt > sessionTtlMs) {
        void stopSession(session.id).catch(reportCleanupFailure);
      }
    }
  }, Math.min(sessionTtlMs, 30_000));
  expiryTimer.unref?.();

  async function dispose() {
    disposed = true;
    clearInterval(expiryTimer);
    await Promise.all([...sessions.keys()].map((sessionId) => stopSession(sessionId)));
  }

  return {
    create,
    readAsset,
    touchSession,
    stopSession,
    checkAvailable,
    dispose,
    getSession(movieId, sessionId) {
      return getSession(movieId, sessionId);
    },
    get activeCount() {
      return [...sessions.values()].filter(isSessionActive).length + reservations;
    },
  };
}
