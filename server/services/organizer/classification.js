import path from 'node:path';

const SUBTITLE_TYPES = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt']);
const ARTWORK_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const METADATA_TYPES = new Set(['.nfo']);
const UNSUPPORTED_VIDEO_TYPES = new Set(['.3gp', '.flv', '.m2ts', '.mts', '.ts', '.vob']);
const SEASON_PATTERN = /^(?:season|series|s)[\s._-]*(\d{1,2})$/i;
const EPISODE_PATTERN = /(?:^|[\s._-])S(\d{1,2})[\s._-]*E(\d{1,3})(?:\b|[\s._-])/i;
const ALTERNATE_EPISODE_PATTERN = /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:\b|[\s._-])/i;
const LANGUAGE_CODES = new Set([
  'en', 'eng', 'fr', 'fre', 'fra', 'de', 'ger', 'deu', 'es', 'spa', 'it', 'ita',
  'ja', 'jpn', 'ko', 'kor', 'zh', 'zho', 'ru', 'rus', 'pt', 'por', 'nl', 'nld',
  'sv', 'swe', 'da', 'dan', 'no', 'nor', 'fi', 'fin', 'pl', 'pol', 'ar', 'ara',
  'hi', 'hin', 'th', 'tha', 'tr', 'tur', 'el', 'ell', 'he', 'heb',
]);

function normalizedName(value) {
  return value
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pathParts(relativePath) {
  return relativePath.split('/').filter(Boolean);
}

function seasonFromPath(relativePath) {
  return pathParts(relativePath).map((part) => SEASON_PATTERN.exec(part)).find(Boolean);
}

function cleanTitle(value) {
  return normalizedName(value)
    .replace(/\b(?:480p|720p|1080p|1440p|2160p|4k|8k|uhd|hdr10?|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|b[dr]rip|hdtv|dvdrip|x26[45]|h26[45]|hevc|avc|aac|dts(?:[ ._-]?hd)?|multi[ ._-]?subs?)\b.*$/i, '')
    .replace(/[\s()[\]_-]+$/g, '')
    .trim();
}

function extractResolution(value) {
  const match = /\b(480|576|720|1080|1440|2160|4320)p\b|\b(4k|8k|uhd)\b/i.exec(value);
  if (!match) return null;
  return match[1] ? `${match[1]}p` : match[2].toUpperCase();
}

function extractCodec(value, patterns) {
  for (const [pattern, codec] of patterns) {
    if (pattern.test(value)) return codec;
  }
  return null;
}

function languageFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const suffix = /(?:^|[ ._-])([a-z]{2,3})(?:-[a-z]{2})?$/i.exec(stem)?.[1]?.toLowerCase();
  if (LANGUAGE_CODES.has(suffix)) return suffix;
  const tokens = stem.split(/[ ._-]+/);
  let candidate = tokens.at(-1)?.toLowerCase();
  if (['forced', 'sdh', 'cc'].includes(candidate)) candidate = tokens.at(-2)?.toLowerCase();
  return LANGUAGE_CODES.has(candidate) ? candidate : null;
}

function inferFileType(extension) {
  if (SUBTITLE_TYPES.has(extension)) return 'subtitle';
  if (ARTWORK_TYPES.has(extension)) return 'artwork';
  if (METADATA_TYPES.has(extension)) return 'metadata';
  if (UNSUPPORTED_VIDEO_TYPES.has(extension)) return 'other';
  return null;
}

