import {
  Document,
  Footer,
  HeadingLevel,
  LineRuleType,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
} from 'docx';
import type { MeetingSummary } from '../../shared/contracts';

import type {
  TranscriptRecord,
  TranscriptSegment,
} from '../transcription/transcript-types';

export const TRANSCRIPT_DOCX_EXTENSION = '.docx' as const;
export const TRANSCRIPT_DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

export interface TranscriptDocxSpeaker {
  id: string;
  label: string;
}

export type TranscriptDocxSegment = Omit<TranscriptSegment, 'speakerId' | 'words'> & {
  /** Canonical speaker reference used by transcript schema v2. */
  speakerId?: string | null;
  /** Compatibility for callers that only have a presentation label. */
  speakerLabel?: string | null;
};

/**
 * The optional fields keep this generator source-compatible with schema-v1
 * records while preferring schema-v2's canonical speaker analysis.
 */
export type TranscriptDocxRecord = Omit<
  TranscriptRecord,
  'segments' | 'speakerAnalysis'
> & {
  segments: readonly TranscriptDocxSegment[];
  speakerAnalysis?: {
    speakers: readonly TranscriptDocxSpeaker[];
  } | null;
};

const DEFAULT_SPEAKER_LABEL = 'Unclear';
const MAX_SPEAKER_LABEL_CHARACTERS = 200;

// compact_reference_guide preset tokens, in half-points and DXA/twips.
const STYLE = {
  body: {
    after: 120,
    color: '1F2937',
    font: 'Calibri',
    line: 300,
    size: 22,
  },
  footer: {
    color: '7A8491',
    line: 240,
    size: 18,
  },
  heading1: {
    after: 200,
    before: 360,
    color: '2E74B5',
    size: 32,
  },
  heading2: {
    after: 140,
    before: 280,
    color: '2E74B5',
    size: 26,
  },
  heading3: {
    after: 100,
    before: 200,
    color: '1F4D78',
    size: 24,
  },
  line: {
    after: 80,
    timestampColumn: 1_512,
  },
  metadata: {
    after: 40,
    color: '5F6B7A',
    line: 240,
    size: 19,
  },
  page: {
    footer: 708,
    header: 708,
    height: 15_840,
    margin: 1_440,
    usableWidth: 9_360,
    width: 12_240,
  },
  subtitle: {
    after: 160,
    color: '2E74B5',
    line: 240,
    size: 20,
  },
  title: {
    after: 100,
    color: '0B2545',
    line: 320,
    size: 56,
  },
} as const;

