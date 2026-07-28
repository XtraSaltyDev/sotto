import { describe, expect, it, vi } from 'vitest';

import { createFfmpegProgressParser } from './ffmpeg-progress';

describe('createFfmpegProgressParser', () => {
  it('emits complete progress records across arbitrary chunk boundaries', () => {
    const onRecord = vi.fn();
    const parser = createFfmpegProgressParser(onRecord);

    parser.push(Buffer.from('frame=12\nout_time_us=500'));
    parser.push(Buffer.from('000\npro'));
    parser.push(Buffer.from('gress=continue\r\nframe=24\nprogress=end\n'));

    expect(onRecord).toHaveBeenCalledTimes(2);
    expect(onRecord).toHaveBeenNthCalledWith(1, {
      phase: 'continue',
      fields: {
        frame: '12',
        out_time_us: '500000',
        progress: 'continue',
      },
    });
    expect(onRecord).toHaveBeenNthCalledWith(2, {
      phase: 'end',
      fields: {
        frame: '24',
        progress: 'end',
      },
    });
  });

  it('preserves equals signs in values and ignores malformed keys', () => {
    const records: unknown[] = [];
    const parser = createFfmpegProgressParser((record) => records.push(record));

    parser.push('detail=left=right\nnot a key=value\nprogress=end\n');

    expect(records).toEqual([
      {
        phase: 'end',
        fields: {
          detail: 'left=right',
          progress: 'end',
        },
      },
    ]);
  });

  it('flushes a final record without a trailing newline', () => {
    const onRecord = vi.fn();
    const parser = createFfmpegProgressParser(onRecord);

    parser.push('frame=1\nprogress=end');
    expect(onRecord).not.toHaveBeenCalled();

    parser.end();
    expect(onRecord).toHaveBeenCalledWith({
      phase: 'end',
      fields: { frame: '1', progress: 'end' },
    });
  });
});
