import { useCallback, useEffect, useRef, useState } from 'react';

export function usePlayerControls({
  id,
  episodeOwner,
  navigate,
  videoRef,
  playerRef,
  pendingSeekRef,
  currentTimeRef,
  openTrackMenuRef,
  closeTrackMenuRef,
  seekToRef,
  playbackErrorRef,
}) {
  const controlsTimerRef = useRef(null);
  const playingRef = useRef(false);
  const isFullscreenRef = useRef(false);
  const seekingRef = useRef(false);
  const controlsFocusedRef = useRef(false);
  const keyboardInteractionRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = null;
    if (playingRef.current && !openTrackMenuRef.current && !seekingRef.current && !controlsFocusedRef.current) {
      controlsTimerRef.current = window.setTimeout(() => {
        if (playingRef.current && !openTrackMenuRef.current && !seekingRef.current && !controlsFocusedRef.current) {
          setControlsVisible(false);
        }
      }, 3000);
    }
  }, [openTrackMenuRef]);

  const toggleFullscreen = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        else throw new Error('Fullscreen could not be exited by this browser.');
      }
      else if (videoRef.current?.webkitDisplayingFullscreen) videoRef.current.webkitExitFullscreen?.();
      else if (player.requestFullscreen) await player.requestFullscreen();
      else if (player.webkitRequestFullscreen) await player.webkitRequestFullscreen();
      else if (videoRef.current?.webkitEnterFullscreen) videoRef.current.webkitEnterFullscreen();
      else throw new Error('Fullscreen is not supported by this browser.');
    } catch (error) {
      playbackErrorRef.current(`Fullscreen could not be opened: ${error.message}`);
    }
  }, [playerRef, playbackErrorRef, videoRef]);

  useEffect(() => {
    function updateFullscreenState() {
      const fullscreenElement = document.fullscreenElement ?? document.webkitFullscreenElement;
      const fullscreen = fullscreenElement === playerRef.current
        || videoRef.current?.webkitDisplayingFullscreen === true;
      isFullscreenRef.current = fullscreen;
      setIsFullscreen(fullscreen);
    }
    const video = videoRef.current;
    document.addEventListener('fullscreenchange', updateFullscreenState);
    document.addEventListener('webkitfullscreenchange', updateFullscreenState);
    video?.addEventListener('webkitbeginfullscreen', updateFullscreenState);
    video?.addEventListener('webkitendfullscreen', updateFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreenState);
      document.removeEventListener('webkitfullscreenchange', updateFullscreenState);
      video?.removeEventListener('webkitbeginfullscreen', updateFullscreenState);
      video?.removeEventListener('webkitendfullscreen', updateFullscreenState);
    };
  }, [playerRef, videoRef]);

  useEffect(() => () => {
    window.clearTimeout(controlsTimerRef.current);
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target;
      const isControl = target instanceof HTMLElement
        && (target.matches('button, a, input, select, textarea, [role="slider"]'));
      const isPlayerInteractionKey = ['Tab', ' ', 'Enter', 'Escape', 'BrowserBack', 'Backspace',
        'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
        || ['f', 'm'].includes(event.key.toLowerCase());
      if (isPlayerInteractionKey) {
        keyboardInteractionRef.current = true;
        controlsFocusedRef.current = target instanceof Element
          && Boolean(target.closest('.player-controls'));
        revealControls();
      }
      if (event.key === 'Escape' && openTrackMenuRef.current) {
        event.preventDefault();
        closeTrackMenuRef.current();
        return;
      }
      if (event.key === 'Escape' || event.key === 'BrowserBack'
        || (event.key === 'Backspace' && !isControl)) {
        if (target instanceof HTMLSelectElement) return;
        event.preventDefault();
        if (isFullscreenRef.current || document.fullscreenElement || document.webkitFullscreenElement) {
          void toggleFullscreen();
          return;
        }
        navigate(episodeOwner ? `/series/${episodeOwner.id}` : `/movie/${id}`);
        return;
      }
      if (isControl) return;
      const video = videoRef.current;
      if (!video) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (video.paused) {
          try {
            const request = video.play();
            if (request && typeof request.catch === 'function') {
              void request.catch(() => playbackErrorRef.current('Playback was blocked. Press play again to continue.'));
            }
          } catch {
            playbackErrorRef.current('Playback was blocked. Press play again to continue.');
          }
        } else video.pause();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        if (event.target !== video && document.activeElement !== video) return;
        event.preventDefault();
        seekToRef.current((pendingSeekRef.current ?? currentTimeRef.current)
          + (event.key === 'ArrowRight' ? 10 : -10));
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (event.target !== video && document.activeElement !== video) return;
        event.preventDefault();
        video.volume = Math.max(0, Math.min(1, video.volume + (event.key === 'ArrowUp' ? 0.05 : -0.05)));
      } else if (event.key.toLowerCase() === 'm') {
        video.muted = !video.muted;
      } else if (event.key.toLowerCase() === 'f') {
        void toggleFullscreen();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    episodeOwner,
    id,
    navigate,
    openTrackMenuRef,
    closeTrackMenuRef,
    currentTimeRef,
    pendingSeekRef,
    playbackErrorRef,
    revealControls,
    seekToRef,
    toggleFullscreen,
    videoRef,
  ]);

  const handleControlsFocus = useCallback(() => {
    controlsFocusedRef.current = keyboardInteractionRef.current;
    revealControls();
  }, [revealControls]);

  const handleControlsBlur = useCallback((event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    controlsFocusedRef.current = false;
    if (!controlsVisible) return;
    revealControls();
  }, [controlsVisible, revealControls]);

  const handlePlayerPointerInteraction = useCallback(() => {
    keyboardInteractionRef.current = false;
    controlsFocusedRef.current = false;
    revealControls();
  }, [revealControls]);

  const handlePlayerKeyDown = useCallback((event) => {
    const isPlayerInteractionKey = ['Tab', ' ', 'Enter', 'Escape', 'BrowserBack', 'Backspace',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      || ['f', 'm'].includes(event.key.toLowerCase());
    if (!isPlayerInteractionKey) return;
    keyboardInteractionRef.current = true;
    const activeElement = document.activeElement;
    controlsFocusedRef.current = activeElement instanceof Element
      && Boolean(activeElement.closest('.player-controls'));
    revealControls();
  }, [revealControls]);

  const handleSeekStart = useCallback(() => {
    seekingRef.current = true;
    window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = null;
    setControlsVisible(true);
  }, []);

  const handleSeekEnd = useCallback(() => {
    seekingRef.current = false;
    revealControls();
  }, [revealControls]);

  return {
    controlsFocusedRef,
    controlsTimerRef,
    controlsVisible,
    handleControlsBlur,
    handleControlsFocus,
    handlePlayerKeyDown,
    handlePlayerPointerInteraction,
    handleSeekEnd,
    handleSeekStart,
    isFullscreen,
    isFullscreenRef,
    keyboardInteractionRef,
    playingRef,
    revealControls,
    seekingRef,
    setControlsVisible,
    toggleFullscreen,
  };
}
