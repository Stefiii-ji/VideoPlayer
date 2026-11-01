const CONTAINER_ALIASES = new Map([
  ['mp4', ['mp4', 'mov', 'm4v', 'isom', '3gp', '3g2', 'mj2']],
  ['webm', ['webm']],
  ['mkv', ['matroska']],
  ['avi', ['avi']],
  ['mpeg', ['mpeg', 'mpegps']],
  ['mpegts', ['mpegts']],
]);
const VIDEO_CODEC_ALIASES = new Map([
  ['h264', ['h264', 'avc']],
  ['hevc', ['hevc', 'h265']],
  ['vp9', ['vp9']],
  ['vp8', ['vp8']],
  ['av1', ['av1']],
  ['mpeg4', ['mpeg4']],
  ['mpeg2video', ['mpeg2video']],
]);
const AUDIO_CODEC_ALIASES = new Map([
  ['aac', ['aac']],
  ['mp3', ['mp3']],
  ['ac3', ['ac3']],
  ['eac3', ['eac3']],
  ['opus', ['opus']],
  ['vorbis', ['vorbis']],
  ['flac', ['flac']],
  ['mp2', ['mp2']],
]);
const H264_LEVEL_LIMITS = [
  [20, 99, 1_485],
  [21, 396, 3_000],
  [22, 396, 6_000],
  [30, 1_620, 40_500],
  [31, 3_600, 108_000],
  [32, 5_120, 216_000],
  [40, 8_192, 245_760],
  [41, 8_192, 245_760],
  [42, 8_704, 522_240],
  [50, 22_080, 589_824],
  [51, 36_864, 983_040],
  [52, 36_864, 2_073_600],
  [60, 36_864, 4_177_920],
  [61, 139_264, 8_355_840],
  [62, 139_264, 16_711_680],
];

function capabilitySupported(capabilities, category, codec) {
  return capabilities?.[category]?.[codec] === true;
}

function audioStreamSupported(audio, capabilities) {
  const codec = recognizedCodec(audio?.codec, AUDIO_CODEC_ALIASES);
  if (!audio || !codec || !capabilitySupported(capabilities, 'audioCodecs', codec)) return false;
  if (codec !== 'aac') return true;
  return audio.profile?.toLowerCase() === 'lc'
    && capabilities.audioProfiles?.aac?.lc === true;
}

function videoProfileKey(video, codec) {
  const profile = video.profile?.toLowerCase();
  if (!profile) return null;
  if (codec === 'h264') {
    if (/high\s*(?:10|4:2:2|4:4:4)/.test(profile)) return null;
    return profile.includes('baseline') ? 'baseline'
      : profile.includes('main') ? 'main'
      : profile.includes('high') ? 'high'
        : null;
  }
  if (codec === 'hevc') return profile.includes('main 10') ? 'main10' : profile === 'main' ? 'main' : null;
  if (codec === 'vp9') return profile.includes('profile 0') ? 'profile0' : profile.includes('profile 2') ? 'profile2' : null;
  if (codec === 'av1') return profile === 'main' ? 'main' : null;
  return null;
}

function videoProfileSupported(video, codec, capabilities) {
  if (video.bitDepth > 8 && capabilities.videoBitDepth?.[codec] !== true) return false;
  const profiles = capabilities.videoProfiles?.[codec];
  if (!profiles) return true;
  const profile = videoProfileKey(video, codec);
  if (!profile || profiles[profile] !== true) return false;
  if ((codec === 'hevc' && profile === 'main10')
    || (codec === 'vp9' && profile === 'profile2')) {
    if (capabilities.videoBitDepth?.[codec] !== true) return false;
  }
  return video.level != null
    && capabilities.videoLevels?.[codec]?.[profile]?.includes(video.level) === true;
}

