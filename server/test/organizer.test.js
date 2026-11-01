import assert from 'node:assert/strict';
import { mkdtemp, mkdir, opendir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import test from 'node:test';
import { isWithinDirectory, resolvePathWithinRoot } from '../services/path-safety.js';
import { createOrganizerService } from '../services/organizer/index.js';
import { importOrganizerInventory } from '../services/organizer/inventories.js';
import { buildOrganizationProposals } from '../services/organizer/proposals.js';
import { scanOrganizerLibrary } from '../services/organizer/scanner.js';

let fixtureRoot;
let mediaRoot;

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&apos;',
  })[character]);
}

function worksheetXml(rows) {
  const columnName = (column) => {
    let value = column + 1;
    let result = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  };
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) =>
    `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function xlsxFixture() {
  const workbook = '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Read Me" sheetId="1" r:id="rId1"/><sheet name="341 File Plan" sheetId="2" r:id="rId2"/><sheet name="Virtual Collections" sheetId="3" r:id="rId3"/></sheets></workbook>';
  const relationships = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/><Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="worksheet"/><Relationship Id="rId3" Target="worksheets/sheet3.xml" Type="worksheet"/></Relationships>';
  const files = {
    'xl/workbook.xml': new TextEncoder().encode(workbook),
    'xl/_rels/workbook.xml.rels': new TextEncoder().encode(relationships),
    'xl/worksheets/sheet1.xml': new TextEncoder().encode(worksheetXml([['Instructions']])),
    'xl/worksheets/sheet2.xml': new TextEncoder().encode(worksheetXml([
      ['Name', 'RelativePath', 'Folder', 'Extension', 'SizeGB', 'SizeMB', 'Modified'],
      ['Film.mp4', 'Film.mp4', '', '.mp4', '', '', 'today'],
    ])),
    'xl/worksheets/sheet3.xml': new TextEncoder().encode(worksheetXml([
      ['Collection Name', 'Titles'],
      ['Favorites', 'Film.mp4'],
    ])),
  };
  return Buffer.from(zipSync(files));
}

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-organizer-'));
  mediaRoot = path.join(fixtureRoot, 'media');
  await mkdir(mediaRoot);
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('recursively scans video and companion files, classifies media and returns relative paths only', async () => {
  const season = path.join(mediaRoot, 'Series', 'The Sample Show', 'Season 01');
  await mkdir(season, { recursive: true });
  await writeFile(path.join(mediaRoot, 'Arrival (2016).mkv'), Buffer.alloc(1024));
  await writeFile(path.join(mediaRoot, 'Arrival (2016).en.srt'), 'subtitle');
  await writeFile(path.join(mediaRoot, 'folder.jpg'), 'artwork');
  await writeFile(path.join(mediaRoot, 'Arrival.nfo'), 'metadata');
  await writeFile(path.join(mediaRoot, 'unsupported.ts'), 'video');
  await writeFile(path.join(season, 'The.Sample.Show.S01E02.Pilot.1080p.x265.mkv'), 'episode');
  await writeFile(path.join(season, 'The.Sample.Show.S01E02.Pilot.en.srt'), 'episode subtitle');
  await writeFile(path.join(mediaRoot, 'notes.txt'), 'not a media companion');

  const scan = await scanOrganizerLibrary(mediaRoot);
  const arrival = scan.entries.find((item) => item.name === 'Arrival (2016).mkv');
  const episode = scan.entries.find((item) => item.name.includes('S01E02'));
  const subtitle = scan.entries.find((item) => item.name === 'Arrival (2016).en.srt');
  const episodeSubtitle = scan.entries.find((item) => item.name === 'The.Sample.Show.S01E02.Pilot.en.srt');
  const artwork = scan.entries.find((item) => item.name === 'folder.jpg');

  assert.equal(arrival.classification, 'movie');
  assert.equal(arrival.title, 'Arrival');
  assert.equal(arrival.releaseYear, 2016);
  assert.equal(arrival.confidence, 'high');
  assert.equal(episode.classification, 'episode');
  assert.equal(episode.seasonNumber, 1);
  assert.equal(episode.episodeNumber, 2);
  assert.equal(episode.episodeTitle, 'Pilot');
  assert.equal(episode.seriesTitle, 'The Sample Show');
  assert.equal(episode.resolution, '1080p');
  assert.equal(episode.videoCodec, 'hevc');
  assert.equal(episode.groupId, episodeSubtitle.groupId);
  assert.equal(subtitle.classification, 'subtitle');
  assert.equal(subtitle.subtitleLanguage, 'en');
  assert.equal(artwork.classification, 'artwork');
  assert.equal(artwork.groupId, arrival.groupId);
  assert.equal(scan.entries.find((item) => item.name === 'Arrival.nfo').classification, 'metadata');
  assert.equal(scan.entries.find((item) => item.name === 'unsupported.ts').classification, 'other');
  assert.equal(scan.entries.some((item) => item.name === 'notes.txt'), false);
  assert.equal(scan.entries.some((item) => item.classification === 'season' && item.name === 'Season 01'), true);
  assert.equal(scan.entries.some((item) => item.classification === 'tv_series' && item.name === 'The Sample Show'), true);
  assert.equal(JSON.stringify(scan).includes(fixtureRoot), false);
});

test('classifies alternate episode numbering and marks ambiguous filenames low confidence', async () => {
  await mkdir(path.join(mediaRoot, 'Example Show'));
  await writeFile(path.join(mediaRoot, 'Example Show', 'Example.Show.1x03.The.Third.Episode.mkv'), 'episode');
  await writeFile(path.join(mediaRoot, 'video.mkv'), 'ambiguous');

  const scan = await scanOrganizerLibrary(mediaRoot);
  const episode = scan.entries.find((item) => item.name.includes('1x03'));
  const ambiguous = scan.entries.find((item) => item.name === 'video.mkv');

  assert.equal(episode.classification, 'episode');
  assert.equal(episode.seasonNumber, 1);
  assert.equal(episode.episodeNumber, 3);
  assert.equal(episode.seriesTitle, 'Example Show');
  assert.equal(ambiguous.classification, 'unknown');
  assert.equal(ambiguous.confidence, 'low');
  assert.ok(ambiguous.warnings.length > 0);
});

test('marks scans partial when a nested folder cannot be inspected', async () => {
  const inaccessible = path.join(mediaRoot, 'inaccessible');
  await mkdir(inaccessible);
  await writeFile(path.join(inaccessible, 'Skipped.mkv'), 'fixture');
  const service = createOrganizerService({
    movieDirectory: mediaRoot,
    scanOptions: {
      openDirectory: async (directory) => {
        if (directory === inaccessible) {
          throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        }
        return opendir(directory);
      },
    },
  });

  const summary = await service.startScan();
  const details = service.getScan(summary.scanId);
  assert.equal(summary.status, 'partial');
  assert.equal(details.truncated, true);
  assert.ok(details.warnings.some((warning) => warning.includes('inaccessible') && warning.includes('EACCES')));
  assert.equal(details.items.some((item) => item.name === 'Skipped.mkv'), false);
});

test('does not follow symbolic links or junctions', async (context) => {
  const outside = path.join(fixtureRoot, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.mkv'), 'fixture');
  try {
    await symlink(outside, path.join(mediaRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
      context.skip(`The environment does not permit creating a test link (${error.code}).`);
      return;
    }
    throw error;
  }
  const scan = await scanOrganizerLibrary(mediaRoot);
  assert.equal(scan.entries.some((item) => item.relativePath.includes('linked')), false);

  const linkedRoot = path.join(fixtureRoot, 'linked-root');
  await symlink(mediaRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(scanOrganizerLibrary(linkedRoot), /configured movie path is not a directory/);
});

test('manual classification and title corrections take precedence over inferred values', async () => {
  await writeFile(path.join(mediaRoot, 'video.mkv'), 'fixture');
  const service = createOrganizerService({ movieDirectory: mediaRoot });
  const summary = await service.startScan();
  const scanned = service.getScan(summary.scanId).items.find((item) => item.name === 'video.mkv');
  const corrected = await service.updateItem({
    scanId: summary.scanId,
    itemId: scanned.id,
    classification: 'movie',
    title: 'Reviewed Title',
  });

  assert.equal(corrected.classification, 'movie');
  assert.equal(corrected.title, 'Reviewed Title');
  assert.equal(corrected.detectedClassification, 'unknown');
  assert.equal(corrected.manualOverride.classification, 'movie');
  assert.equal(service.getProposals({ scanId: summary.scanId }).proposals[0].title, 'Reviewed Title');
});

test('proposal titles cannot escape the root or collide with a sibling-prefix directory', async () => {
  await writeFile(path.join(mediaRoot, 'Unknown.mkv'), 'fixture');
  const service = createOrganizerService({ movieDirectory: mediaRoot });
  const summary = await service.startScan();
  const item = service.getScan(summary.scanId).items.find((entry) => entry.name === 'Unknown.mkv');
  await service.updateItem({
    scanId: summary.scanId,
    itemId: item.id,
    classification: 'movie',
    title: `../${path.basename(mediaRoot)}-outside`,
  });
  const proposal = service.getProposals({ scanId: summary.scanId }).proposals[0];
  assert.ok(proposal.proposedDestinationRelativePath);
  const destination = await resolvePathWithinRoot(mediaRoot, proposal.proposedDestinationRelativePath, { allowMissing: true });
  assert.equal(isWithinDirectory(mediaRoot, destination), true);
  assert.equal(destination.startsWith(`${mediaRoot}-outside`), false);
});

test('proposal generation identifies duplicate destinations, existing conflicts and stale sources', async () => {
  const destination = path.join(mediaRoot, 'Movies', 'Sample (2020)');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(mediaRoot, 'Sample (2020).mkv'), 'source one');
  await writeFile(path.join(mediaRoot, 'Sample.2020.mkv'), 'source two');
  await writeFile(path.join(destination, 'Sample (2020).mkv'), 'existing destination');
  const scan = await scanOrganizerLibrary(mediaRoot);
  const proposals = await buildOrganizationProposals(scan, mediaRoot);
  const matching = proposals.filter((proposal) => proposal.proposedDestinationRelativePath === 'Movies/Sample (2020)/Sample (2020).mkv');
  assert.ok(matching.length >= 2);
  assert.ok(matching.every((proposal) => proposal.status === 'conflict'));
  assert.ok(matching.every((proposal) => proposal.warnings.some((warning) => /destination/i.test(warning))));

  const staleSource = scan.entries.find((item) => item.name === 'Sample.2020.mkv');
  await rm(path.join(mediaRoot, 'Sample.2020.mkv'));
  const staleProposals = await buildOrganizationProposals(scan, mediaRoot);
  const stale = staleProposals.find((proposal) => proposal.sourceId === staleSource.id);
  assert.equal(stale.status, 'unsupported');
  assert.equal(stale.proposedDestinationRelativePath, null);
  assert.ok(stale.warnings.some((warning) => /source is missing/i.test(warning)));
});

test('CSV inventory matches scanned relative paths and rejects traversal', async () => {
  await writeFile(path.join(mediaRoot, 'Film.mp4'), 'fixture');
  const scan = await scanOrganizerLibrary(mediaRoot);
  const csv = Buffer.from(`Name,RelativePath,Folder,Extension,SizeGB,SizeMB,Modified\r\n${path.join(fixtureRoot, 'Film.mp4')},Film.mp4,,.mp4,,,today\r\nMissing.mkv,Missing.mkv,,.mkv,,,today\r\n`);
  const result = await importOrganizerInventory({
    filename: 'MovieInventory.csv',
    contentType: 'text/csv',
    buffer: csv,
    root: mediaRoot,
    entries: scan.entries,
  });
  assert.equal(result.recordCount, 2);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.unmatchedCount, 1);
  assert.equal(result.records[0].relativePath, 'Film.mp4');
  assert.equal(result.records[0].name, 'Film.mp4');
  assert.equal(JSON.stringify(result).includes(fixtureRoot), false);

  await assert.rejects(importOrganizerInventory({
    filename: 'unsafe.csv',
    contentType: 'text/csv',
    buffer: Buffer.from('Name,RelativePath\nsecret,../outside.mkv\n'),
    root: mediaRoot,
    entries: scan.entries,
  }), { status: 400, code: 'INVALID_LIBRARY_PATH' });
});

test('XLSX imports only known plan sheets with supported headers and rejects malformed workbooks', async () => {
  await writeFile(path.join(mediaRoot, 'Film.mp4'), 'fixture');
  const scan = await scanOrganizerLibrary(mediaRoot);
  const result = await importOrganizerInventory({
    filename: 'MovieStream_Organisation_Plan.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: xlsxFixture(),
    root: mediaRoot,
    entries: scan.entries,
  });
  assert.equal(result.recordCount, 1);
  assert.equal(result.matchedCount, 1);
  assert.deepEqual(result.ignoredWorksheets, ['Virtual Collections']);

  await assert.rejects(importOrganizerInventory({
    filename: 'broken.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('not an xlsx archive'),
    root: mediaRoot,
    entries: scan.entries,
  }), { status: 400 });
});

test('XLSX importer rejects unsafe archive paths and excessive expanded entries', async () => {
  const unsafeArchive = Buffer.from(zipSync({ '../outside.xml': new TextEncoder().encode('unsafe') }));
  await assert.rejects(importOrganizerInventory({
    filename: 'unsafe.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: unsafeArchive,
    root: mediaRoot,
    entries: [],
  }), { status: 400 });

  const oversizedArchive = Buffer.from(zipSync({
    'xl/oversized.bin': new Uint8Array(17 * 1024 * 1024),
  }));
  await assert.rejects(importOrganizerInventory({
    filename: 'oversized.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: oversizedArchive,
    root: mediaRoot,
    entries: [],
  }), { status: 400 });
});
