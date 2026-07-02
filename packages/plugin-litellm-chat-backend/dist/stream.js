"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.proxySSE = proxySSE;
const stream_1 = require("stream");
async function proxySSE(opts) {
    const { upstreamUrl, upstreamBody, userKey, res, logger, fallbackUrl, fallbackBody } = opts;
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
    };
    const fetchUpstream = async (url, body) => {
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
            err.status = upstream.status;
            throw err;
        }
        // Convert web ReadableStream → Node Readable for pipe compatibility.
        return stream_1.Readable.fromWeb(upstream.body);
    };
    try {
        let stream;
        try {
            stream = await fetchUpstream(upstreamUrl, upstreamBody);
        }
        catch (err) {
            // Fallback on any upstream error (non-200 or network). The primary
            // path is /v1/chat/completions + vector_store_ids; if that rejects
            // (e.g. vector_store_ids unsupported in some LiteLLM build), try
            // /v1/rag/query as fallback.
            if (fallbackUrl && fallbackBody) {
                logger.info(`Primary upstream failed (${err.status ?? err.message}) — trying fallback`);
                stream = await fetchUpstream(fallbackUrl, fallbackBody);
            }
            else {
                throw err;
            }
        }
        res.writeHead(200, headers);
        res.flushHeaders();
        stream.on('data', (chunk) => {
            res.write(chunk);
        });
        await new Promise((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        res.end();
    }
    catch (err) {
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