function videoPixelFormatSupported(video, codec) {
  if (!['h264', 'hevc', 'vp9', 'vp8', 'av1'].includes(codec)) return true;
  const format = video.pixelFormat?.toLowerCase();
  if (!format) return false;
  const is8Bit420 = ['yuv420p', 'yuvj420p', 'nv12', 'nv21'].includes(format);
  const is10Bit420 = /^(?:yuv420p10(?:le|be)?|p010(?:le|be)?)$/.test(format);
  if (is8Bit420) return video.bitDepth == null || video.bitDepth === 8;
  if (is10Bit420 && !['h264', 'vp8'].includes(codec)) {
    return video.bitDepth == null || video.bitDepth === 10;
  }
  return false;
}

function mediaCapabilityForResolution(video, capabilities) {
  if (video.codec !== 'h264') return null;
  const highFrameRate = video.frameRate > 30;
  if (video.width >= 3840 || video.height >= 2160) {
    return capabilities.mediaCapabilities?.[highFrameRate ? 'h2644k60' : 'h2644k'];
  }
  if (video.width >= 1920 || video.height >= 1080) {
    return capabilities.mediaCapabilities?.[highFrameRate ? 'h2641080p60' : 'h2641080p'];
  }
  return null;
}

function mediaCapabilityIsInsufficient(video, capabilities) {
  if (video.codec === 'h264' && video.frameRate > 60) return true;
  const report = mediaCapabilityForResolution(video, capabilities);
  const is4k = video.width >= 3840 || video.height >= 2160;
  return report?.supported === false
    || report?.smooth === false
    || (is4k && report?.powerEfficient === false);
}

function outputResolution(video, capabilities) {
  const is4k = video.width >= 3840 || video.height >= 2160;
  if (!is4k) return null;
  const highFrameRate = video.frameRate > 30;
  const support4k = capabilities.mediaCapabilities?.[highFrameRate ? 'h2644k60' : 'h2644k'];
  const support1080p = capabilities.mediaCapabilities?.[highFrameRate ? 'h2641080p60' : 'h2641080p'];
  const source4kInsufficient = video.frameRate > 60
    || support4k?.supported === false
    || support4k?.smooth === false
    || support4k?.powerEfficient === false;
  if (source4kInsufficient && support1080p?.supported === true && support1080p?.smooth !== false) return 1080;
  return null;
}

function requiredH264Level(video, outputHeight) {
  if (!Number.isFinite(video.width) || !Number.isFinite(video.height)
    || video.width <= 0 || video.height <= 0) return null;
  const height = outputHeight ?? video.height;
  const width = outputHeight
    ? Math.round(video.width * height / video.height)
    : video.width;
  const macroblocksPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const frameRate = Math.min(video.frameRate ?? 30, 60);
  return H264_LEVEL_LIMITS.find(([, maxFrameSize, maxMacroblocksPerSecond]) => (
    macroblocksPerFrame <= maxFrameSize
    && macroblocksPerFrame * frameRate <= maxMacroblocksPerSecond
  ))?.[0] ?? null;
}

function outputH264Settings(capabilities, video, outputHeight) {
  const requiredLevel = requiredH264Level(video, outputHeight);
  if (requiredLevel === null) return { profile: 'baseline', level: null };
  for (const profile of ['high', 'main', 'baseline']) {
    if (capabilities.videoProfiles?.h264?.[profile] !== true) continue;
    const levels = capabilities.videoLevels?.h264?.[profile];
    if (!Array.isArray(levels)) {
      if (requiredLevel <= 40) return { profile, level: requiredLevel };
      continue;
    }
    const supportedLevel = levels.filter((level) => level >= requiredLevel).sort((a, b) => a - b)[0];
    if (supportedLevel) return { profile, level: supportedLevel };
  }
  return { profile: 'baseline', level: requiredLevel };
}

