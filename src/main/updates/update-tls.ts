import { request } from 'node:https';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';

const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

export const createTrustedUpdateFetcher = (
  ca: string | Buffer,
): typeof fetch =>
  async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.protocol !== 'https:') {
      throw new TypeError('The trusted update fetcher requires HTTPS.');
    }
    if (init?.body !== undefined && init.body !== null) {
      throw new TypeError('The trusted update fetcher does not send bodies.');
    }
    const headers = new Headers(init?.headers);
    return new Promise<Response>((resolve, reject) => {
      const requestHandle = request(
        url,
        {
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(headers.entries()),
          ca: [...rootCertificates, ca],
          signal: init?.signal ?? undefined,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const entry of value) responseHeaders.append(name, entry);
            } else {
              responseHeaders.set(name, value);
            }
          }
          const body = NO_BODY_STATUSES.has(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          if (body === null) response.resume();
          resolve(
            new Response(body, {
              status,
              statusText: response.statusMessage ?? '',
              headers: responseHeaders,
            }),
          );
        },
      );
      requestHandle.once('error', reject);
      requestHandle.end();
    });
  };
