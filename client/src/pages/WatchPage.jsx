import { ArrowLeft, Captions, Check, FastForward, Film, Languages, Maximize, Minimize, Pause, Play, Rewind, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLibrary } from '../context/LibraryContext.jsx';
import { movieApi } from '../services/api.js';
import { usePlaybackSession } from '../hooks/usePlaybackSession.js';
import { useHlsPlayer } from '../hooks/useHlsPlayer.js';
import { usePlayerTracks } from '../hooks/usePlayerTracks.js';
import { getSeekableTimeline, resolveSeekTime } from '../services/media-timeline.js';
import './WatchPage.css';

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

function describeAudioTrack(track, position) {
  const details = [
    track.language,
    track.title,
    track.codec?.toUpperCase(),
    track.channels ? `${track.channels} ch` : null,
  ].filter(Boolean);
  return `${track.isDefault ? 'Default · ' : ''}Track ${position + 1}${details.length ? ` · ${details.join(' · ')}` : ''}`;
}

function getMediaDuration(video, mediaMetadata) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  return Number.isFinite(mediaMetadata?.duration) && mediaMetadata.duration > 0
    ? mediaMetadata.duration
    : 0;
}

function playVideo(video, onFailure) {
  try {
    const request = video.play();
    if (request && typeof request.catch === 'function') void request.catch(onFailure);
  } catch {
    onFailure();
  }
}