const isValidXmlCharacter = (codePoint: number): boolean =>
  codePoint === 0x09 ||
  codePoint === 0x0a ||
  codePoint === 0x0d ||
  (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
  (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
  (codePoint >= 0x10000 && codePoint <= 0x10ffff);

const sanitizeXmlCharacters = (value: string): string =>
  Array.from(value, (character) =>
    isValidXmlCharacter(character.codePointAt(0) ?? 0) ? character : '\ufffd',
  ).join('');

const normalizeInlineText = (value: string): string =>
  sanitizeXmlCharacters(value).replace(/\s+/g, ' ').trim();

const normalizeSpeakerLabel = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';

  return Array.from(normalizeInlineText(value))
    .slice(0, MAX_SPEAKER_LABEL_CHARACTERS)
    .join('');
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatTimestamp = (milliseconds: number): string => {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, '0')}:${pad2(minutes)}:${pad2(seconds)}`;
};

const formatUtcDateTime = (value: string): string => {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) return normalizeInlineText(value);

  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
};

const segmentTextRuns = (text: string): TextRun[] =>
  sanitizeXmlCharacters(text)
    .replaceAll('\t', '    ')
    .split(/\r\n|\r|\n/)
    .map(
      (line, index) =>
        new TextRun({
          ...(index === 0 ? {} : { break: 1 }),
          text: line,
        }),
    );

const metadataParagraph = (
  entries: readonly [label: string, value: string][],
): Paragraph =>
  new Paragraph({
    children: entries.flatMap(([label, value], index) => [
      ...(index === 0
        ? []
        : [
            new TextRun({
              color: 'A0A7B0',
              text: '  |  ',
            }),
          ]),
      new TextRun({
        bold: true,
        color: '4B5563',
        text: `${normalizeInlineText(label)}: `,
      }),
      new TextRun(normalizeInlineText(value)),
    ]),
    style: 'SottoTranscriptMetadata',
  });

const buildSpeakerLabelsById = (
  record: TranscriptDocxRecord,
): ReadonlyMap<string, string> => {
  const labels = new Map<string, string>();

  for (const speaker of record.speakerAnalysis?.speakers ?? []) {
    const id = normalizeInlineText(speaker.id);
    const label = normalizeSpeakerLabel(speaker.label);
    if (id && label) labels.set(id, label);
  }

  return labels;
};

const resolveSpeakerLabel = (
  segment: TranscriptDocxSegment,
  speakerLabelsById: ReadonlyMap<string, string>,
  hasSpeakerAnalysis: boolean,
): string | null => {
  const speakerId = segment.speakerId
    ? normalizeInlineText(segment.speakerId)
    : '';
  const canonicalLabel = speakerId ? speakerLabelsById.get(speakerId) : '';
  if (canonicalLabel) return canonicalLabel;

  const compatibilityLabel = normalizeSpeakerLabel(segment.speakerLabel);
  if (compatibilityLabel) return compatibilityLabel;

  return hasSpeakerAnalysis ? DEFAULT_SPEAKER_LABEL : null;
};

const transcriptParagraph = (
  segment: TranscriptDocxSegment,
  speakerLabelsById: ReadonlyMap<string, string>,
  hasSpeakerAnalysis: boolean,
): Paragraph => {
  const speakerLabel = resolveSpeakerLabel(
    segment,
    speakerLabelsById,
    hasSpeakerAnalysis,
  );

  return new Paragraph({
    children: [
      new TextRun({
        color: '6B7280',
        size: STYLE.metadata.size,
        text: formatTimestamp(segment.startMs),
      }),
      new TextRun({ children: [new Tab()] }),
      ...(speakerLabel
        ? [
            new TextRun({
              bold: true,
              color: STYLE.heading3.color,
              text: `${speakerLabel}: `,
            }),
          ]
        : []),
      ...segmentTextRuns(segment.text),
    ],
    style: 'SottoTranscriptLine',
  });
};

const createStyles = () => ({
  default: {
    document: {
      paragraph: {
        spacing: {
          after: STYLE.body.after,
          before: 0,
          line: STYLE.body.line,
          lineRule: LineRuleType.AUTO,
        },
        widowControl: true,
      },
      run: {
        color: STYLE.body.color,
        font: STYLE.body.font,
        size: STYLE.body.size,
      },
    },
    heading1: {
      paragraph: {
        keepLines: true,
        keepNext: true,
        outlineLevel: 0,
        spacing: {
          after: STYLE.heading1.after,
          before: STYLE.heading1.before,
        },
      },
      run: {
        bold: true,
        color: STYLE.heading1.color,
        font: STYLE.body.font,
        size: STYLE.heading1.size,
      },
    },
    heading2: {
      paragraph: {
        keepLines: true,
        keepNext: true,
        outlineLevel: 1,
        spacing: {
          after: STYLE.heading2.after,
          before: STYLE.heading2.before,
        },
      },
      run: {
        bold: true,
        color: STYLE.heading2.color,
        font: STYLE.body.font,
        size: STYLE.heading2.size,
      },
    },
    heading3: {
      paragraph: {
        keepLines: true,
        keepNext: true,
        outlineLevel: 2,
        spacing: {
          after: STYLE.heading3.after,
          before: STYLE.heading3.before,
        },
      },
      run: {
        bold: true,
        color: STYLE.heading3.color,
        font: STYLE.body.font,
        size: STYLE.heading3.size,
      },
    },
    title: {
      paragraph: {
        keepNext: true,
        outlineLevel: 0,
        spacing: {
          after: STYLE.title.after,
          before: 0,
          line: STYLE.title.line,
          lineRule: LineRuleType.AUTO,
        },
      },
      run: {
        bold: true,
        color: STYLE.title.color,
        font: 'Calibri Light',
        size: STYLE.title.size,
      },
    },
  },
  paragraphStyles: [
    {
      basedOn: 'Normal',
      id: 'SottoKicker',
      name: 'Sotto Kicker',
      next: 'Title',
      paragraph: {
        keepNext: true,
        spacing: { after: 40, before: 0 },
      },
      quickFormat: true,
      run: {
        bold: true,
        characterSpacing: 16,
        color: STYLE.heading1.color,
        font: STYLE.body.font,
        size: 18,
        smallCaps: true,
      },
    },
    {
      basedOn: 'Normal',
      id: 'SottoTranscriptSubtitle',
      name: 'Sotto Transcript Subtitle',
      next: 'SottoTranscriptMetadata',
      paragraph: {
        keepNext: true,
        spacing: {
          after: STYLE.subtitle.after,
          before: 0,
          line: STYLE.subtitle.line,
          lineRule: LineRuleType.AUTO,
        },
      },
      quickFormat: true,
      run: {
        bold: true,
        color: STYLE.subtitle.color,
        font: STYLE.body.font,
        size: STYLE.subtitle.size,
        smallCaps: true,
      },
    },
    {
      basedOn: 'Normal',
      id: 'SottoTranscriptMetadata',
      name: 'Sotto Transcript Metadata',
      next: 'SottoTranscriptMetadata',
      paragraph: {
        keepNext: true,
        spacing: {
          after: STYLE.metadata.after,
          before: 0,
          line: STYLE.metadata.line,
          lineRule: LineRuleType.AUTO,
        },
      },
      run: {
        color: STYLE.metadata.color,
        font: STYLE.body.font,
        size: STYLE.metadata.size,
      },
    },
    {
      basedOn: 'Normal',
      id: 'SottoTranscriptLine',
      name: 'Sotto Transcript Line',
      next: 'SottoTranscriptLine',
      paragraph: {
        indent: {
          hanging: STYLE.line.timestampColumn,
          left: STYLE.line.timestampColumn,
        },
        spacing: {
          after: STYLE.line.after,
          before: 0,
          line: STYLE.body.line,
          lineRule: LineRuleType.AUTO,
        },
        tabStops: [
          {
            position: STYLE.line.timestampColumn,
            type: TabStopType.LEFT,
          },
        ],
        widowControl: true,
      },
      run: {
        color: STYLE.body.color,
        font: STYLE.body.font,
        size: STYLE.body.size,
      },
    },
    {
      basedOn: 'Normal',
      id: 'SottoTranscriptEmpty',
      name: 'Sotto Transcript Empty State',
      paragraph: {
        spacing: {
          after: STYLE.body.after,
          before: 0,
          line: STYLE.body.line,
          lineRule: LineRuleType.AUTO,
        },
      },
      run: {
        color: STYLE.metadata.color,
        font: STYLE.body.font,
        italics: true,
        size: STYLE.body.size,
      },
    },
    {
      basedOn: 'Normal',
      id: 'SottoFooter',
      name: 'Sotto Footer',
      paragraph: {
        spacing: {
          after: 0,
          before: 0,
          line: STYLE.footer.line,
          lineRule: LineRuleType.AUTO,
        },
        tabStops: [
          {
            position: STYLE.page.usableWidth,
            type: TabStopType.RIGHT,
          },
        ],
      },
      run: {
        color: STYLE.footer.color,
        font: STYLE.body.font,
        size: STYLE.footer.size,
      },
    },
  ],
});

const summaryParagraphs = (
  summary: MeetingSummary | null,
  speakerLabelsById: ReadonlyMap<string, string>,
): Paragraph[] => {
  if (!summary) return [];
  const itemGroup = (
    title: string,
    items: MeetingSummary['keyPoints'],
  ): Paragraph[] => items.length === 0
    ? []
    : [
        new Paragraph({
          children: [new TextRun(title)],
          heading: HeadingLevel.HEADING_2,
        }),
        ...items.map((item) => {
          const speaker = item.speakerId
            ? speakerLabelsById.get(item.speakerId)
            : null;
          return new Paragraph({
            bullet: { level: 0 },
            children: [
              new TextRun({
                color: STYLE.metadata.color,
                text: `${formatTimestamp(item.startMs)}  `,
              }),
              ...(speaker
                ? [new TextRun({ bold: true, text: `${speaker}: ` })]
                : []),
              ...segmentTextRuns(item.text),
              ...(item.owner || item.dueDate
                ? [
                    new TextRun({
                      color: STYLE.metadata.color,
                      italics: true,
                      text: `  [${[
                        item.owner ? `Owner: ${item.owner}` : null,
                        item.dueDate ? `Due: ${item.dueDate}` : null,
                      ].filter((value): value is string => value !== null).join('; ')}]`,
                    }),
                  ]
                : []),
            ],
          });
        }),
      ];

  return [
    new Paragraph({
      children: [new TextRun('Meeting summary')],
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({ children: segmentTextRuns(summary.overview) }),
    ...itemGroup('Key points', summary.keyPoints),
    ...itemGroup('Decisions', summary.decisions),
    ...itemGroup('Action items', summary.actionItems),
  ];
};

const transcriptBody = (
  record: TranscriptDocxRecord,
  summary: MeetingSummary | null,
): Paragraph[] => {
  const speakerLabelsById = buildSpeakerLabelsById(record);
  const hasSpeakerAnalysis = record.speakerAnalysis != null;
  const speakerCount = record.speakerAnalysis?.speakers.length;
  const lines =
    record.segments.length === 0
      ? [
          new Paragraph({
            children: [new TextRun('No spoken content was detected.')],
            style: 'SottoTranscriptEmpty',
          }),
        ]
      : record.segments.map((segment) =>
          transcriptParagraph(segment, speakerLabelsById, hasSpeakerAnalysis),
        );

  return [
    new Paragraph({
      children: [new TextRun('Sotto')],
      style: 'SottoKicker',
    }),
    new Paragraph({
      children: [new TextRun(normalizeInlineText(record.title))],
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      children: [new TextRun('Meeting transcript')],
      style: 'SottoTranscriptSubtitle',
    }),
    metadataParagraph([
      ['Created', formatUtcDateTime(record.createdAt)],
      ['Duration', formatTimestamp(record.durationMs)],
    ]),
    metadataParagraph([
      ['Source', record.source.name],
      ['Language', record.language ?? 'Not detected'],
    ]),
    metadataParagraph([
      ['Transcription', `${record.engine.name} / ${record.engine.model}`],
      [
        'Speakers',
        speakerCount === undefined ? 'Not analyzed' : String(speakerCount),
      ],
    ]),
    ...summaryParagraphs(summary, speakerLabelsById),
    new Paragraph({
      children: [new TextRun('Transcript')],
      heading: HeadingLevel.HEADING_1,
    }),
    ...lines,
  ];
};

const minutesItemParagraphs = (
  title: string,
  items: MeetingSummary['keyPoints'],
  emptyText: string,
  speakerLabelsById: ReadonlyMap<string, string>,
): Paragraph[] => [
  new Paragraph({
    children: [new TextRun(title)],
    heading: HeadingLevel.HEADING_1,
  }),
  ...(items.length > 0
    ? items.map((item) => {
        const speaker = item.speakerId
          ? speakerLabelsById.get(item.speakerId)
          : null;
        return new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({
              color: STYLE.metadata.color,
              text: `${formatTimestamp(item.startMs)}  `,
            }),
            ...(speaker
              ? [new TextRun({ bold: true, text: `${speaker}: ` })]
              : []),
            ...segmentTextRuns(item.text),
          ],
        });
      })
    : [
        new Paragraph({
          children: [new TextRun(emptyText)],
          style: 'SottoTranscriptEmpty',
        }),
      ]),
];

const meetingMinutesBody = (
  record: TranscriptDocxRecord,
  summary: MeetingSummary | null,
): Paragraph[] => {
  const speakerLabelsById = buildSpeakerLabelsById(record);
  const overview = normalizeInlineText(summary?.overview ?? '') ||
    'No overview was extracted from this transcript.';

  return [
    new Paragraph({
      children: [new TextRun('Sotto')],
      style: 'SottoKicker',
    }),
    new Paragraph({
      children: [new TextRun(normalizeInlineText(record.title))],
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      children: [new TextRun('Meeting minutes')],
      style: 'SottoTranscriptSubtitle',
    }),
    metadataParagraph([
      ['Date', formatUtcDateTime(record.completedAt)],
      ['Duration', formatTimestamp(record.durationMs)],
    ]),
    new Paragraph({
      children: [
        new TextRun(
          'Extracted locally from the saved transcript. Review each item against its timestamp.',
        ),
      ],
      style: 'SottoTranscriptEmpty',
    }),
    new Paragraph({
      children: [new TextRun('Overview')],
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({ children: segmentTextRuns(overview) }),
    ...minutesItemParagraphs(
      'Key points',
      summary?.keyPoints ?? [],
      'No key points were found.',
      speakerLabelsById,
    ),
    ...minutesItemParagraphs(
      'Decisions',
      summary?.decisions ?? [],
      'No decisions were found.',
      speakerLabelsById,
    ),
    ...minutesItemParagraphs(
      'Action items',
      summary?.actionItems ?? [],
      'No action items were found.',
      speakerLabelsById,
    ),
  ];
};

const createDocument = (
  record: TranscriptDocxRecord,
  children: Paragraph[],
  subject: string,
  footerLabel: string,
): Document => new Document({
  compatabilityModeVersion: 15,
  creator: 'Sotto',
  defaultTabStop: 720,
  lastModifiedBy: 'Sotto',
  revision: 1,
  sections: [
    {
      children,
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              children: [
                new TextRun(footerLabel),
                new TextRun({ children: [new Tab(), PageNumber.CURRENT] }),
              ],
              style: 'SottoFooter',
            }),
          ],
        }),
      },
      properties: {
        grid: { linePitch: 360 },
        page: {
          margin: {
            bottom: STYLE.page.margin,
            footer: STYLE.page.footer,
            gutter: 0,
            header: STYLE.page.header,
            left: STYLE.page.margin,
            right: STYLE.page.margin,
            top: STYLE.page.margin,
          },
          size: {
            height: STYLE.page.height,
            orientation: PageOrientation.PORTRAIT,
            width: STYLE.page.width,
          },
        },
      },
    },
  ],
  styles: createStyles(),
  subject,
  title: normalizeInlineText(record.title),
});

/** Generates a professional transcript as an in-memory Word document. */
export const createTranscriptDocx = async (
  record: TranscriptDocxRecord,
  summary: MeetingSummary | null = null,
): Promise<Buffer> => {
  return Packer.toBuffer(createDocument(
    record,
    transcriptBody(record, summary),
    'Meeting transcript',
    'Sotto transcript',
  ));
};

/** Generates meeting minutes without duplicating the full transcript body. */
export const createMeetingMinutesDocx = async (
  record: TranscriptDocxRecord,
  summary: MeetingSummary | null,
): Promise<Buffer> => Packer.toBuffer(createDocument(
  record,
  meetingMinutesBody(record, summary),
  'Meeting minutes',
  'Sotto meeting minutes',
));
