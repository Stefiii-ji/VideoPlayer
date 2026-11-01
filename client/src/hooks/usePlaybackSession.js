import { useCallback, useEffect, useRef, useState } from 'react';
import { movieApi } from '../services/api.js';
import { detectPlaybackCapabilities } from '../services/playback-capabilities.js';
import {
  createFallbackMachine,
  FALLBACK_STAGES,
  transitionFallbackMachine,
} from './playback-fallback-machine.js';

function createRequestKey() {
  return globalThis.crypto?.randomUUID?.()
    ?? `playback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function usePlaybackSession({
  id,
  videoRef,
  pendingSeekRef,
  seekIntentRef,
  currentTimeRef,
  resumePlayingRef,
  setSelectedAudio,
  setDuration,
  setCanSeek,
  resetPlaybackUi,
}) {
  const requestKeyRef = useRef({ movieId: id, key: createRequestKey() });
  if (requestKeyRef.current.movieId !== id) requestKeyRef.current = { movieId: id, key: createRequestKey() };
  const capabilitiesRef = useRef(null);
  const playbackRef = useRef(null);
  const activePlaybackRef = useRef(false);
  const sessionIdsRef = useRef(new Set());
  const stoppedSessionsRef = useRef(new Set());
  const fallbackMachineRef = useRef(createFallbackMachine());
  const [playback, setPlayback] = useState(null);
  const [playbackLoading, setPlaybackLoading] = useState(true);
  const [playbackError, setPlaybackError] = useState('');
  const [fallbackUrl, setFallbackUrl] = useState('');
  const [playbackGeneration, setPlaybackGeneration] = useState(0);

  playbackRef.current = playback;

  const stopPlaybackSessions = useCallback(async () => {
    const sessions = [...sessionIdsRef.current];
    sessionIdsRef.current.clear();
    sessions.forEach((sessionId) => stoppedSessionsRef.current.add(sessionId));
    await Promise.all(sessions.map((sessionId) => movieApi.stopPlayback(id, sessionId)));
  }, [id]);

  const requestPlayback = useCallback(async ({
    fallback = false,
    signal,
    audioStreamIndex,
  } = {}) => {
    setPlaybackLoading(true);
    setPlaybackError('');
    setFallbackUrl('');
    const previousSessions = audioStreamIndex === undefined ? [] : [...sessionIdsRef.current];
    try {
      const result = await movieApi.playback(id, {
        capabilities: capabilitiesRef.current ?? {},
        fallback,
        requestKey: fallback || audioStreamIndex !== undefined ? createRequestKey() : requestKeyRef.current.key,
        audioStreamIndex,
        signal,
      });
      if (!activePlaybackRef.current || signal?.aborted) {
        if (result.sessionId) {
          await movieApi.stopPlayback(id, result.sessionId).catch((error) => {
            console.warn(`Playback session cleanup failed: ${error.message}`);
          });
        }
        return null;
      }
      const playbackResult = result.metadata || !playbackRef.current?.metadata
        ? result
        : { ...result, metadata: playbackRef.current.metadata };
      if (result.sessionId) sessionIdsRef.current.add(result.sessionId);
      setPlayback(playbackResult);
      if (Number.isFinite(playbackResult.metadata?.duration) && playbackResult.metadata.duration > 0) {
        setDuration(playbackResult.metadata.duration);
        setCanSeek(true);
      }
      setPlaybackGeneration((generation) => generation + 1);
      const audioTrack = playbackResult.metadata?.audioStreams?.find((track) => track.index === audioStreamIndex)
        ?? playbackResult.metadata?.audioStreams?.find((track) => track.isDefault)
        ?? playbackResult.metadata?.audioStreams?.[0];
      setSelectedAudio(audioTrack?.index == null ? '' : String(audioTrack.index));
      setFallbackUrl(playbackResult.decision.strategy === 'direct' ? '' : movieApi.streamUrl(id));
      fallbackMachineRef.current = transitionFallbackMachine(fallbackMachineRef.current, {
        type: 'playback-selected',
        strategy: playbackResult.decision.strategy,
      });
      const obsoleteSessions = previousSessions.filter((sessionId) => sessionId !== playbackResult.sessionId);
      obsoleteSessions.forEach((sessionId) => {
        sessionIdsRef.current.delete(sessionId);
        stoppedSessionsRef.current.add(sessionId);
      });
      await Promise.all(obsoleteSessions.map((sessionId) => movieApi.stopPlayback(id, sessionId).catch((error) => {
        console.warn(`Playback session cleanup failed: ${error.message}`);
      })));
      return playbackResult;
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted || !activePlaybackRef.current) return null;
      setPlaybackError(error.message || 'MovieStream could not prepare playback.');
      setFallbackUrl(error.details?.fallbackUrl || '');
      return null;
    } finally {
      if (activePlaybackRef.current && !signal?.aborted) setPlaybackLoading(false);
    }
  }, [id, setSelectedAudio]);

  const attemptFallback = useCallback(() => {
    const machine = fallbackMachineRef.current;
    if (machine.inFlight) return machine.inFlight;
    if (machine.stage === FALLBACK_STAGES.ORIGINAL) return Promise.resolve();
    const operation = (async () => {
      const video = videoRef.current;
      if (video) {
        pendingSeekRef.current = video.currentTime > 0 ? video.currentTime : null;
        seekIntentRef.current = null;
        currentTimeRef.current = video.currentTime;
        resumePlayingRef.current = !video.paused;
      }
      if (playbackRef.current?.decision.strategy === 'full-transcode') {
        fallbackMachineRef.current = transitionFallbackMachine(fallbackMachineRef.current, {
          type: 'original-requested',
        });
        try {
          await stopPlaybackSessions();
        } catch (error) {
          console.warn(`Playback session cleanup failed: ${error.message}`);
        }
        await requestPlayback({ fallback: 'original' });
        return;
      }
      fallbackMachineRef.current = transitionFallbackMachine(fallbackMachineRef.current, {
        type: 'fallback-requested',
      });
      try {
        await stopPlaybackSessions();
      } catch (error) {
        console.warn(`Playback session cleanup failed: ${error.message}`);
      }
      await requestPlayback({ fallback: true });
    })();
    const trackedOperation = operation.finally(() => {
      if (fallbackMachineRef.current.inFlight === trackedOperation) {
        fallbackMachineRef.current = transitionFallbackMachine(fallbackMachineRef.current, {
          type: 'request-settled',
        });
      }
    });
    fallbackMachineRef.current = { ...fallbackMachineRef.current, inFlight: trackedOperation };
    return trackedOperation;
  }, [
    currentTimeRef,
    pendingSeekRef,
    requestPlayback,
    resumePlayingRef,
    seekIntentRef,
    stopPlaybackSessions,
    videoRef,
  ]);

  const tryOriginalFile = useCallback(() => {
    const machine = fallbackMachineRef.current;
    if (machine.inFlight) return machine.inFlight;
    if (machine.stage === FALLBACK_STAGES.ORIGINAL) return Promise.resolve();
    fallbackMachineRef.current = transitionFallbackMachine(machine, { type: 'original-requested' });
    const operation = (async () => {
      const video = videoRef.current;
      if (video) {
        pendingSeekRef.current = video.currentTime > 0 ? video.currentTime : null;
        seekIntentRef.current = null;
        currentTimeRef.current = video.currentTime;
        resumePlayingRef.current = !video.paused;
      }
      try {
        await stopPlaybackSessions();
      } catch (error) {
        console.warn(`Playback session cleanup failed: ${error.message}`);
      }
      await requestPlayback({ fallback: 'original' });
    })();
    const trackedOperation = operation.finally(() => {
      if (fallbackMachineRef.current.inFlight === trackedOperation) {
        fallbackMachineRef.current = transitionFallbackMachine(fallbackMachineRef.current, {
          type: 'request-settled',
        });
      }
    });
    fallbackMachineRef.current = { ...fallbackMachineRef.current, inFlight: trackedOperation };
    return trackedOperation;
  }, [
    currentTimeRef,
    pendingSeekRef,
    requestPlayback,
    resumePlayingRef,
    seekIntentRef,
    stopPlaybackSessions,
    videoRef,
  ]);

  const resetFallback = useCallback(() => {
    fallbackMachineRef.current = transitionFallbackMachine(fallbackMachineRef.current, { type: 'reset' });
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    let effectActive = true;
    activePlaybackRef.current = true;
    fallbackMachineRef.current = transitionFallbackMachine(fallbackMachineRef.current, { type: 'reset' });
    capabilitiesRef.current = null;
    sessionIdsRef.current.clear();
    stoppedSessionsRef.current.clear();
    setPlayback(null);
    setPlaybackLoading(true);
    setPlaybackError('');
    setFallbackUrl('');
    resetPlaybackUi();

    detectPlaybackCapabilities().then((capabilities) => {
      if (!effectActive) return;
      capabilitiesRef.current = capabilities;
      return requestPlayback({ signal: abortController.signal });
    }).catch((error) => {
      if (effectActive && error.name !== 'AbortError' && activePlaybackRef.current) {
        setPlaybackError(`Browser playback capabilities could not be checked: ${error.message}`);
        setPlaybackLoading(false);
      }
    });

    return () => {
      effectActive = false;
      activePlaybackRef.current = false;
      abortController.abort();
      void stopPlaybackSessions().catch((error) => {
        console.warn(`Playback session cleanup failed: ${error.message}`);
      });
    };
  }, [id, requestPlayback, resetPlaybackUi, stopPlaybackSessions]);

  useEffect(() => {
    const sessionId = playback?.sessionId;
    if (!sessionId) return undefined;
    const heartbeat = window.setInterval(() => {
      if (stoppedSessionsRef.current.has(sessionId)) return;
      movieApi.touchPlayback(id, sessionId).catch((error) => {
        if (stoppedSessionsRef.current.has(sessionId)) return;
        if (error.status === 404 || error.status === 410) {
          setPlaybackError('The transcoding session expired or is no longer available.');
          setFallbackUrl(movieApi.streamUrl(id));
          return;
        }
        console.warn(`Playback session heartbeat failed: ${error.message}`);
      });
    }, 30_000);
    return () => window.clearInterval(heartbeat);
  }, [id, playback?.sessionId]);

  return {
    attemptFallback,
    fallbackUrl,
    playback,
    playbackError,
    playbackGeneration,
    playbackLoading,
    playbackRef,
    requestPlayback,
    resetFallback,
    stopPlaybackSessions,
    stoppedSessionsRef,
    tryOriginalFile,
    setFallbackUrl,
    setPlaybackError,
  };
}
