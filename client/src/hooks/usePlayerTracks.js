import { useCallback, useEffect, useRef, useState } from 'react';
import { movieApi } from '../services/api.js';

export function usePlayerTracks({
  id,
  videoRef,
  pendingSeekRef,
  seekIntentRef,
  currentTimeRef,
  resumePlayingRef,
  requestPlaybackRef,
  revealControls,
  controlsTimerRef,
  setControlsVisible,
  openTrackMenuRef,
}) {
  const subtitleTrackRef = useRef(null);
  const audioRequestControllerRef = useRef(null);
  const [subtitles, setSubtitles] = useState([]);
  const [selectedSubtitle, setSelectedSubtitle] = useState('');
  const [selectedAudio, setSelectedAudio] = useState('');
  const [openTrackMenu, setOpenTrackMenu] = useState(null);

  const changeTrackMenu = useCallback((menu) => {
    const nextMenu = openTrackMenuRef.current === menu ? null : menu;
    openTrackMenuRef.current = nextMenu;
    setOpenTrackMenu(nextMenu);
    if (nextMenu) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
      setControlsVisible(true);
    } else {
      revealControls();
    }
  }, [controlsTimerRef, openTrackMenuRef, revealControls, setControlsVisible]);

  const closeTrackMenu = useCallback(() => {
    if (!openTrackMenuRef.current) return;
    openTrackMenuRef.current = null;
    setOpenTrackMenu(null);
    revealControls();
  }, [revealControls]);

  useEffect(() => {
    if (!openTrackMenu) return undefined;
    function closeOnOutsidePointer(event) {
      if (event.target instanceof Element && !event.target.closest('.player-track-controls')) {
        closeTrackMenu();
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [closeTrackMenu, openTrackMenu]);

  useEffect(() => {
    let effectActive = true;
    openTrackMenuRef.current = null;
    setOpenTrackMenu(null);
    setSelectedAudio('');
    setSelectedSubtitle('');
    setSubtitles([]);
    audioRequestControllerRef.current?.abort();
    audioRequestControllerRef.current = null;

    movieApi.subtitles(id).then((result) => {
      if (!effectActive) return;
      setSubtitles(result.subtitles ?? []);
    }).catch((error) => {
      if (effectActive) console.warn(`Subtitle tracks could not be loaded: ${error.message}`);
    });

    return () => {
      effectActive = false;
      audioRequestControllerRef.current?.abort();
      audioRequestControllerRef.current = null;
    };
  }, [id]);

  const changeAudioTrack = useCallback((value) => {
    if (value === '' || !videoRef.current) return;
    const streamIndex = Number(value);
    if (!Number.isInteger(streamIndex)) return;
    audioRequestControllerRef.current?.abort();
    const controller = new AbortController();
    audioRequestControllerRef.current = controller;
    pendingSeekRef.current = videoRef.current.currentTime;
    seekIntentRef.current = null;
    currentTimeRef.current = videoRef.current.currentTime;
    resumePlayingRef.current = !videoRef.current.paused;
    void requestPlaybackRef.current({ audioStreamIndex: streamIndex, signal: controller.signal }).then((result) => {
      if (audioRequestControllerRef.current !== controller || result || controller.signal.aborted) return;
      pendingSeekRef.current = null;
      resumePlayingRef.current = false;
    });
  }, [
    currentTimeRef,
    pendingSeekRef,
    requestPlaybackRef,
    resumePlayingRef,
    seekIntentRef,
    videoRef,
  ]);

  return {
    changeAudioTrack,
    changeTrackMenu,
    closeTrackMenu,
    openTrackMenu,
    openTrackMenuRef,
    selectedAudio,
    selectedSubtitle,
    setSelectedAudio,
    setSelectedSubtitle,
    subtitles,
    subtitleTrackRef,
  };
}
