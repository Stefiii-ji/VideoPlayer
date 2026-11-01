import { useCallback, useRef } from 'react';

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

export function useResumeProgress({
  id,
  progress,
  startFromBeginning,
  videoRef,
  playbackRef,
  currentTimeRef,
  pendingSeekRef,
  seekIntentRef,
  resumePlayingRef,
  resumeAppliedRef,
  applyPendingSeekRef,
  updateTimeline,
  setCurrentTime,
  setPlaybackError,
  saveProgress,
}) {
  const progressRef = useRef(progress);
  progressRef.current = progress;

  const handleLoadedMetadata = useCallback((video) => {
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
  }, [
    applyPendingSeekRef,
    currentTimeRef,
    id,
    pendingSeekRef,
    playbackRef,
    progressRef,
    resumeAppliedRef,
    resumePlayingRef,
    seekIntentRef,
    setCurrentTime,
    setPlaybackError,
    startFromBeginning,
    updateTimeline,
  ]);

  const getDurationForVideo = useCallback((video) => {
    return getMediaDuration(video, playbackRef.current?.metadata);
  }, [playbackRef]);

  const saveProgressForVideo = useCallback((video, completed = false) => {
    saveProgress(id, video.currentTime, getDurationForVideo(video), completed);
  }, [getDurationForVideo, id, saveProgress]);

  return { getDurationForVideo, handleLoadedMetadata, saveProgressForVideo };
}
