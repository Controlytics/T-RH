import { gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

/**
 * gzip a large JSON response when the client accepts it (performance audit
 * 2026-11-17, P-02; operator chose "share + compress").
 *
 * The overview at 1,013 instruments is ~1 MB of JSON per viewer every 5 s, and the
 * Data Report and audit pages send hundreds of KB; JSON this repetitive shrinks
 * roughly tenfold. No dependency: Node's zlib, on its thread pool (async), at the
 * fastest level — the API's limit is CPU (P-02), so bytes are traded cheaply.
 *
 * Only a string / Buffer JSON body of at least COMPRESS_MIN_BYTES, only when the
 * request says `Accept-Encoding: gzip`, never a body already encoded and never a
 * stream (the backup download). `Vary: Accept-Encoding` is added so a cache cannot
 * serve the gzip body to a client that did not ask for it.
 */
export const COMPRESS_MIN_BYTES = 16 * 1024;

type HeaderValue = string | number | string[] | undefined;
interface ReplyLike {
  getHeader: (name: string) => HeaderValue;
  header: (name: string, value: string) => unknown;
  removeHeader: (name: string) => unknown;
}
interface RequestLike { headers: Record<string, string | string[] | undefined> }

export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  const value = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding ?? '';
  return value.split(',').some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

export function registerJsonCompression(app: {
  addHook: (name: 'onSend', fn: (req: RequestLike, reply: ReplyLike, payload: unknown) => Promise<unknown>) => unknown;
}): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    if (Buffer.byteLength(payload) < COMPRESS_MIN_BYTES) return payload;
    if (reply.getHeader('content-encoding')) return payload;
    if (!String(reply.getHeader('content-type') ?? '').includes('application/json')) return payload;
    if (!acceptsGzip(req.headers['accept-encoding'])) return payload;
    const body = await gzipAsync(payload, { level: constants.Z_BEST_SPEED });
    reply.header('content-encoding', 'gzip');
    const vary = String(reply.getHeader('vary') ?? '');
    if (!/\baccept-encoding\b/i.test(vary)) reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
    reply.removeHeader('content-length');
    return body;
  });
}
