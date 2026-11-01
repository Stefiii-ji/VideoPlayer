const VIDEO_PROFILES = {
  baseline: 'avc1.42E01E',
  main: 'avc1.4D401E',
  high: 'avc1.640028',
};
const H264_LEVELS = [20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62];
const H264_PROFILE_IDS = { baseline: '42E0', main: '4D40', high: '6400' };
const HEVC_LEVELS = [93, 120, 123, 150, 153, 156, 180, 183, 186];
const VP9_LEVELS = [10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 52, 60, 61, 62];
const AV1_LEVELS = [8, 9, 10, 11, 12, 13];

function canPlay(video, type) {
  const result = video.canPlayType(type);
  return result === 'probably' || result === 'maybe';
}

async function probeMediaCapabilities(contentType, width, height, bitrate, framerate) {
  if (!navigator.mediaCapabilities?.decodingInfo) return undefined;
  let timeout;
  try {
    return await Promise.race([
      navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: { contentType, width, height, bitrate, framerate },
      }).then(({ supported, smooth, powerEfficient }) => ({
        supported,
        smooth,
        powerEfficient,
      })),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 1_500);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export async function detectPlaybackCapabilities() {
  const video = document.createElement('video');
  const audio = document.createElement('audio');
  const h264Profiles = Object.fromEntries(Object.entries(VIDEO_PROFILES).map(([profile, codec]) => [
    profile,
    canPlay(video, `video/mp4; codecs="${codec}"`),
  ]));
  const h264Levels = Object.fromEntries(Object.entries(H264_PROFILE_IDS).map(([profile, profileId]) => [
    profile,
    H264_LEVELS.filter((level) => canPlay(
      video,
      `video/mp4; codecs="avc1.${profileId}${level.toString(16).padStart(2, '0')}"`,
    )),
  ]));
  const hevcLevels = {
    main: HEVC_LEVELS.filter((level) => canPlay(video, `video/mp4; codecs="hvc1.1.6.L${level}.B0"`)),
    main10: HEVC_LEVELS.filter((level) => canPlay(video, `video/mp4; codecs="hvc1.2.4.L${level}.B0"`)),
  };
  const vp9Levels = {
    profile0: VP9_LEVELS.filter((level) => canPlay(video, `video/webm; codecs="vp09.00.${String(level).padStart(2, '0')}.08"`)),
    profile2: VP9_LEVELS.filter((level) => canPlay(video, `video/webm; codecs="vp09.02.${String(level).padStart(2, '0')}.10"`)),
  };
  const av1Levels = {
    main: AV1_LEVELS.filter((level) => canPlay(video, `video/mp4; codecs="av01.0.${String(level).padStart(2, '0')}M.08"`)),
  };
  const hevcProfiles = {
    main: hevcLevels.main.length > 0,
    main10: hevcLevels.main10.length > 0,
  };
  const vp9Profiles = {
    profile0: vp9Levels.profile0.length > 0,
    profile2: vp9Levels.profile2.length > 0,
  };
  const av1Profiles = { main: av1Levels.main.length > 0 };
  const capabilities = {
    containers: {
      mp4: canPlay(video, 'video/mp4'),
      webm: canPlay(video, 'video/webm'),
      mkv: false,
      avi: false,
      mpeg: canPlay(video, 'video/mpeg'),
      mpegts: canPlay(video, 'video/mp2t'),
    },
    videoCodecs: {
      h264: Object.values(h264Profiles).some(Boolean),
      hevc: Object.values(hevcProfiles).some(Boolean),
      vp9: vp9Profiles.profile0 || vp9Profiles.profile2,
      vp8: canPlay(video, 'video/webm; codecs="vp8"'),
      av1: av1Profiles.main,
      mpeg4: canPlay(video, 'video/mp4; codecs="mp4v.20.8"'),
      mpeg2video: canPlay(video, 'video/mpeg; codecs="mp2v"'),
    },
    audioCodecs: {
      aac: canPlay(audio, 'audio/mp4; codecs="mp4a.40.2"'),
      mp3: canPlay(audio, 'audio/mpeg; codecs="mp3"'),
      ac3: canPlay(audio, 'audio/mp4; codecs="ac-3"'),
      eac3: canPlay(audio, 'audio/mp4; codecs="ec-3"'),
      opus: canPlay(audio, 'audio/webm; codecs="opus"'),
      vorbis: canPlay(audio, 'audio/webm; codecs="vorbis"'),
      flac: canPlay(audio, 'audio/flac; codecs="flac"'),
      mp2: canPlay(audio, 'audio/mpeg; codecs="mp2"'),
    },
    audioProfiles: {
      aac: { lc: canPlay(audio, 'audio/mp4; codecs="mp4a.40.2"') },
    },
    videoProfiles: {
      h264: h264Profiles,
      hevc: hevcProfiles,
      vp9: vp9Profiles,
      av1: av1Profiles,
    },
    videoLevels: {
      h264: h264Levels,
      hevc: hevcLevels,
      vp9: vp9Levels,
      av1: av1Levels,
    },
    videoBitDepth: {
      h264: canPlay(video, 'video/mp4; codecs="avc1.6E0033"'),
      hevc: hevcProfiles.main10,
      vp9: vp9Profiles.profile2,
      av1: canPlay(video, 'video/mp4; codecs="av01.0.08M.10"'),
    },
    mediaCapabilities: {},
  };
  const reports = await Promise.all([
    probeMediaCapabilities('video/mp4; codecs="avc1.640028"', 1920, 1080, 8_000_000, 30),
    probeMediaCapabilities('video/mp4; codecs="avc1.640033"', 3840, 2160, 25_000_000, 30),
    probeMediaCapabilities('video/mp4; codecs="avc1.64002A"', 1920, 1080, 16_000_000, 60),
    probeMediaCapabilities('video/mp4; codecs="avc1.640034"', 3840, 2160, 50_000_000, 60),
  ]);
  if (reports[0]) capabilities.mediaCapabilities.h2641080p = reports[0];
  if (reports[1]) capabilities.mediaCapabilities.h2644k = reports[1];
  if (reports[2]) capabilities.mediaCapabilities.h2641080p60 = reports[2];
  if (reports[3]) capabilities.mediaCapabilities.h2644k60 = reports[3];
  return capabilities;
}
