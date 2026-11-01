import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getMovieMetadata } from '../services/metadata.js';
import { isWithinDirectory, publicMovie, scanLibrary } from '../services/library.js';
import { decidePlayback, sanitizeCapabilities } from '../services/playback/decision.js';
import { findExternalSubtitles } from '../services/playback/subtitles.js';

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

export function parseByteRange(header, size) {
  if (!header) return null;
  const match = RANGE_PATTERN.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

export function createMovieController({
  movieDirectory,
  tmdbApiKey = '',
  ffprobeService,
  transcodeSessions,
  subtitleService,
}) {
  let catalog = new Map();
  let scannedAt = null;
  let scanResult = null;
  let scanPromise = null;

  async function refresh() {
    if (!scanPromise) {
      scanPromise = scanLibrary(movieDirectory)
        .then((result) => {
          const { movies } = result;
          catalog = new Map(movies.map((movie) => [movie.id, movie]));
          scanResult = result;
          scannedAt = new Date().toISOString();
          return movies;
        })
        .finally(() => { scanPromise = null; });
    }
    return scanPromise;
  }

  async function ensureScanned() {
    if (scannedAt === null) await refresh();
  }

  async function resolveMovieFile(id) {
    if (!/^[a-f0-9]{24}$/.test(id ?? '')) {
      throw Object.assign(new Error('Invalid movie ID.'), { status: 400, code: 'INVALID_MOVIE_ID' });
    }
    await ensureScanned();
    const movie = catalog.get(id);
    if (!movie) throw Object.assign(new Error('Movie not found.'), { status: 404, code: 'MOVIE_NOT_FOUND' });
    const resolvedRoot = await realpath(path.resolve(movieDirectory));
    const resolvedFile = await realpath(movie.absolutePath);
    if (!isWithinDirectory(resolvedRoot, resolvedFile)) {
      throw Object.assign(new Error('Movie path is outside the configured library.'), { status: 403, code: 'PATH_OUTSIDE_LIBRARY' });
    }
    const fileInfo = await stat(resolvedFile);
    if (!fileInfo.isFile()) {
      throw Object.assign(new Error('Movie file is unavailable.'), { status: 404, code: 'MOVIE_UNAVAILABLE' });
    }
    return { movie, resolvedFile, fileInfo };
  }

  function playbackError(res, error) {
    const status = error.status ?? 500;
    if (status >= 500) console.error(error.message);
    return res.status(status).json({
      error: status >= 500 && !error.code ? 'MovieStream could not complete the request.' : error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }

  const controller = {
    async list(req, res, next) {
      try {
        await ensureScanned();
        const movies = [...catalog.values()].map((movie) => publicMovie(movie));
        res.json({ movies, count: movies.length, scannedAt });
      } catch (error) {
        next(error);
      }
    },
    async refresh(req, res, next) {
      try {
        const movies = await refresh();
        res.json({
          movies: movies.map((movie) => publicMovie(movie)),
          count: movies.length,
          scannedAt,
        });
      } catch (error) {
        next(error);
      }
    },
    async detail(req, res, next) {
      try {
        await ensureScanned();
        const movie = catalog.get(req.params.id);
        if (!movie) return res.status(404).json({ error: 'Movie not found. Refresh the library and try again.' });
        res.json({ movie: publicMovie(movie) });
      } catch (error) {
        next(error);
      }
    },
    async metadata(req, res, next) {
      try {
        await ensureScanned();
        const movie = catalog.get(req.params.id);
        if (!movie) return res.status(404).json({ error: 'Movie not found.' });
        const metadata = await getMovieMetadata(movie.title, tmdbApiKey);
        res.json({ metadata });
      } catch (error) {
        next(error);
      }
    },
    async stream(req, res, next) {
      try {
        await ensureScanned();
        if (!/^[a-f0-9]{24}$/.test(req.params.id)) {
          return res.status(400).json({ error: 'Invalid movie ID.' });
        }
        const movie = catalog.get(req.params.id);
        if (!movie) return res.status(404).json({ error: 'Movie not found.' });

        const root = path.resolve(movieDirectory);
        const resolvedRoot = await realpath(root);
        const resolvedFile = await realpath(movie.absolutePath);
        if (!isWithinDirectory(resolvedRoot, resolvedFile)) {
          return res.status(403).json({ error: 'Movie path is outside the configured library.' });
        }

        const fileInfo = await stat(resolvedFile);
        if (!fileInfo.isFile()) return res.status(404).json({ error: 'Movie file is unavailable.' });
        const range = parseByteRange(req.headers.range, fileInfo.size);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', movie.mimeType);
        res.setHeader('Cache-Control', 'private, no-store');

        if (range?.invalid) {
          res.setHeader('Content-Range', `bytes */${fileInfo.size}`);
          return res.status(416).end();
        }
        if (range) {
          const { start, end } = range;
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${fileInfo.size}`);
          res.setHeader('Content-Length', String(end - start + 1));
          const stream = createReadStream(resolvedFile, { start, end });
          stream.on('error', next);
          return stream.pipe(res);
        }

        res.setHeader('Content-Length', String(fileInfo.size));
        const stream = createReadStream(resolvedFile);
        stream.on('error', next);
        return stream.pipe(res);
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Movie file is unavailable.' });
        next(error);
      }
    },
    async transcode(req, res, next) {
      let closeListener;
      let clientDisconnected = false;
      try {
        const { movie, resolvedFile } = await resolveMovieFile(req.params.id);
        const startSeconds = req.query.start === undefined ? 0 : Number(req.query.start);
        if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 86_400) {
          return res.status(400).json({ error: 'The playback start time is invalid.', code: 'INVALID_START_TIME' });
        }
        closeListener = () => {
          if (!res.writableEnded) clientDisconnected = true;
        };
        res.once('close', closeListener);
        const session = await transcodeSessions.create({
          movieId: movie.id,
          inputPath: resolvedFile,
          strategy: 'full-transcode',
          startSeconds,
          requestKey: randomUUID(),
        });
        res.removeListener('close', closeListener);
        closeListener = null;
        if (clientDisconnected || res.destroyed) {
          try {
            await transcodeSessions.stopSession(session.id);
          } catch (error) {
            console.error(`Disconnected playback cleanup failed (${error.code ?? 'UNKNOWN'}).`);
          }
          return;
        }
        return res.redirect(307, `/api/movies/${movie.id}/playback-sessions/${session.id}/index.m3u8`);
      } catch (error) {
        if (res.destroyed) return;
        if (error.status) return playbackError(res, error);
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Movie file is unavailable.' });
        next(error);
      } finally {
        if (closeListener) res.removeListener('close', closeListener);
      }
    },
    async playback(req, res, next) {
      let closeListener;
      let clientDisconnected = false;
      try {
        const { movie, resolvedFile } = await resolveMovieFile(req.params.id);
        const body = req.body ?? {};
        if (body.fallback !== undefined
          && typeof body.fallback !== 'boolean'
          && body.fallback !== 'original') {
          return res.status(400).json({ error: 'The fallback selection is invalid.', code: 'INVALID_FALLBACK' });
        }
        if (body.fallback === 'original') {
          return res.json({
            movieId: movie.id,
            decision: {
              strategy: 'direct',
              reason: 'Using the original file at the viewer’s request.',
              resolution: null,
              transcodingAvailable: null,
            },
            warning: 'The original file may not be playable by this browser.',
            url: `/api/movies/${movie.id}/stream`,
          });
        }
        const capabilities = sanitizeCapabilities(body.capabilities);
        let metadata = null;
        let probeWarning = null;
        try {
          metadata = await ffprobeService.probe(resolvedFile);
        } catch (error) {
          if (['FFPROBE_INVALID_MEDIA', 'FFPROBE_INVALID_OUTPUT', 'FFPROBE_OUTPUT_LIMIT'].includes(error.code)) {
            probeWarning = 'FFprobe could not inspect this file. Trying the original stream.';
          } else if (error.code === 'FFPROBE_UNAVAILABLE') {
            probeWarning = 'FFprobe is unavailable. Configure FFPROBE_PATH; original-file playback will be attempted.';
          } else if (error.code === 'FFPROBE_TIMEOUT') {
            probeWarning = 'FFprobe timed out. Original-file playback will be attempted.';
          } else {
            throw error;
          }
        }

        const selectedAudioStreamIndex = body.audioStreamIndex;
        if (selectedAudioStreamIndex !== undefined
          && (!Number.isInteger(selectedAudioStreamIndex)
            || !metadata?.audioStreams?.some((stream) => stream.index === selectedAudioStreamIndex))) {
          return res.status(400).json({
            error: 'The selected audio track is not available.',
            code: 'INVALID_AUDIO_TRACK',
          });
        }
        const preferredAudio = metadata?.audioStreams?.find((stream) => stream.isDefault)
          ?? metadata?.audioStreams?.[0];
        const effectiveAudioStreamIndex = selectedAudioStreamIndex ?? preferredAudio?.index;
        const decisionAudio = selectedAudioStreamIndex === undefined ? preferredAudio : metadata.audioStreams
          .find((stream) => stream.index === selectedAudioStreamIndex);
        const decisionMetadata = metadata
          ? { ...metadata, audioStreams: decisionAudio ? [decisionAudio] : [] }
          : null;
        const decision = decidePlayback(decisionMetadata, capabilities, { transcodingAvailable: null });
        if (selectedAudioStreamIndex !== undefined && decision.strategy === 'direct') {
          decision.strategy = 'remux';
          decision.reason = 'Preparing the selected audio track while copying the original audio and video streams.';
        }
        if (probeWarning) decision.warning = probeWarning;
        if (body.fallback) {
          if (decision.strategy === 'full-transcode') {
            return res.status(409).json({
              error: 'No additional playback fallback is available.',
              code: 'NO_PLAYBACK_FALLBACK',
              decision,
            });
          }
          decision.strategy = 'full-transcode';
          decision.reason = 'The previous playback strategy failed; trying a compatible H.264/AAC stream.';
        }

        if (decision.strategy === 'direct') {
          return res.json({
            movieId: movie.id,
            decision,
            metadata,
            warning: decision.warning ?? null,
            url: `/api/movies/${movie.id}/stream`,
          });
        }
        const transcodingAvailable = await transcodeSessions.checkAvailable(decision.strategy);
        decision.transcodingAvailable = transcodingAvailable;
        if (!transcodingAvailable) {
          return res.status(503).json({
            error: 'FFmpeg is unavailable. Configure FFMPEG_PATH or install FFmpeg and add it to PATH.',
            code: 'FFMPEG_UNAVAILABLE',
            decision: { ...decision, transcodingAvailable: false },
            fallbackUrl: `/api/movies/${movie.id}/stream`,
          });
        }
        if (typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9._-]{8,100}$/.test(body.requestKey)) {
          return res.status(400).json({ error: 'A valid playback request key is required.', code: 'INVALID_REQUEST_KEY' });
        }
        closeListener = () => {
          if (!res.writableEnded) clientDisconnected = true;
        };
        res.once('close', closeListener);
        const session = await transcodeSessions.create({
          movieId: movie.id,
          inputPath: resolvedFile,
          strategy: decision.strategy,
          resolution: decision.resolution,
          outputProfile: decision.outputProfile,
          outputLevel: decision.outputLevel,
          outputFrameRate: decision.outputFrameRate,
          audioStreamIndex: effectiveAudioStreamIndex,
          requestKey: body.requestKey,
        });
        res.removeListener('close', closeListener);
        closeListener = null;
        if (clientDisconnected || res.destroyed) {
          try {
            await transcodeSessions.stopSession(session.id);
          } catch (error) {
            console.error(`Disconnected playback cleanup failed (${error.code ?? 'UNKNOWN'}).`);
          }
          return;
        }
        return res.json({
          movieId: movie.id,
          decision,
          metadata,
          warning: decision.warning ?? null,
          sessionId: session.id,
          url: `/api/movies/${movie.id}/playback-sessions/${session.id}/index.m3u8`,
        });
      } catch (error) {
        if (res.destroyed) return;
        if (error.status) return playbackError(res, error);
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Movie file is unavailable.' });
        next(error);
      } finally {
        if (closeListener) res.removeListener('close', closeListener);
      }
    },
    async subtitles(req, res, next) {
      try {
        const { movie, resolvedFile } = await resolveMovieFile(req.params.id);
        const externalTracks = await findExternalSubtitles(resolvedFile, movieDirectory);
        let embeddedTracks = [];
        let embeddedSubtitleCount = 0;
        let warning = null;
        try {
          const metadata = await ffprobeService.probe(resolvedFile);
          embeddedSubtitleCount = metadata.subtitleStreams?.length ?? 0;
          embeddedTracks = (metadata.subtitleStreams ?? [])
            .filter((stream) => Number.isInteger(stream.index) && subtitleService.supportsEmbeddedCodec(stream.codec))
            .map((stream) => ({
              id: `embedded-${stream.index}`,
              kind: 'embedded',
              streamIndex: stream.index,
              label: stream.title || stream.language || `Embedded ${stream.codec?.toUpperCase() ?? 'subtitle'}`,
              language: stream.language,
              format: stream.codec?.toUpperCase() ?? 'Subtitle',
              isDefault: stream.isDefault === true,
            }));
        } catch (error) {
          if (!['FFPROBE_INVALID_MEDIA', 'FFPROBE_INVALID_OUTPUT', 'FFPROBE_OUTPUT_LIMIT', 'FFPROBE_UNAVAILABLE', 'FFPROBE_TIMEOUT'].includes(error.code)) {
            throw error;
          }
          warning = 'Embedded subtitle tracks could not be inspected; external subtitles are still available.';
        }
        const subtitles = [
          ...embeddedTracks,
          ...externalTracks.map(({ path: _path, ...track }) => track),
        ];
        return res.json({
          subtitles,
          warning,
          unsupportedEmbeddedCount: Math.max(0, embeddedSubtitleCount - embeddedTracks.length),
        });
      } catch (error) {
        if (error.status) return playbackError(res, error);
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Movie file is unavailable.' });
        next(error);
      }
    },
    async subtitle(req, res, next) {
      try {
        const { movie, resolvedFile } = await resolveMovieFile(req.params.id);
        let content;
        if (/^embedded-\d+$/.test(req.params.subtitleId)) {
          const streamIndex = Number(req.params.subtitleId.slice('embedded-'.length));
          const metadata = await ffprobeService.probe(resolvedFile);
          const track = metadata.subtitleStreams?.find((stream) => stream.index === streamIndex);
          if (!track || !subtitleService.supportsEmbeddedCodec(track.codec)) {
            return res.status(404).json({ error: 'The selected subtitle track is unavailable.' });
          }
          content = await subtitleService.extractEmbedded(resolvedFile, streamIndex);
        } else if (/^external-\d+$/.test(req.params.subtitleId)) {
          const externalTracks = await findExternalSubtitles(resolvedFile, movieDirectory);
          const track = externalTracks[Number(req.params.subtitleId.slice('external-'.length))];
          if (!track) return res.status(404).json({ error: 'The selected subtitle track is unavailable.' });
          content = await subtitleService.convertExternal(track.path, movieDirectory);
        } else {
          return res.status(400).json({ error: 'The subtitle track selection is invalid.' });
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        return res.send(content);
      } catch (error) {
        if (error.status) return playbackError(res, error);
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Movie or subtitle file is unavailable.' });
        next(error);
      }
    },
    async playbackAsset(req, res, next) {
      try {
        if (!/^[a-f0-9]{24}$/.test(req.params.id)) {
          return res.status(400).json({ error: 'Invalid movie ID.', code: 'INVALID_MOVIE_ID' });
        }
        const asset = await transcodeSessions.readAsset(req.params.id, req.params.sessionId, req.params.filename);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', asset.contentType);
        if (typeof asset.body === 'string') return res.status(200).send(asset.body);
        asset.body.on('error', next);
        return asset.body.pipe(res);
      } catch (error) {
        if (error.status) return playbackError(res, error);
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Playback asset is not available yet.' });
        next(error);
      }
    },
    async playbackSessionStatus(req, res, next) {
      try {
        if (!/^[a-f0-9]{24}$/.test(req.params.id)) {
          return res.status(400).json({ error: 'Invalid movie ID.', code: 'INVALID_MOVIE_ID' });
        }
        return res.json(transcodeSessions.touchSession(req.params.id, req.params.sessionId));
      } catch (error) {
        if (error.status) return playbackError(res, error);
        next(error);
      }
    },
    async stopPlayback(req, res, next) {
      try {
        if (!/^[a-f0-9]{24}$/.test(req.params.id)) {
          return res.status(400).json({ error: 'Invalid movie ID.', code: 'INVALID_MOVIE_ID' });
        }
        transcodeSessions.getSession(req.params.id, req.params.sessionId);
        await transcodeSessions.stopSession(req.params.sessionId);
        return res.status(204).end();
      } catch (error) {
        if (error.status) return playbackError(res, error);
        next(error);
      }
    },
  };
  controller.getScan = async () => {
    await ensureScanned();
    return scanResult;
  };
  controller.getScannedAt = () => scannedAt;
  return controller;
}