function createFileClassification(record) {
  const extension = path.extname(record.name).toLowerCase();
  const supportType = inferFileType(extension);
  const rawName = path.basename(record.name, extension);
  if (supportType) {
    const language = supportType === 'subtitle' ? languageFromFilename(record.name) : null;
    return {
      classification: supportType,
      title: null,
      releaseYear: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
      seriesTitle: null,
      language,
      subtitleLanguage: language,
      resolution: null,
      videoCodec: null,
      audioCodec: null,
      confidence: 'high',
      evidence: `Recognized ${extension} ${supportType} file.`,
      warnings: supportType === 'other' ? ['This video extension is not supported by the current library scanner.'] : [],
    };
  }

  const episodeMatch = EPISODE_PATTERN.exec(rawName) ?? ALTERNATE_EPISODE_PATTERN.exec(rawName);
  const seasonFolder = seasonFromPath(record.relativePath);
  const folderParts = pathParts(record.relativePath);
  const seasonIndex = folderParts.findIndex((part) => SEASON_PATTERN.test(part));
  const seriesTitle = seasonIndex > 0
    ? cleanTitle(folderParts[seasonIndex - 1])
    : folderParts.length > 1 ? cleanTitle(folderParts.at(-2)) : null;
  if (episodeMatch) {
    const marker = episodeMatch[0].match(/S\d{1,2}E\d{1,3}|\d{1,2}x\d{1,3}/i)?.[0] ?? episodeMatch[0];
    const markerEnd = episodeMatch.index + episodeMatch[0].indexOf(marker) + marker.length;
    const episodeTitle = cleanTitle(rawName.slice(markerEnd).replace(/^[\s._-]+/, '')) || null;
    const isExplicit = EPISODE_PATTERN.test(rawName);
    const seasonNumber = Number(episodeMatch[1]);
    const episodeNumber = Number(episodeMatch[2]);
    return {
      classification: 'episode',
      title: episodeTitle ?? seriesTitle ?? cleanTitle(rawName),
      releaseYear: null,
      seasonNumber,
      episodeNumber,
      episodeTitle,
      seriesTitle,
      language: null,
      subtitleLanguage: null,
      resolution: extractResolution(rawName),
      videoCodec: extractCodec(rawName, [
        [/\b(?:x265|h265|hevc)\b/i, 'hevc'],
        [/\b(?:x264|h264|avc)\b/i, 'h264'],
        [/\bav1\b/i, 'av1'],
        [/\bvp9\b/i, 'vp9'],
      ]),
      audioCodec: extractCodec(rawName, [
        [/\btrue[ ._-]?hd\b/i, 'truehd'],
        [/\b(?:eac3|ddp)\b/i, 'eac3'],
        [/\b(?:ac3|dd)\b/i, 'ac3'],
        [/\bdts\b/i, 'dts'],
        [/\baac\b/i, 'aac'],
        [/\bmp3\b/i, 'mp3'],
        [/\bflac\b/i, 'flac'],
      ]),
      confidence: isExplicit ? 'high' : 'medium',
      evidence: `${isExplicit ? 'SxxExxx' : 'NxNN'} episode marker${seasonFolder ? ' and season folder' : ''}.`,
      warnings: seriesTitle ? [] : ['Series title could not be inferred from a containing folder.'],
    };
  }

  const yearMatch = rawName.match(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/);
  const nameWithoutYear = yearMatch
    ? rawName.slice(0, yearMatch.index) + rawName.slice(yearMatch.index + yearMatch[0].length)
    : rawName;
  const title = cleanTitle(nameWithoutYear) || null;
  const isSeasonScoped = Boolean(seasonFolder);
  const isAmbiguous = !title || title.length < 2 || /^(?:movie|video|film|unknown)$/i.test(title);
  const classification = isSeasonScoped ? 'unknown' : isAmbiguous ? 'unknown' : 'movie';
  const confidence = classification === 'unknown' || !yearMatch
    ? 'low'
    : 'high';
  const warnings = [];
  if (isSeasonScoped) warnings.push('Video is inside a season folder but has no recognizable episode number.');
  if (!yearMatch) warnings.push('Release year was not found in the filename.');
  if (isAmbiguous) warnings.push('Filename does not provide a reliable movie title.');
  return {
    classification,
    title,
    releaseYear: yearMatch ? Number(yearMatch[1]) : null,
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    seriesTitle: null,
    language: null,
    subtitleLanguage: null,
    resolution: extractResolution(rawName),
    videoCodec: extractCodec(rawName, [
      [/\b(?:x265|h265|hevc)\b/i, 'hevc'],
      [/\b(?:x264|h264|avc)\b/i, 'h264'],
      [/\bav1\b/i, 'av1'],
      [/\bvp9\b/i, 'vp9'],
    ]),
    audioCodec: extractCodec(rawName, [
      [/\btrue[ ._-]?hd\b/i, 'truehd'],
      [/\b(?:eac3|ddp)\b/i, 'eac3'],
      [/\b(?:ac3|dd)\b/i, 'ac3'],
      [/\bdts\b/i, 'dts'],
      [/\baac\b/i, 'aac'],
      [/\bmp3\b/i, 'mp3'],
      [/\bflac\b/i, 'flac'],
    ]),
    confidence,
    evidence: yearMatch ? 'Video filename contains a title and release year.' : 'Video filename has no explicit episode marker.',
    warnings,
  };
}

export function classifyOrganizerEntries(entries) {
  const episodeFolders = new Set();
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.isVideo) continue;
    const classified = createFileClassification(entry);
    if (classified.classification !== 'episode') continue;
    const parts = pathParts(entry.relativePath);
    const seasonIndex = parts.findIndex((part) => SEASON_PATTERN.test(part));
    if (seasonIndex > 0) episodeFolders.add(parts.slice(0, seasonIndex).join('/'));
    else if (parts.length > 1) episodeFolders.add(parts.slice(0, -1).join('/'));
  }

  return entries.map((entry) => {
    let result;
    if (entry.kind === 'directory') {
      const seasonMatch = SEASON_PATTERN.exec(entry.name);
      if (seasonMatch) {
        result = {
          classification: 'season',
          title: null,
          releaseYear: null,
          seasonNumber: Number(seasonMatch[1]),
          episodeNumber: null,
          episodeTitle: null,
          seriesTitle: null,
          language: null,
          subtitleLanguage: null,
          resolution: null,
          videoCodec: null,
          audioCodec: null,
          confidence: 'high',
          evidence: 'Directory name matches a season-folder pattern.',
          warnings: [],
        };
      } else if (episodeFolders.has(entry.relativePath)) {
        result = {
          classification: 'tv_series',
          title: cleanTitle(entry.name) || null,
          releaseYear: null,
          seasonNumber: null,
          episodeNumber: null,
          episodeTitle: null,
          seriesTitle: null,
          language: null,
          subtitleLanguage: null,
          resolution: null,
          videoCodec: null,
          audioCodec: null,
          confidence: 'medium',
          evidence: 'Folder contains files with recognizable episode numbering.',
          warnings: [],
        };
      } else {
        result = {
          classification: 'unknown',
          title: cleanTitle(entry.name) || null,
          releaseYear: null,
          seasonNumber: null,
          episodeNumber: null,
          episodeTitle: null,
          seriesTitle: null,
          language: null,
          subtitleLanguage: null,
          resolution: null,
          videoCodec: null,
          audioCodec: null,
          confidence: 'low',
          evidence: 'Folder name alone does not identify a media category.',
          warnings: ['Folder purpose is ambiguous.'],
        };
      }
    } else {
      result = createFileClassification(entry);
    }

    return {
      ...entry,
      ...result,
    };
  });
}

export function organizerFileTypes() {
  return {
    subtitle: SUBTITLE_TYPES,
    artwork: ARTWORK_TYPES,
    metadata: METADATA_TYPES,
    unsupportedVideo: UNSUPPORTED_VIDEO_TYPES,
  };
}