export function sanitizeCapabilities(input) {
  const result = {
    containers: {},
    videoCodecs: {},
    audioCodecs: {},
    audioProfiles: { aac: {} },
    videoProfiles: { h264: {}, hevc: {}, vp9: {}, av1: {} },
    videoLevels: { h264: {}, hevc: {}, vp9: {}, av1: {} },
    videoBitDepth: {},
    mediaCapabilities: {},
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;

  for (const [category, allowed] of [
    ['containers', ['mp4', 'webm', 'mkv', 'avi', 'mpeg', 'mpegts']],
    ['videoCodecs', [...VIDEO_CODEC_ALIASES.keys()]],
    ['audioCodecs', [...AUDIO_CODEC_ALIASES.keys()]],
  ]) {
    if (!input[category] || typeof input[category] !== 'object' || Array.isArray(input[category])) continue;
    for (const key of allowed) {
      if (typeof input[category][key] === 'boolean') result[category][key] = input[category][key];
    }
  }
  if (typeof input.audioProfiles?.aac?.lc === 'boolean') {
    result.audioProfiles.aac.lc = input.audioProfiles.aac.lc;
  }
  const allowedProfiles = {
    h264: ['baseline', 'main', 'high'],
    hevc: ['main', 'main10'],
    vp9: ['profile0', 'profile2'],
    av1: ['main'],
  };
  const levelBounds = {
    h264: [20, 62],
    hevc: [90, 186],
    vp9: [10, 62],
    av1: [8, 13],
  };
  for (const [codec, profiles] of Object.entries(allowedProfiles)) {
    for (const profile of profiles) {
      if (typeof input.videoProfiles?.[codec]?.[profile] === 'boolean') {
        result.videoProfiles[codec][profile] = input.videoProfiles[codec][profile];
      }
      const levels = input.videoLevels?.[codec]?.[profile];
      if (Array.isArray(levels)) {
        const [minimum, maximum] = levelBounds[codec];
        result.videoLevels[codec][profile] = levels.filter(
          (level) => Number.isInteger(level)
            && level >= minimum
            && level <= maximum
            && (codec !== 'h264' || H264_LEVEL_LIMITS.some(([validLevel]) => validLevel === level)),
        );
      }
    }
  }
  for (const codec of ['h264', 'hevc', 'vp9', 'av1']) {
    if (typeof input.videoBitDepth?.[codec] === 'boolean') result.videoBitDepth[codec] = input.videoBitDepth[codec];
  }
  for (const key of ['h2641080p', 'h2641080p60', 'h2644k', 'h2644k60']) {
    const report = input.mediaCapabilities?.[key];
    if (report && typeof report === 'object' && typeof report.supported === 'boolean') {
      result.mediaCapabilities[key] = {
        supported: report.supported,
        ...(typeof report.smooth === 'boolean' ? { smooth: report.smooth } : {}),
        ...(typeof report.powerEfficient === 'boolean' ? { powerEfficient: report.powerEfficient } : {}),
      };
    }
  }
  return result;
}

function recognizedCodec(codec, aliases) {
  if (!codec) return null;
  for (const [normalized, names] of aliases) {
    if (names.includes(codec.toLowerCase())) return normalized;
  }
  return null;
}

function supportedContainer(format, capabilities, fileExtension) {
  if (['.mov', '.3gp', '.3g2', '.mj2'].includes(fileExtension)) return null;
  if (!format) return null;
  const names = format.toLowerCase().split(',');
  for (const [container, aliases] of CONTAINER_ALIASES) {
    if (names.some((name) => aliases.includes(name)) && capabilities.containers[container] === true) return container;
  }
  return null;
}

export function decidePlayback(metadata, capabilityReport, { transcodingAvailable = true } = {}) {
  const capabilities = sanitizeCapabilities(capabilityReport);
  if (!metadata?.video) {
    return {
      strategy: 'direct',
      reason: 'Media metadata is unavailable; trying the original file is the safest non-destructive fallback.',
      resolution: null,
      transcodingAvailable,
      warning: 'The file could not be fully inspected. Browser compatibility is uncertain.',
    };
  }

  const video = metadata.video;
  const container = supportedContainer(
    metadata.fileExtension === '.mkv' ? 'matroska' : metadata.container,
    capabilities,
    metadata.fileExtension,
  );
  const videoCodec = recognizedCodec(video.codec, VIDEO_CODEC_ALIASES);
  const audioStreams = metadata.audioStreams ?? [];
  const videoSupported = Boolean(videoCodec)
    && capabilitySupported(capabilities, 'videoCodecs', videoCodec)
    && videoProfileSupported(video, videoCodec, capabilities)
    && videoPixelFormatSupported(video, videoCodec)
    && !mediaCapabilityIsInsufficient({ ...video, codec: videoCodec }, capabilities);
  const audioSupported = audioStreams.every((audio) => audioStreamSupported(audio, capabilities));
  const recommendedHeight = outputResolution(video, capabilities);
  const output = outputH264Settings(capabilities, video, recommendedHeight);

  if (container && videoSupported && audioSupported) {
    return {
      strategy: 'direct',
      reason: 'The browser reports support for the source container and audio/video streams.',
      resolution: null,
      outputProfile: output.profile,
      outputLevel: output.level,
      outputFrameRate: null,
      transcodingAvailable,
    };
  }

  if (videoSupported && audioSupported && !container) {
    return {
      strategy: 'remux',
      reason: 'The source streams are supported, but the source container is not.',
      resolution: null,
      outputProfile: output.profile,
      outputLevel: output.level,
      outputFrameRate: null,
      transcodingAvailable,
    };
  }

  if (videoSupported && !audioSupported) {
    return {
      strategy: 'audio-transcode',
      reason: 'The video stream is supported, but the audio stream requires conversion.',
      resolution: null,
      outputProfile: output.profile,
      outputLevel: output.level,
      outputFrameRate: null,
      transcodingAvailable,
    };
  }

  return {
    strategy: 'full-transcode',
    reason: !videoCodec
      ? 'The video codec is unknown or unsupported by the browser.'
      : !videoProfileSupported(video, videoCodec, capabilities)
        ? 'The source video profile is unsupported or could not be confirmed.'
        : !videoPixelFormatSupported(video, videoCodec)
          ? 'The source video pixel format is unsupported or could not be confirmed.'
          : 'The source combination is not confirmed as browser-compatible.',
    resolution: recommendedHeight,
    outputProfile: output.profile,
    outputLevel: output.level,
    outputFrameRate: video.frameRate > 60 ? 60 : null,
    transcodingAvailable,
    ...(recommendedHeight ? { warning: 'The browser reports no suitable 4K H.264 support; a 1080p fallback is recommended.' } : {}),
  };
}

export function ffmpegArguments({
  inputPath,
  strategy,
  audioStreamIndex = null,
  resolution = null,
  outputProfile = 'baseline',
  outputLevel = null,
  outputFrameRate = null,
  startSeconds = 0,
}) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (Number.isFinite(startSeconds) && startSeconds > 0) args.push('-ss', String(startSeconds));
  const safeResolution = Number.isInteger(resolution) && resolution >= 240 && resolution <= 4320
    ? resolution
    : null;
  args.push(
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', Number.isInteger(audioStreamIndex) && audioStreamIndex >= 0
      ? `0:${audioStreamIndex}?`
      : '0:a:0?',
  );
  if (strategy === 'remux') {
    args.push('-c:v', 'copy', '-c:a', 'copy');
  } else if (strategy === 'audio-transcode') {
    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-profile:v', ['baseline', 'main', 'high'].includes(outputProfile) ? outputProfile : 'baseline',
      ...(Number.isInteger(outputLevel) && outputLevel >= 20 && outputLevel <= 62
        ? ['-level:v', `${Math.floor(outputLevel / 10)}.${outputLevel % 10}`]
        : []),
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      ...(safeResolution ? ['-vf', `scale=-2:${safeResolution}`] : []),
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-force_key_frames', 'expr:gte(t,n_forced*6)',
      ...(Number.isFinite(outputFrameRate) && outputFrameRate > 0 && outputFrameRate <= 60
        ? ['-r', String(outputFrameRate)]
        : []),
    );
  }
  args.push(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'temp_file',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', 'segment-%06d.m4s',
    'index.m3u8',
  );
  return args;
}
