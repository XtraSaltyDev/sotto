import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { isTranscriptId } from '../transcription/transcript-types';

export interface PlaybackResponseDescriptor {
  path: string;
  mimeType: string;
  sizeBytes: number;
}

export const createPlaybackResponse = async (
  request: Request,
  resolve: (transcriptId: string) => Promise<PlaybackResponseDescriptor | null>,
): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 });
  }
  let requested: URL;
  try {
    requested = new URL(request.url);
  } catch {
    return new Response(null, { status: 400 });
  }
  const transcriptId = requested.pathname.slice(1);
  if (
    requested.hostname !== 'playback' ||
    requested.search ||
    requested.hash ||
    transcriptId.includes('/') ||
    !isTranscriptId(transcriptId)
  ) {
    return new Response(null, { status: 404 });
  }
  const descriptor = await resolve(transcriptId);
  if (!descriptor || descriptor.sizeBytes <= 0) {
    return new Response(null, { status: 404 });
  }

  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': descriptor.mimeType,
  });
  const range = request.headers.get('range');
  let start = 0;
  let end = descriptor.sizeBytes - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${descriptor.sizeBytes}` },
      });
    }
    if (!match[1]) {
      const suffixLength = Number.parseInt(match[2], 10);
      start = Math.max(0, descriptor.sizeBytes - suffixLength);
    } else {
      start = Number.parseInt(match[1], 10);
      if (match[2]) end = Number.parseInt(match[2], 10);
    }
    if (start >= descriptor.sizeBytes || end < start) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${descriptor.sizeBytes}` },
      });
    }
    end = Math.min(end, descriptor.sizeBytes - 1);
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${descriptor.sizeBytes}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const body = Readable.toWeb(
    createReadStream(descriptor.path, { start, end }),
  ) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
};