export default function WatchPage() {
  const { id } = useParams();
  const { movies, series, loading, progress, saveProgress } = useLibrary();
  const location = useLocation();
  const navigate = useNavigate();
  const episodeOwner = series.find((item) => item.seasons.some((season) => season.episodes.some((episode) => episode.id === id)));
  const movie = movies.find((item) => item.id === id)
    ?? episodeOwner?.seasons.flatMap((season) => season.episodes).find((episode) => episode.id === id);
  const orderedEpisodes = useMemo(() => episodeOwner
    ? episodeOwner.seasons
      .slice()
      .sort((left, right) => left.number - right.number)
      .flatMap((season) => season.episodes
        .slice()
        .sort((left, right) => left.episodeNumber - right.episodeNumber))
    : [], [episodeOwner]);
  const currentEpisodeIndex = orderedEpisodes.findIndex((episode) => episode.id === id);
  const previousEpisode = currentEpisodeIndex > 0 ? orderedEpisodes[currentEpisodeIndex - 1] : null;
  const nextEpisode = currentEpisodeIndex >= 0 ? orderedEpisodes[currentEpisodeIndex + 1] ?? null : null;
  const startFromBeginning = location.state?.startFromBeginning === true;
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const progressRef = useRef(progress);
  const applyPendingSeekRef = useRef(() => false);
  const seekToRef = useRef(() => false);
  const toggleFullscreenRef = useRef(() => Promise.resolve());
  const isFullscreenRef = useRef(false);
  const currentTimeRef = useRef(0);
  const pendingSeekRef = useRef(null);
  const seekIntentRef = useRef(null);
  const resumePlayingRef = useRef(false);
  const resumeAppliedRef = useRef(false);
  const lastTimeRenderRef = useRef(0);
  const controlsTimerRef = useRef(null);
  const playingRef = useRef(false);
  const openTrackMenuRef = useRef(null);
  const seekingRef = useRef(false);
  const controlsFocusedRef = useRef(false);
  const keyboardInteractionRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekableStart, setSeekableStart] = useState(0);
  const [seekableEnd, setSeekableEnd] = useState(0);
  const [hasSeekableRange, setHasSeekableRange] = useState(false);
  const [canSeek, setCanSeek] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [suggestNext, setSuggestNext] = useState(false);
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
  }, []);

  const requestPlaybackRef = useRef(() => Promise.resolve(null));
  const {
    changeAudioTrack,
    changeTrackMenu,
    closeTrackMenu,
    openTrackMenu,
    selectedAudio,
    selectedSubtitle,
    setSelectedAudio,
    setSelectedSubtitle,
    subtitles,
    subtitleTrackRef,
  } = usePlayerTracks({
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
  });

  const resetPlaybackUi = useCallback(() => {
    resumeAppliedRef.current = false;
    currentTimeRef.current = 0;
    pendingSeekRef.current = null;
    seekIntentRef.current = null;
    setCurrentTime(0);
    setDuration(0);
    setSeekableStart(0);
    setSeekableEnd(0);
    setHasSeekableRange(false);
    setCanSeek(false);
    setPlaying(false);
    playingRef.current = false;
    setSuggestNext(false);
  }, []);

  const {
    attemptFallback,
    fallbackUrl,
    playback,
    playbackError,
    playbackGeneration,
    playbackLoading,
    playbackRef,
    requestPlayback,
    resetFallback,
    setFallbackUrl,
    setPlaybackError,
    stopPlaybackSessions,
    stoppedSessionsRef,
    tryOriginalFile,
  } = usePlaybackSession({
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
  });
  requestPlaybackRef.current = requestPlayback;

  useEffect(() => () => {
    window.clearTimeout(controlsTimerRef.current);
  }, []);

  progressRef.current = progress;

  const applyPendingSeek = useCallback(() => {
    const video = videoRef.current;
    const requestedTime = pendingSeekRef.current;
    if (!video || requestedTime === null || video.readyState < 1) return false;
    const timeline = getSeekableTimeline(video, playbackRef.current?.metadata?.duration);
    const finiteMediaDuration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : 0;
    const nextTime = resolveSeekTime(requestedTime, timeline)
      ?? (timeline.ranges.length > 0 && finiteMediaDuration && requestedTime <= finiteMediaDuration
        ? requestedTime
        : null);
    if (nextTime === null) {
      const lastRange = timeline.ranges[timeline.ranges.length - 1];
      if (lastRange && requestedTime > lastRange.end && timeline.timelineEnd <= lastRange.end) {
        pendingSeekRef.current = null;
        seekIntentRef.current = null;
        currentTimeRef.current = video.currentTime;
        setCurrentTime(video.currentTime);
      }
      return false;
    }

    try {
      video.currentTime = nextTime;
      currentTimeRef.current = nextTime;
      seekIntentRef.current = nextTime;
      pendingSeekRef.current = null;
      resumeAppliedRef.current = true;
      setCurrentTime(nextTime);
      if (resumePlayingRef.current) {
        resumePlayingRef.current = false;
        playVideo(video, () => setPlaybackError('Playback was blocked after changing playback modes.'));
      }
      return true;
    } catch {
      pendingSeekRef.current = null;
      seekIntentRef.current = null;
      resumePlayingRef.current = false;
      currentTimeRef.current = video.currentTime;
      setCurrentTime(video.currentTime);
      setPlaybackError('The browser could not seek to that position. Choose a position in the available timeline.');
      return false;
    }
  }, []);

  const updateTimeline = useCallback((video) => {
    const timeline = getSeekableTimeline(video, playbackRef.current?.metadata?.duration);
    setDuration((previous) => Math.abs(previous - timeline.duration) < 0.25 ? previous : timeline.duration);
    setSeekableStart((previous) => Math.abs(previous - timeline.seekableStart) < 0.25 ? previous : timeline.seekableStart);
    setSeekableEnd((previous) => Math.abs(previous - timeline.seekableEnd) < 0.25 ? previous : timeline.seekableEnd);
    setHasSeekableRange(timeline.ranges.length > 0);
    setCanSeek(timeline.ranges.length > 0 || timeline.duration > 0);
    applyPendingSeek();
  }, [applyPendingSeek]);
  applyPendingSeekRef.current = applyPendingSeek;

  const activeHlsRef = useHlsPlayer({
    id,
    videoRef,
    playback,
    playbackGeneration,
    updateTimeline,
    setPlaybackError,
    attemptFallback,
    tryOriginalFile,
  });

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
  }, []);

  useEffect(() => {
    const textTrack = subtitleTrackRef.current?.track;
    if (textTrack) textTrack.mode = selectedSubtitle ? 'showing' : 'disabled';
  }, [selectedSubtitle, subtitles, playback?.url]);

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
        closeTrackMenu();
        return;
      }
      if (event.key === 'Escape' || event.key === 'BrowserBack'
        || (event.key === 'Backspace' && !isControl)) {
        if (target instanceof HTMLSelectElement) return;
        event.preventDefault();
        if (isFullscreenRef.current || document.fullscreenElement || document.webkitFullscreenElement) {
          void toggleFullscreenRef.current();
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
        if (video.paused) playVideo(video, () => setPlaybackError('Playback was blocked. Press play again to continue.'));
        else video.pause();
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
        void toggleFullscreenRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [episodeOwner, id, navigate, revealControls]);

  function selectEpisode(episode) {
    if (!episode) return;
    navigate(`/watch/${episode.id}`, { state: { startFromBeginning: true } });
  }

  function seekTo(value) {
    const nextTime = Number(value);
    const video = videoRef.current;
    if (!Number.isFinite(nextTime) || !video) return false;
    pendingSeekRef.current = null;
    seekIntentRef.current = null;
    const timeline = getSeekableTimeline(video, playbackRef.current?.metadata?.duration);
    const resolvedTime = resolveSeekTime(nextTime, timeline);
    if (video.readyState < 1) {
      if (nextTime < 0 || (timeline.timelineEnd && nextTime > timeline.timelineEnd)) {
        currentTimeRef.current = video.currentTime;
        setCurrentTime(video.currentTime);
        return false;
      }
      const requestedTime = resolvedTime ?? nextTime;
      pendingSeekRef.current = requestedTime;
      seekIntentRef.current = requestedTime;
      currentTimeRef.current = requestedTime;
      setCurrentTime(requestedTime);
      return true;
    }
    if (resolvedTime === null) {
      if (nextTime >= 0 && (!timeline.timelineEnd || nextTime <= timeline.timelineEnd)) {
        pendingSeekRef.current = nextTime;
        seekIntentRef.current = nextTime;
        if (timeline.ranges.length > 0
          && Number.isFinite(video.duration) && video.duration > 0
          && nextTime <= video.duration) {
          return applyPendingSeekRef.current();
        }
        currentTimeRef.current = nextTime;
        setCurrentTime(nextTime);
        const lastRange = timeline.ranges[timeline.ranges.length - 1];
        if (activeHlsRef.current && lastRange && nextTime > lastRange.end
          && nextTime <= timeline.timelineEnd) {
          try {
            video.currentTime = nextTime;
          } catch {
            pendingSeekRef.current = null;
            seekIntentRef.current = null;
            currentTimeRef.current = video.currentTime;
            setCurrentTime(video.currentTime);
            return false;
          }
        }
        return true;
      }
      currentTimeRef.current = video.currentTime;
      setCurrentTime(video.currentTime);
      return false;
    }
    try {
      video.currentTime = resolvedTime;
      currentTimeRef.current = resolvedTime;
      seekIntentRef.current = resolvedTime;
      setCurrentTime(resolvedTime);
      return true;
    } catch {
      seekIntentRef.current = null;
      currentTimeRef.current = video.currentTime;
      setCurrentTime(video.currentTime);
      setPlaybackError('The browser could not seek to that position. Choose a position in the available timeline.');
      return false;
    }
  }

  async function toggleFullscreen() {
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
      setPlaybackError(`Fullscreen could not be opened: ${error.message}`);
    }
  }

  function toggleVideoPlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) playVideo(video, () => setPlaybackError('Playback was blocked. Press play again to continue.'));
    else video.pause();
  }

  function handleControlsFocus() {
    controlsFocusedRef.current = keyboardInteractionRef.current;
    revealControls();
  }

  function handleControlsBlur(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    controlsFocusedRef.current = false;
    if (!controlsVisible) return;
    revealControls();
  }

  function handlePlayerPointerInteraction() {
    keyboardInteractionRef.current = false;
    controlsFocusedRef.current = false;
    revealControls();
  }

  function handlePlayerKeyDown(event) {
    const isPlayerInteractionKey = ['Tab', ' ', 'Enter', 'Escape', 'BrowserBack', 'Backspace',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      || ['f', 'm'].includes(event.key.toLowerCase());
    if (!isPlayerInteractionKey) return;
    keyboardInteractionRef.current = true;
    const activeElement = document.activeElement;
    controlsFocusedRef.current = activeElement instanceof Element
      && Boolean(activeElement.closest('.player-controls'));
    revealControls();
  }

  function handleSeekStart() {
    seekingRef.current = true;
    window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = null;
    setControlsVisible(true);
  }

  function handleSeekEnd() {
    seekingRef.current = false;
    revealControls();
  }

  seekToRef.current = seekTo;
  toggleFullscreenRef.current = toggleFullscreen;

  if (!movie && loading) return <main className="watch-missing"><div className="skeleton poster-skeleton" /></main>;
  if (!movie) return <main className="watch-missing"><Film size={30} /><h1>Movie unavailable</h1><Link to="/">Return to library</Link></main>;

  const audioStreams = playback?.metadata?.audioStreams ?? [];
  const seekSliderStart = hasSeekableRange ? seekableStart : 0;
  const mediaDuration = videoRef.current?.duration;
  const seekSliderEnd = hasSeekableRange
    ? Number.isFinite(mediaDuration) && mediaDuration > 0
      ? Math.max(seekableEnd, mediaDuration)
      : seekableEnd
    : duration;

  return (
    <main className="watch-page">
      <div className="watch-topbar">
        <Link to={episodeOwner ? `/series/${episodeOwner.id}` : `/movie/${id}`} aria-label="Back to movie details">
          <ArrowLeft size={20} /> <span>{episodeOwner ? 'Back to series' : 'Back to details'}</span>
        </Link>
        <span>{movie.title}</span>
      </div>
      <div
        className={`player-shell${playing && !controlsVisible ? ' player-cursor-hidden' : ''}`}
        ref={playerRef}
        onPointerMove={handlePlayerPointerInteraction}
        onPointerDown={handlePlayerPointerInteraction}
        onClick={revealControls}
        onKeyDownCapture={handlePlayerKeyDown}
      >
      <div
        className="video-wrap"
        onClick={(event) => {
          revealControls();
          if (event.target instanceof Element && event.target.closest('button')) return;
          toggleVideoPlayback();
        }}
      >
        <video
          ref={videoRef}
          tabIndex={0}
          playsInline
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (!resumeAppliedRef.current && pendingSeekRef.current === 0 && seekIntentRef.current === null) {
              pendingSeekRef.current = null;
            }
            if (pendingSeekRef.current === null && seekIntentRef.current === null) {
              currentTimeRef.current = video.currentTime;
              setCurrentTime(video.currentTime);
            }
            updateTimeline(video);
            if (pendingSeekRef.current === null && !resumeAppliedRef.current) {
              const resumeAt = startFromBeginning ? null : progressRef.current[id]?.currentTime;
              if (Number.isFinite(resumeAt) && resumeAt > 0) {
                pendingSeekRef.current = resumeAt;
                resumePlayingRef.current = true;
              } else {
                resumeAppliedRef.current = true;
                playVideo(video, () => setPlaybackError('Playback was blocked. Press play again to continue.'));
              }
            }
            applyPendingSeekRef.current();
          }}
          onDurationChange={(event) => updateTimeline(event.currentTarget)}
          onProgress={(event) => updateTimeline(event.currentTarget)}
          onLoadedData={(event) => updateTimeline(event.currentTarget)}
          onSeeked={(event) => {
            const video = event.currentTarget;
            updateTimeline(video);
            if (pendingSeekRef.current !== null) return;
            const requestedTime = seekIntentRef.current;
            if (requestedTime !== null && Math.abs(video.currentTime - requestedTime) > 0.5) {
              const timeline = getSeekableTimeline(video, playbackRef.current?.metadata?.duration);
              const resolvedTime = resolveSeekTime(requestedTime, timeline);
              if (resolvedTime !== null) {
                try {
                  video.currentTime = resolvedTime;
                  return;
                } catch {
                  setPlaybackError('The browser could not seek to that position. Choose a position in the available timeline.');
                }
              }
            }
            seekIntentRef.current = null;
            currentTimeRef.current = video.currentTime;
            setCurrentTime(video.currentTime);
          }}
          onPlay={() => {
            playingRef.current = true;
            setPlaying(true);
            setBuffering(false);
            revealControls();
          }}
          onPause={(event) => {
            playingRef.current = false;
            setPlaying(false);
            window.clearTimeout(controlsTimerRef.current);
            controlsTimerRef.current = null;
            setControlsVisible(true);
            saveProgress(id, event.currentTarget.currentTime, getMediaDuration(event.currentTarget, playback?.metadata), true);
          }}
          onWaiting={() => setBuffering(true)}
          onCanPlay={(event) => {
            setBuffering(false);
            updateTimeline(event.currentTarget);
          }}
          onVolumeChange={(event) => {
            setMuted(event.currentTarget.muted);
            setVolume(event.currentTarget.volume);
          }}
          onTimeUpdate={(event) => {
            const video = event.currentTarget;
            const seekPending = pendingSeekRef.current !== null;
            const seekInFlight = seekIntentRef.current !== null
              && (video.seeking || Math.abs(video.currentTime - seekIntentRef.current) > 0.5);
            const now = Date.now();
            if (!seekPending && !seekInFlight) currentTimeRef.current = video.currentTime;
            if (!seekPending && !seekInFlight && now - lastTimeRenderRef.current >= 500) {
              lastTimeRenderRef.current = now;
              setCurrentTime(video.currentTime);
            }
            if (!video.seeking && !seekInFlight && !seekPending) seekIntentRef.current = null;
            const mediaDuration = getMediaDuration(video, playback?.metadata);
            setDuration(mediaDuration);
            if (!seekPending && !seekInFlight) saveProgress(id, video.currentTime, mediaDuration);
            updateTimeline(video);
          }}
          onEnded={() => {
            playingRef.current = false;
            pendingSeekRef.current = null;
            seekIntentRef.current = null;
            setPlaying(false);
            setControlsVisible(true);
            setSuggestNext(Boolean(nextEpisode));
            if (playback?.sessionId) stoppedSessionsRef.current.add(playback.sessionId);
            void stopPlaybackSessions().catch((error) => {
              console.warn(`Playback session cleanup failed: ${error.message}`);
            });
          }}
          onError={() => {
            playingRef.current = false;
            pendingSeekRef.current = null;
            seekIntentRef.current = null;
            setPlaying(false);
            setControlsVisible(true);
            setBuffering(false);
            setPlaybackError('The browser could not play this stream. MovieStream is trying a compatible playback mode.');
            void attemptFallback();
          }}
          aria-label={`Play ${movie.title}`}
        >
          {selectedSubtitle && <track
            ref={subtitleTrackRef}
            key={selectedSubtitle}
            kind="subtitles"
            src={movieApi.subtitleUrl(id, selectedSubtitle)}
            srcLang={subtitles.find((track) => track.id === selectedSubtitle)?.language || 'und'}
            label={subtitles.find((track) => track.id === selectedSubtitle)?.label || 'Subtitles'}
          />}
          Your browser cannot play this video format. Select another audio track or try the original file.
        </video>
        {(playbackLoading || buffering) && <div className="player-loading" role="status" aria-live="polite">
          <span className="loading-spinner" /> {playbackLoading ? 'Preparing playback…' : 'Buffering…'}
        </div>}
        {!playing && <div className="video-overlay">
          {playbackLoading
            ? <><span className="eyebrow">PREPARING PLAYBACK</span><h1>{movie.title}</h1><span>Checking browser support and selecting a playback method…</span></>
            : playbackError
              ? <><span className="eyebrow">PLAYBACK ISSUE</span><h1>{playbackError}</h1>
                <div className="player-error-actions">
                  <button aria-label="Retry playback" onClick={() => {
                    resetFallback();
                    const video = videoRef.current;
                    if (video) {
                      pendingSeekRef.current = video.currentTime > 0 ? video.currentTime : null;
                      currentTimeRef.current = video.currentTime;
                      resumePlayingRef.current = true;
                    }
                    void requestPlayback();
                  }}><Play fill="currentColor" /> Retry playback</button>
                  {fallbackUrl && <button aria-label="Try original file" onClick={() => void tryOriginalFile()}><Play fill="currentColor" /> Try original file</button>}
                </div>
                <span>Check the message above, then retry or use the original file if available.</span>
              </>
              : suggestNext && nextEpisode
                ? <><span className="eyebrow">UP NEXT</span><h1>{nextEpisode.title}</h1><button aria-label="Play next episode" onClick={() => selectEpisode(nextEpisode)}><Play fill="currentColor" /></button><span>Next episode · {episodeOwner.title}</span></>
                : <><span className="eyebrow">{playback?.decision.strategy === 'direct' ? 'NOW PLAYING' : 'PREPARING COMPATIBLE STREAM'}</span><h1>{movie.title}</h1><button aria-label="Play video" onClick={() => { setPlaybackError(''); const video = videoRef.current; if (video) playVideo(video, () => setPlaybackError('Playback was blocked. Press play again to continue.')); }}><Play fill="currentColor" /></button><span>Space to play · ← → to seek · F fullscreen · Esc back</span></>}
        </div>}
      </div>
      <div
        className={`player-controls${controlsVisible ? '' : ' controls-hidden'}`}
        aria-label="Playback controls"
        aria-hidden={!controlsVisible}
        onFocusCapture={handleControlsFocus}
        onBlurCapture={handleControlsBlur}
      >
        <div className="player-seek-row">
          <span aria-label="Current time">{formatTime(currentTime)}</span>
          <input
            aria-label="Seek"
            type="range"
            min={seekSliderStart}
            max={seekSliderEnd}
            step="1"
            value={Math.max(
              seekSliderStart,
              Math.min(currentTime, seekSliderEnd),
            )}
            onChange={(event) => seekTo(event.currentTarget.value)}
            onPointerDown={handleSeekStart}
            onPointerUp={handleSeekEnd}
            onPointerCancel={handleSeekEnd}
            disabled={!canSeek}
          />
          <span aria-label="Duration">{formatTime(duration)}</span>
        </div>
        <div className="player-action-row">
          <div className="player-transport">
            <button type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={toggleVideoPlayback}>{playing ? <Pause /> : <Play />}</button>
            <button type="button" aria-label="Seek backward 10 seconds" disabled={!canSeek} onClick={() => seekTo((pendingSeekRef.current ?? currentTimeRef.current) - 10)}><Rewind /></button>
            <button type="button" aria-label="Seek forward 10 seconds" disabled={!canSeek} onClick={() => seekTo((pendingSeekRef.current ?? currentTimeRef.current) + 10)}><FastForward /></button>
            <button type="button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => {
              if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
            }}>{muted ? <VolumeX /> : <Volume2 />}</button>
            <input
              aria-label="Volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onChange={(event) => {
                if (!videoRef.current) return;
                videoRef.current.volume = Number(event.currentTarget.value);
                videoRef.current.muted = Number(event.currentTarget.value) === 0;
              }}
            />
          </div>
          {episodeOwner && <div className="player-episode-controls" role="group" aria-label="Episode navigation">
            <button
              type="button"
              aria-label={previousEpisode ? `Previous episode: ${previousEpisode.title}` : 'Previous episode'}
              title={previousEpisode ? `Previous episode: ${previousEpisode.title}` : 'Previous episode'}
              disabled={!previousEpisode}
              onClick={() => selectEpisode(previousEpisode)}
            ><SkipBack /><span>Previous</span></button>
            <button
              type="button"
              aria-label={nextEpisode ? `Next episode: ${nextEpisode.title}` : 'Next episode'}
              title={nextEpisode ? `Next episode: ${nextEpisode.title}` : 'Next episode'}
              disabled={!nextEpisode}
              onClick={() => selectEpisode(nextEpisode)}
            ><SkipForward /><span>Next</span></button>
          </div>}
          <div className="player-track-controls">
            <div className="player-track-control">
              <button
                type="button"
                aria-label="Subtitles"
                aria-haspopup="menu"
                aria-expanded={openTrackMenu === 'subtitles'}
                onClick={() => changeTrackMenu('subtitles')}
              ><Captions /></button>
              {openTrackMenu === 'subtitles' && <div className="player-track-menu" role="menu" aria-label="Subtitle tracks">
                {(subtitles.length > 0 || selectedSubtitle !== '') && <>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedSubtitle === ''}
                    onClick={() => { setSelectedSubtitle(''); closeTrackMenu(); }}
                  >{selectedSubtitle === '' && <Check />}<span>Off</span></button>
                  {subtitles.map((track) => <button
                    key={track.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedSubtitle === track.id}
                    onClick={() => { setSelectedSubtitle(track.id); closeTrackMenu(); }}
                  >{selectedSubtitle === track.id && <Check />}<span>{track.label} · {track.format}</span></button>)}
                </>}
              </div>}
            </div>
            <div className="player-track-control">
              <button
                type="button"
                aria-label="Audio tracks"
                aria-haspopup="menu"
                aria-expanded={openTrackMenu === 'audio'}
                onClick={() => changeTrackMenu('audio')}
              ><Languages /></button>
              {openTrackMenu === 'audio' && <div className="player-track-menu" role="menu" aria-label="Audio tracks">
                {audioStreams.map((track, position) => <button
                  key={track.index ?? position}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedAudio === String(track.index)}
                  onClick={() => { changeAudioTrack(String(track.index)); closeTrackMenu(); }}
                >{selectedAudio === String(track.index) && <Check />}<span>{describeAudioTrack(track, position)}</span></button>)}
              </div>}
            </div>
            <button type="button" aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => void toggleFullscreen()}>
              {isFullscreen ? <Minimize /> : <Maximize />}
            </button>
          </div>
        </div>
      </div>
      </div>
    </main>
  );
}
