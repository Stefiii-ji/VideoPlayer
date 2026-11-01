import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolvePathWithinRoot } from '../path-safety.js';

function keyFor(relativePath) {
  return relativePath.replace(/[\\/]+/g, '/').toLocaleLowerCase('en-US');
}

function safeTitle(value) {
  return typeof value === 'string'
    ? value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '')
    : '';
}

function proposalId(scanId, sourceId) {
  return createHash('sha256').update(`${scanId}:${sourceId}`).digest('hex').slice(0, 24);
}

function makeBase(scanId, entry, destination, status = 'ready') {
  return {
    id: proposalId(scanId, entry.id),
    sourceId: entry.id,
    sourceRelativePath: entry.relativePath,
    proposedDestinationRelativePath: destination,
    classification: entry.classification,
    title: entry.title ?? null,
    confidence: entry.confidence,
    evidence: entry.evidence,
    warnings: [...entry.warnings],
    status,
    reviewStatus: 'pending',
  };
}

function filenameWithExtension(value, extension) {
  return `${value}${extension.toLowerCase()}`;
}

export async function buildOrganizationProposals(scan, root, {
  reviewOverrides = new Map(),
} = {}) {
  const entries = scan.entries;
  const files = entries.filter((entry) => entry.kind === 'file');
  const entriesByPath = new Map(entries.map((entry) => [keyFor(entry.relativePath), entry]));
  const movieTitleCounts = new Map();
  for (const entry of files) {
    if (entry.classification !== 'movie' || !entry.title) continue;
    const key = `${entry.title} (${entry.releaseYear ?? ''})`.toLocaleLowerCase('en-US');
    movieTitleCounts.set(key, (movieTitleCounts.get(key) ?? 0) + 1);
  }

  const proposalsBySource = new Map();
  const videosByGroup = new Map();
  for (const entry of files.filter((candidate) => candidate.isVideo && candidate.groupId)) {
    const related = videosByGroup.get(entry.groupId) ?? [];
    related.push(entry);
    videosByGroup.set(entry.groupId, related);
  }
  const orderedFiles = [...files].sort((left, right) => Number(right.isVideo) - Number(left.isVideo));
  for (const entry of orderedFiles) {
    const warnings = [...entry.warnings];
    try {
      await resolvePathWithinRoot(root, entry.relativePath);
    } catch {
      warnings.push('Source is missing or no longer safe; rescan before reviewing this proposal.');
      proposalsBySource.set(entry.id, makeBase(scan.scanId, { ...entry, warnings }, null, 'unsupported'));
      continue;
    }
    let destination = null;
    let status = 'ready';
    if (entry.isVideo && entry.classification === 'movie' && entry.title) {
      const title = safeTitle(entry.title);
      if (!title) {
        warnings.push('A safe destination title could not be generated.');
      } else {
        const label = `${title}${entry.releaseYear ? ` (${entry.releaseYear})` : ''}`;
        destination = path.posix.join(
          'Movies',
          label,
          filenameWithExtension(label, entry.extension),
        );
        if (movieTitleCounts.get(`${entry.title} (${entry.releaseYear ?? ''})`.toLocaleLowerCase('en-US')) > 1) {
          warnings.push('Another movie has the same inferred title and year.');
        }
      }
    } else if (entry.isVideo && entry.classification === 'episode'
      && entry.seriesTitle && Number.isInteger(entry.seasonNumber) && Number.isInteger(entry.episodeNumber)) {
      const seriesTitle = safeTitle(entry.seriesTitle);
      if (!seriesTitle) {
        warnings.push('A safe series destination title could not be generated.');
      } else {
        const seasonLabel = `Season ${String(entry.seasonNumber).padStart(2, '0')}`;
        const episodeLabel = `S${String(entry.seasonNumber).padStart(2, '0')}E${String(entry.episodeNumber).padStart(2, '0')}`;
        const name = `${seriesTitle} - ${episodeLabel}${entry.episodeTitle ? ` - ${safeTitle(entry.episodeTitle)}` : ''}`;
        destination = path.posix.join(
          'TV Shows',
          seriesTitle,
          seasonLabel,
          filenameWithExtension(name, entry.extension),
        );
      }
    } else if (entry.classification === 'subtitle') {
      const relatedVideos = videosByGroup.get(entry.groupId) ?? [];
      const relatedVideo = relatedVideos.length === 1 ? relatedVideos[0] : null;
      const videoProposal = relatedVideo && proposalsBySource.get(relatedVideo.id);
      if (videoProposal?.proposedDestinationRelativePath) {
        const videoDestination = videoProposal.proposedDestinationRelativePath;
        const basename = path.posix.basename(videoDestination, path.posix.extname(videoDestination));
        const language = entry.subtitleLanguage ? `.${entry.subtitleLanguage}` : '';
        destination = path.posix.join(
          path.posix.dirname(videoDestination),
          `${basename}${language}${entry.extension}`,
        );
      } else {
        warnings.push(relatedVideos.length > 1
          ? 'Multiple videos match this subtitle; automatic pairing is ambiguous.'
          : 'No confidently matched video is available for this subtitle.');
        status = 'unsupported';
      }
    } else {
      warnings.push(entry.classification === 'unknown'
        ? 'Classification is unknown; review is required before proposing a destination.'
        : 'No automatic destination rule is defined for this file type or classification.');
      status = 'unsupported';
    }

    if (!destination) {
      proposalsBySource.set(entry.id, {
        ...makeBase(scan.scanId, { ...entry, warnings }, null, status),
      });
      continue;
    }

    try {
      await resolvePathWithinRoot(root, destination, { allowMissing: true });
    } catch {
      warnings.push('The proposed destination failed media-root path validation.');
      destination = null;
      status = 'unsupported';
    }
    const existing = destination ? entriesByPath.get(keyFor(destination)) : null;
    if (existing && (existing.kind !== 'file' || keyFor(existing.relativePath) !== keyFor(entry.relativePath))) {
      warnings.push('A different scanned file already exists at the proposed destination.');
      status = 'conflict';
    } else if (destination && keyFor(destination) === keyFor(entry.relativePath)) {
      status = 'already-organized';
    }
    proposalsBySource.set(entry.id, makeBase(scan.scanId, { ...entry, warnings }, destination, status));
  }

  const destinationCounts = new Map();
  for (const proposal of proposalsBySource.values()) {
    if (proposal.proposedDestinationRelativePath) {
      const key = keyFor(proposal.proposedDestinationRelativePath);
      destinationCounts.set(key, (destinationCounts.get(key) ?? 0) + 1);
    }
  }
  for (const proposal of proposalsBySource.values()) {
    if (proposal.proposedDestinationRelativePath
      && destinationCounts.get(keyFor(proposal.proposedDestinationRelativePath)) > 1) {
      proposal.status = 'conflict';
      proposal.warnings.push('Multiple source files share this proposed destination.');
    }
    const review = reviewOverrides.get(proposal.id);
    if (review) {
      proposal.reviewStatus = review.reviewStatus ?? proposal.reviewStatus;
      if (review.note !== undefined) proposal.reviewNote = review.note;
      proposal.warnings = [...new Set([...proposal.warnings, ...(review.warnings ?? [])])];
    }
  }
  return [...proposalsBySource.values()];
}

export function updateProposalReview(proposals, id, update) {
  const proposal = proposals.find((item) => item.id === id);
  if (!proposal) return null;
  if (update.reviewStatus !== undefined) proposal.reviewStatus = update.reviewStatus;
  if (update.note !== undefined) proposal.reviewNote = update.note;
  return proposal;
}
