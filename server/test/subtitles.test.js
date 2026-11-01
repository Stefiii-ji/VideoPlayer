import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  convertSubtitleToWebVtt,
  createSubtitleService,
  findExternalSubtitles,
} from '../services/playback/subtitles.js';

let fixtureRoot;
let movieDirectory;
let moviePath;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'moviestream-subtitles-'));
  movieDirectory = path.join(fixtureRoot, 'library');
  await mkdir(movieDirectory);
  moviePath = path.join(movieDirectory, 'Example Movie.mkv');
  await writeFile(moviePath, 'synthetic video fixture');
});

test.afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('converts SRT timestamps and preserves UTF-8 cue text', () => {
  const source = Buffer.from('1\r\n00:00:01,25 --> 00:00:03,500\r\nCaf\u00e9 \u2014 \u3053\u3093\u306b\u3061\u306f\r\n');
  assert.equal(
    convertSubtitleToWebVtt(source, '.srt'),
    'WEBVTT\n\n1\n00:00:01.250 --> 00:00:03.500\nCaf\u00e9 \u2014 \u3053\u3093\u306b\u3061\u306f\n',
  );
});

test('decodes UTF-16LE subtitles and leaves WebVTT cue timestamps intact', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello', 'utf16le')]);
  assert.match(convertSubtitleToWebVtt(utf16, '.srt'), /00:00:01\.000 --> 00:00:02\.000\nHello/);
  assert.equal(
    convertSubtitleToWebVtt(Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'), '.vtt'),
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n',
  );
});

test('finds only associated external SRT and WebVTT files inside the media directory', async () => {
  await writeFile(path.join(movieDirectory, 'Example Movie.en.srt'), 'subtitle');
  await writeFile(path.join(movieDirectory, 'Example Movie.fr.vtt'), 'WEBVTT');
  await writeFile(path.join(movieDirectory, 'Example Movie extra.srt'), 'unrelated');
  await writeFile(path.join(movieDirectory, 'Other.srt'), 'unrelated');
  const tracks = await findExternalSubtitles(moviePath, movieDirectory);
  assert.deepEqual(tracks.map(({ id, format }) => ({ id, format })), [
    { id: 'external-0', format: 'SRT' },
    { id: 'external-1', format: 'VTT' },
  ]);
  assert.equal(tracks[0].label, 'en');
  assert.equal(tracks[1].label, 'fr');
});

test('extracts an embedded subtitle by FFprobe stream index as WebVTT', async () => {
  let command;
  const service = createSubtitleService({
    executablePath: 'mock-ffmpeg',
    spawnProcess: (_executable, args) => {
      command = args;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.end('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEmbedded\n');
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  const output = await service.extractEmbedded(moviePath, 4);
  assert.equal(command[command.indexOf('-map') + 1], '0:4');
  assert.match(output, /^WEBVTT/);
  assert.match(output, /Embedded/);
  assert.equal(service.supportsEmbeddedCodec('ass'), true);
  assert.equal(service.supportsEmbeddedCodec('hdmv_pgs_subtitle'), false);
});
