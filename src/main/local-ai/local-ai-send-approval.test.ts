import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalAiConnectionService } from './local-ai-connection';
import {
  generateLocalAiMeetingSummary,
  LocalAiSummaryCancelledError,
} from './local-ai-meeting-summary';
import type { TranscriptRecord } from '../transcription/transcript-types';
import { TRANSCRIPT_SCHEMA_VERSION } from '../transcription/transcript-types';

/**
 * Exercises the Local AI send path over a real socket rather than a stubbed
 * fetch. Improving a summary is the only action that moves transcript content
 * off the device, so "the preview sent nothing" and "cancel stopped the
 * request" are checked against what actually reached a listening server.
 */

const SPEAKER_ID = '6d73be9d-c055-4dc2-93d6-d821fb4f95ec';

const createRecord = (): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Launch planning',
  tags: [],
  createdAt: '2026-07-29T18:00:00.000Z',
  completedAt: '2026-07-29T18:01:00.000Z',
  source: {
    type: 'imported-file',
    name: 'launch.wav',
    mediaKind: 'audio',
    sizeBytes: 1_024,
  },
  durationMs: 20_000,
  language: 'en',
  engine: { name: 'whisper.cpp', model: 'small.en', version: '1.0.0' },
  speakerAnalysis: {
    engine: {
      name: 'local-speaker-diarization',
      model: 'community-1',
      version: '1.0.0',
    },
    speakers: [{ id: SPEAKER_ID, label: 'Morgan' }],
  },
  text: 'The confidential launch date is March third.',
  segments: [{
    startMs: 1_000,
    endMs: 5_000,
    text: 'The confidential launch date is March third.',
    speakerId: SPEAKER_ID,
    words: [],
  }],
});

const SUMMARY_CONTENT = JSON.stringify({
  overview: 'A launch date was stated.',
  keyPoints: [],
  decisions: [],
  actionItems: [],
});

interface ReceivedRequest {
  method: string;
  url: string;
  body: string;
}

const startEndpoint = async (options: {
  onChatCompletion?: () => Promise<void>;
} = {}): Promise<{
  baseUrl: string;
  received: ReceivedRequest[];
  server: Server;
}> => {
  const received: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const url = request.url ?? '';
        received.push({
          method: request.method ?? '',
          url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (url.endsWith('/models')) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            object: 'list',
            data: [{ id: 'test-model', object: 'model', owned_by: 'test' }],
          }));
          return;
        }
        await options.onChatCompletion?.();
        if (response.writableEnded) return;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { content: SUMMARY_CONTENT } }],
        }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, received, server };
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  ));
});

describe('Local AI send approval over a real endpoint', () => {
  it('builds the preview without sending the transcript anywhere', async () => {
    const endpoint = await startEndpoint();
    servers.push(endpoint.server);
    const service = new LocalAiConnectionService({
      filePath: `${process.env.TMPDIR ?? '/tmp'}/sotto-preview-${process.pid}.json`,
      credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
    });
    await service.connect({
      baseUrl: endpoint.baseUrl,
      selectedModel: 'test-model',
    });
    endpoint.received.length = 0;

    const preview = await service.planMeetingSummary(createRecord());

    expect(preview.model).toBe('test-model');
    expect(preview.sendsApiKey).toBe(false);
    expect(preview.transcriptRequests[0]).toContain(
      'The confidential launch date is March third.',
    );
    expect(preview.speakerLabels).toEqual(['Morgan']);
    // The whole point: reviewing the payload must not transmit it.
    expect(endpoint.received).toEqual([]);
    await service.disconnect();
  });

  it('sends exactly the previewed content and nothing more', async () => {
    const endpoint = await startEndpoint();
    servers.push(endpoint.server);
    const service = new LocalAiConnectionService({
      filePath: `${process.env.TMPDIR ?? '/tmp'}/sotto-send-${process.pid}.json`,
      credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
    });
    await service.connect({
      baseUrl: endpoint.baseUrl,
      selectedModel: 'test-model',
    });
    const record = createRecord();
    const preview = await service.planMeetingSummary(record);
    endpoint.received.length = 0;

    await service.generateMeetingSummary(record);

    expect(endpoint.received).toHaveLength(1);
    // The destination the dialog discloses must be the one actually contacted.
    expect(new URL(preview.endpoint).pathname).toBe(endpoint.received[0].url);
    const sent = JSON.parse(endpoint.received[0].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.messages.map((message) => message.content)).toEqual([
      preview.systemPrompt,
      ...preview.transcriptRequests,
    ]);
    await service.disconnect();
  });

  it('stops an in-flight request when the user cancels', async () => {
    let requestReachedServer: () => void = () => undefined;
    const reachedServer = new Promise<void>((resolve) => {
      requestReachedServer = resolve;
    });
    const endpoint = await startEndpoint({
      onChatCompletion: async () => {
        requestReachedServer();
        // Outlive the cancellation so the abort is what ends the request.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      },
    });
    servers.push(endpoint.server);
    const controller = new AbortController();

    const generation = generateLocalAiMeetingSummary({
      connection: { baseUrl: endpoint.baseUrl, model: 'test-model' },
      record: createRecord(),
      signal: controller.signal,
    });
    await reachedServer;
    controller.abort();

    await expect(generation).rejects.toBeInstanceOf(LocalAiSummaryCancelledError);
  });
});
