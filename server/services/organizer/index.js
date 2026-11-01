import { validateMediaDirectory } from '../path-safety.js';
import { importOrganizerInventory } from './inventories.js';
import { buildOrganizationProposals, updateProposalReview } from './proposals.js';
import { ORGANIZER_LIMITS, scanOrganizerLibrary } from './scanner.js';

const CLASSIFICATIONS = new Set([
  'movie', 'tv_series', 'season', 'episode', 'subtitle', 'artwork', 'metadata', 'other', 'unknown',
]);
const REVIEW_STATUSES = new Set(['pending', 'reviewed', 'deferred']);

function organizerError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function countBy(entries, key) {
  return entries.reduce((counts, entry) => {
    counts[entry[key]] = (counts[entry[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function scanSummary(scan) {
  const entries = scan.entries.map((entry) => publicEntry(entry, scan.itemOverrides?.get(entry.id)));
  const confidence = countBy(entries, 'confidence');
  const classifications = countBy(entries, 'classification');
  return {
    scanId: scan.scanId,
    scannedAt: scan.scannedAt,
    durationMs: scan.durationMs,
    status: scan.truncated ? 'partial' : 'completed',
    truncated: scan.truncated,
    warnings: scan.warnings,
    visitedEntries: scan.visitedEntries,
    itemCount: entries.length,
    confidence,
    classifications,
    proposalCount: scan.proposals.length,
    inventory: scan.inventory ? {
      filename: scan.inventory.filename,
      importedAt: scan.inventory.importedAt,
      recordCount: scan.inventory.recordCount,
      matchedCount: scan.inventory.matchedCount,
      unmatchedCount: scan.inventory.unmatchedCount,
      conflictCount: scan.inventory.conflictCount,
      ignoredWorksheets: scan.inventory.ignoredWorksheets,
      warnings: scan.inventory.warnings,
    } : null,
  };
}

function pageOptions({ offset = 0, limit = 100 } = {}) {
  const parsedOffset = Number(offset);
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 50000
    || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 250) {
    throw organizerError('Pagination must use an offset from 0 to 50000 and a limit from 1 to 250.');
  }
  return { offset: parsedOffset, limit: parsedLimit };
}

function publicEntry(entry, override) {
  const detectedClassification = entry.detectedClassification ?? entry.classification;
  const detectedTitle = entry.detectedTitle ?? entry.title;
  if (!override) return { ...entry, detectedClassification, detectedTitle, manualOverride: null };
  return {
    ...entry,
    classification: override.classification,
    title: override.title ?? entry.title,
    confidence: 'high',
    evidence: 'Manual correction overrides the inferred classification.',
    warnings: [...entry.warnings],
    detectedClassification,
    detectedTitle,
    manualOverride: { ...override },
  };
}

async function buildProposals(scan, root) {
  const entries = scan.entries.map((entry) => publicEntry(entry, scan.itemOverrides.get(entry.id)));
  const classifiedScan = { ...scan, entries };
  return buildOrganizationProposals(classifiedScan, root, { reviewOverrides: scan.reviewOverrides });
}

export function createOrganizerService({ movieDirectory, scanOptions } = {}) {
  const mediaRoot = validateMediaDirectory(movieDirectory);
  const scans = new Map();
  let latestScanId = null;
  let scanning = false;

  function getScanRecord(scanId) {
    if (typeof scanId !== 'string' || !/^[0-9a-f-]{36}$/i.test(scanId)) {
      throw organizerError('Scan identifier is invalid.');
    }
    const scan = scans.get(scanId);
    if (!scan) throw organizerError('Scan not found.', 404);
    return scan;
  }

  async function refreshProposals(scan) {
    scan.proposals = await buildProposals(scan, mediaRoot);
  }

  return {
    getOverview() {
      const scan = latestScanId ? scans.get(latestScanId) : null;
      return {
        status: scanning ? 'scanning' : scan ? scan.truncated ? 'partial' : 'completed' : 'not_scanned',
        latestScan: scan ? scanSummary(scan) : null,
      };
    },

    async startScan({ signal } = {}) {
      if (scanning) throw organizerError('An organizer scan is already running.', 409);
      scanning = true;
      try {
        const scan = await scanOrganizerLibrary(mediaRoot, {
          ...scanOptions,
          signal,
        });
        scan.itemOverrides = new Map();
        scan.reviewOverrides = new Map();
        scan.inventory = null;
        scan.proposals = [];
        await refreshProposals(scan);
        scans.set(scan.scanId, scan);
        latestScanId = scan.scanId;
        while (scans.size > ORGANIZER_LIMITS.maxScans) {
          const oldestScanId = scans.keys().next().value;
          if (oldestScanId === latestScanId) break;
          scans.delete(oldestScanId);
        }
        return scanSummary(scan);
      } finally {
        scanning = false;
      }
    },

    getScan(scanId, pagination = {}) {
      const scan = getScanRecord(scanId);
      const { offset, limit } = pageOptions(pagination);
      const { classification, search = '' } = pagination;
      if (classification !== undefined && classification !== 'all' && !CLASSIFICATIONS.has(classification)) {
        throw organizerError('Classification filter is not supported.');
      }
      if (typeof search !== 'string' || search.length > 200) {
        throw organizerError('Search text must not exceed 200 characters.');
      }
      const query = search.trim().toLocaleLowerCase('en-US');
      const filtered = scan.entries
        .map((entry) => publicEntry(entry, scan.itemOverrides.get(entry.id)))
        .filter((entry) => (classification === undefined || classification === 'all' || entry.classification === classification)
          && (!query || `${entry.title ?? ''} ${entry.name} ${entry.relativePath}`.toLocaleLowerCase('en-US').includes(query)));
      const items = filtered.slice(offset, offset + limit);
      return {
        ...scanSummary(scan),
        total: filtered.length,
        items,
        offset,
        limit,
        nextOffset: offset + items.length < filtered.length ? offset + items.length : null,
      };
    },

    async importInventory({ scanId, filename, contentType, buffer }) {
      const scan = getScanRecord(scanId ?? latestScanId);
      const imported = await importOrganizerInventory({
        filename,
        contentType,
        buffer,
        root: mediaRoot,
        entries: scan.entries,
      });
      scan.inventory = imported;
      return { ...scanSummary(scan), inventory: imported };
    },

    getProposals({ scanId = latestScanId, offset, limit } = {}) {
      const scan = getScanRecord(scanId);
      const page = pageOptions({ offset, limit });
      const proposals = scan.proposals.slice(page.offset, page.offset + page.limit);
      return {
        scanId: scan.scanId,
        total: scan.proposals.length,
        offset: page.offset,
        limit: page.limit,
        nextOffset: page.offset + proposals.length < scan.proposals.length ? page.offset + proposals.length : null,
        proposals,
      };
    },

    async updateItem({ scanId, itemId, classification, title }) {
      const scan = getScanRecord(scanId);
      if (typeof itemId !== 'string' || !scan.entries.some((entry) => entry.id === itemId)) {
        throw organizerError('Scanned item not found.', 404);
      }
      if (!CLASSIFICATIONS.has(classification)) {
        throw organizerError('Classification is not supported.');
      }
      if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 200)) {
        throw organizerError('Title must be between 1 and 200 characters.');
      }
      const existing = scan.itemOverrides.get(itemId) ?? {};
      scan.itemOverrides.set(itemId, {
        classification,
        ...(title !== undefined ? { title: title.trim() } : existing.title ? { title: existing.title } : {}),
        updatedAt: new Date().toISOString(),
      });
      await refreshProposals(scan);
      return publicEntry(scan.entries.find((entry) => entry.id === itemId), scan.itemOverrides.get(itemId));
    },

    async updateProposal({ id, reviewStatus, note }) {
      if (reviewStatus !== undefined && !REVIEW_STATUSES.has(reviewStatus)) {
        throw organizerError('Review status must be pending, reviewed, or deferred.');
      }
      if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
        throw organizerError('Review note must not exceed 500 characters.');
      }
      if (typeof id !== 'string') throw organizerError('Proposal not found.', 404);
      const scan = [...scans.values()].find((candidate) => candidate.proposals.some((proposal) => proposal.id === id));
      if (!scan) throw organizerError('Proposal not found.', 404);
      const proposal = updateProposalReview(scan.proposals, id, { reviewStatus, note });
      if (!proposal) throw organizerError('Proposal not found.', 404);
      scan.reviewOverrides.set(id, {
        reviewStatus: proposal.reviewStatus,
        ...(proposal.reviewNote ? { note: proposal.reviewNote } : {}),
      });
      return proposal;
    },

    getLimits() {
      return { ...ORGANIZER_LIMITS };
    },
  };
}
