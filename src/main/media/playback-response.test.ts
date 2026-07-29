import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlaybackResponse } from './playback-response';

const ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';
const roots: string[] = [];

const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-media-response-'));
  roots.push(root);
  const filePath = path.join(root, 'playback.wav');
  await writeFile(filePath, Buffer.from('0123456789'));
  const resolve = vi.fn(async () => ({
    path: filePath,
    mimeType: 'audio/wav',
    sizeBytes: 10,
  }));
  return { resolve };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('createPlaybackResponse', () => {
  it('streams only a requested byte range for seekable playback', async () => {
    const { resolve } = await setup();
    const response = await createPlaybackResponse(
      new Request(`sotto-media://playback/${ID}`, {
        headers: { range: 'bytes=2-5' },
      }),
      resolve,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    await expect(response.text()).resolves.toBe('2345');
    expect(resolve).toHaveBeenCalledWith(ID);
  });

  it('rejects malformed ids and unsatisfiable ranges before opening a path', async () => {
    const { resolve } = await setup();
    await expect(
      createPlaybackResponse(
        new Request('sotto-media://playback/not-a-uuid'),
        resolve,
      ).then((response) => response.status),
    ).resolves.toBe(404);
    expect(resolve).not.toHaveBeenCalled();

    await expect(
      createPlaybackResponse(
        new Request(`sotto-media://playback/${ID}`, {
          headers: { range: 'bytes=20-30' },
        }),
        resolve,
      ).then((response) => response.status),
    ).resolves.toBe(416);
  });

  it('supports metadata HEAD requests without returning audio bytes', async () => {
    const { resolve } = await setup();
    const response = await createPlaybackResponse(
      new Request(`sotto-media://playback/${ID}`, { method: 'HEAD' }),
      resolve,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.body).toBeNull();
  });
});
