import type { Response } from 'express';
import { Readable } from 'stream';

export interface ProxySSEOptions {
  upstreamUrl: string;
  upstreamBody: unknown;
  userKey: string;
  res: Response;
  logger: any;
}

export async function proxySSE(opts: ProxySSEOptions): Promise<void> {
  const { upstreamUrl, upstreamBody, userKey, res, logger } = opts;

  const controller = new AbortController();

  res.on('close', () => controller.abort());

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  };

  const fetchUpstream = async (url: string, body: unknown): Promise<Readable> => {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      const err = new Error(`upstream ${upstream.status}: ${text || upstream.statusText}`);
      (err as any).status = upstream.status;
      throw err;
    }

    // Convert web ReadableStream → Node Readable for pipe compatibility.
    return Readable.fromWeb(upstream.body as any);
  };

  try {
    const stream = await fetchUpstream(upstreamUrl, upstreamBody);

    res.writeHead(200, headers);
    res.flushHeaders();

    stream.on('data', (chunk: Buffer) => {
      res.write(chunk);
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    res.end();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.debug('SSE client disconnected');
      return;
    }
    logger.error('SSE proxy error', err);
    if (!res.headersSent) {
      res.writeHead(200, headers);
    }
    res.write(`data: ${JSON.stringify({ error: err.message || 'stream error' })}\n\n`);
    res.end();
  }
}