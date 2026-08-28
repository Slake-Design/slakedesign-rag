import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Request-scoped correlation context.
 *
 * Mirrors the modules of the same name in task-queue-system and
 * mcp-sqlite-bridge deliberately: these services are meant to read as one
 * engineer's system, and an operator who learns the x-correlation-id
 * convention once should not have to learn it again per service.
 *
 * It matters more here than it looks. A RAG answer is streamed over SSE, so a
 * single logical request produces retrieval logs, a refusal-or-generate
 * decision, token-budget pruning lines and a completion line - potentially
 * interleaved with other concurrent streams. Without a shared ID those lines
 * cannot be reassembled into the request that produced them.
 */
export interface RequestContext {
    correlationId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Normalises a caller-supplied correlation ID.
 *
 * Accepted so a caller can stitch its own trace to ours, never trusted as-is:
 * the value ends up in log lines, so an unbounded or control-character-bearing
 * string is a log-injection vector. Anything that does not survive
 * normalisation is discarded for a fresh UUID rather than repaired.
 */
export function normaliseCorrelationId(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const cleaned = String(raw).trim().slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '');
    return cleaned.length > 0 ? cleaned : undefined;
}

export function getCorrelationId(): string | undefined {
    return requestContext.getStore()?.correlationId;
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
    return requestContext.run({ correlationId }, fn);
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
    const correlationId = normaliseCorrelationId(req.get(CORRELATION_HEADER)) ?? randomUUID();
    res.setHeader(CORRELATION_HEADER, correlationId);
    requestContext.run({ correlationId }, next);
}
