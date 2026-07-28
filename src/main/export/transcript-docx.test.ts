import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { TRANSCRIPT_SCHEMA_VERSION } from '../transcription/transcript-types';
import {
  createTranscriptDocx,
  TRANSCRIPT_DOCX_MIME_TYPE,
  type TranscriptDocxRecord,
} from './transcript-docx';

const TRANSCRIPT_ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';

const createRecord = (
  overrides: Partial<TranscriptDocxRecord> = {},
): TranscriptDocxRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: TRANSCRIPT_ID,
  title: 'R&D <weekly sync>',
  createdAt: '2026-07-27T12:00:00.000Z',
  completedAt: '2026-07-27T12:02:00.000Z',
  source: {
    type: 'recording',
    name: 'weekly-sync.webm',
    mediaKind: 'audio',
    sizeBytes: 12_345,
  },
  durationMs: 62_500,
  language: 'en',
  engine: {
    name: 'whisper.cpp',
    model: 'ggml-base.en.bin',
    version: 'v1.8.2',
  },
  text: 'Welcome. Here is the update. No owner yet.',
  speakerAnalysis: {
    speakers: [
      { id: 'speaker-1', label: 'Me & <Team>' },
      { id: 'speaker-2', label: 'Speaker 2' },
    ],
  },
  segments: [
    {
      startMs: 1_000,
      endMs: 2_500,
      speakerId: 'speaker-1',
      speakerLabel: 'Legacy label',
      text: 'Welcome.\nNext line & details.',
    },
    {
      startMs: 60_000,
      endMs: 61_000,
      speakerId: 'speaker-2',
      text: 'Here is the <update>.',
    },
    {
      startMs: 61_000,
      endMs: 62_500,
      speakerId: null,
      text: 'No owner yet.\u0001',
    },
  ],
  ...overrides,
});

const findEndOfCentralDirectory = (archive: Buffer): number => {
  const minimumOffset = Math.max(0, archive.length - 65_557);

  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }

  throw new Error('ZIP end-of-central-directory record was not found.');
};

const extractZipEntries = (archive: Buffer): ReadonlyMap<string, Buffer> => {
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('ZIP central-directory entry is invalid.');
    }

    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString('utf8');

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP local entry for ${name} is invalid.`);
    }

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(
      dataOffset,
      dataOffset + compressedSize,
    );
    const data =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed)
          : (() => {
              throw new Error(`ZIP entry ${name} uses unsupported method ${method}.`);
            })();

    if (data.length !== uncompressedSize) {
      throw new Error(`ZIP entry ${name} has an invalid uncompressed size.`);
    }

    entries.set(name, data);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
};

const readXml = (entries: ReadonlyMap<string, Buffer>, name: string): string => {
  const entry = entries.get(name);
  if (!entry) throw new Error(`DOCX entry ${name} is missing.`);
  return entry.toString('utf8');
};

describe('createTranscriptDocx', () => {
  it('builds a valid OOXML package with the required Word parts', async () => {
    const archive = await createTranscriptDocx(createRecord());
    const entries = extractZipEntries(archive);

    expect(archive.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(TRANSCRIPT_DOCX_MIME_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'docProps/app.xml',
        'word/document.xml',
        'word/styles.xml',
        'word/settings.xml',
        'word/footer1.xml',
        'word/_rels/document.xml.rels',
      ]),
    );

    expect(readXml(entries, '[Content_Types].xml')).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    );
  });

  it('exports canonical speaker labels, timestamps, safe text, and metadata', async () => {
    const entries = extractZipEntries(await createTranscriptDocx(createRecord()));
    const documentXml = readXml(entries, 'word/document.xml');
    const coreXml = readXml(entries, 'docProps/core.xml');

    expect(documentXml).toContain('R&amp;D &lt;weekly sync&gt;');
    expect(documentXml).toContain('2026-07-27 12:00 UTC');
    expect(documentXml).toContain('00:01:02');
    expect(documentXml).toContain('Me &amp; &lt;Team&gt;: ');
    expect(documentXml).not.toContain('Legacy label');
    expect(documentXml).toContain('Speaker 2: ');
    expect(documentXml).toContain('Unclear: ');
    expect(documentXml).toContain('00:00:01');
    expect(documentXml).toContain('00:01:00');
    expect(documentXml).toContain('Next line &amp; details.');
    expect(documentXml).toContain('<w:br');
    expect(documentXml).toContain('No owner yet.\ufffd');
    expect(documentXml).not.toContain('\u0001');
    expect(coreXml).toContain('R&amp;D &lt;weekly sync&gt;');
  });

  it('encodes the compact transcript geometry and style tokens', async () => {
    const entries = extractZipEntries(await createTranscriptDocx(createRecord()));
    const documentXml = readXml(entries, 'word/document.xml');
    const stylesXml = readXml(entries, 'word/styles.xml');

    expect(documentXml).toMatch(
      /<w:pgSz[^>]*w:w="12240"[^>]*w:h="15840"/,
    );
    expect(documentXml).toMatch(
      /<w:pgMar[^>]*w:top="1440"[^>]*w:right="1440"[^>]*w:bottom="1440"[^>]*w:left="1440"/,
    );
    expect(stylesXml).toContain('w:styleId="SottoTranscriptLine"');
    expect(stylesXml).toMatch(
      /<w:spacing[^>]*w:after="80"[^>]*w:line="300"[^>]*w:lineRule="auto"/,
    );
    expect(stylesXml).toMatch(
      /<w:ind[^>]*w:left="1512"[^>]*w:hanging="1512"/,
    );
    expect(stylesXml).toContain('w:styleId="Heading1"');
    expect(stylesXml).toContain('w:color w:val="2E74B5"');
  });

  it('produces a clear empty state for a transcript with no segments', async () => {
    const record = createRecord({
      durationMs: 0,
      segments: [],
      speakerAnalysis: null,
      text: '',
    });
    const entries = extractZipEntries(await createTranscriptDocx(record));
    const documentXml = readXml(entries, 'word/document.xml');

    expect(documentXml).toContain('No spoken content was detected.');
    expect(documentXml).toContain('Not analyzed');
  });

  it('omits a speaker prefix when speaker analysis was not run', async () => {
    const record = createRecord({
      speakerAnalysis: null,
      segments: [
        {
          startMs: 0,
          endMs: 1_000,
          speakerId: null,
          text: 'Text only transcript.',
        },
      ],
    });
    const documentXml = readXml(
      extractZipEntries(await createTranscriptDocx(record)),
      'word/document.xml',
    );

    expect(documentXml).toContain('Text only transcript.');
    expect(documentXml).not.toContain('Unclear: ');
  });
});
