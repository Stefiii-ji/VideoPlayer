import { useEffect, useRef } from 'react';
import { movieApi } from '../services/api.js';

export function useHlsPlayer({
  id,
  videoRef,
  playback,
  playbackGeneration,
  updateTimeline,
  setPlaybackError,
  attemptFallback,
  tryOriginalFile,
}) {
  const activeHlsRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback?.url) return undefined;
    const sourceUrl = playback.url;
    const strategy = playback.decision.strategy;
    video.removeAttribute('src');
    if (strategy === 'direct' || video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = sourceUrl;
      return () => {
        if (video.src === sourceUrl || video.getAttribute('src') === sourceUrl) video.removeAttribute('src');
      };
    }
    let disposed = false;
    let hls;
    const startHls = async () => {
      try {
        const { default: Hls } = await import('hls.js/light');
        if (disposed) return;
        if (!Hls.isSupported()) {
          setPlaybackError('This browser does not support the prepared HLS stream.');
          void tryOriginalFile();
          return;
        }
        hls = new Hls({ xhrSetup: (xhr) => { xhr.withCredentials = true; } });
        activeHlsRef.current = hls;
        hls.loadSource(sourceUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          setPlaybackError('The prepared stream could not be decoded by this browser.');
          void attemptFallback();
        });
        for (const eventName of [Hls.Events.MANIFEST_PARSED, Hls.Events.LEVEL_UPDATED, Hls.Events.FRAG_BUFFERED]) {
          if (eventName) hls.on(eventName, () => updateTimeline(video));
        }
      } catch (error) {
        if (disposed) return;
        setPlaybackError(`HLS playback could not be initialized: ${error.message}`);
        void tryOriginalFile();
      }
    };
    void startHls();
    return () => {
      disposed = true;
      if (activeHlsRef.current === hls) activeHlsRef.current = null;
      hls?.destroy();
      if (video.getAttribute('src') === sourceUrl) video.removeAttribute('src');
    };
  }, [
    id,
    playback?.url,
    playback?.sessionId,
    playback?.decision?.strategy,
    playbackGeneration,
    updateTimeline,
    attemptFallback,
    tryOriginalFile,
    setPlaybackError,
    videoRef,
  ]);

  return activeHlsRef;
}
