import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { isAppError } from '../shared/errors.js';
import type { AppError } from '../shared/errors.js';
import type { AppInstance } from './app-instance.js';

/**
 * Single exit point for every error the API returns.
 *
 * Two rules it exists to enforce:
 *  1. One response shape, always — `{ error: { code, message, details?, request_id } }`.
 *  2. Nothing unintended leaks. Only errors we raised deliberately have their
 *     message forwarded; anything else becomes a generic 500 and the real cause
 *     goes to the log with the request id, so support can still correlate it.
 */
export function registerErrorHandler(app: AppInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} does not exist.`,
        request_id: request.id,
      },
    });
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Request validation failed against a Zod schema — tell the caller which field.
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ err: error }, 'request validation failed');
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request did not match the expected schema.',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
          request_id: request.id,
        },
      });
    }

    // We produced a response that violates our own contract. That is our bug, and
    // it must be loud in the log while staying opaque to the caller.
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, route: error.method ? `${error.method} ${error.url}` : undefined },
        'response failed contract validation',
      );
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The server produced a malformed response.',
          request_id: request.id,
        },
      });
    }

    if (isAppError(error)) {
      const appError: AppError = error;
      const log = appError.statusCode >= 500 ? request.log.error : request.log.warn;
      log.call(request.log, { err: appError, code: appError.code }, 'request failed');

      return reply.status(appError.statusCode).send({
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details === undefined ? {} : { details: appError.details }),
          request_id: request.id,
        },
      });
    }

    // @fastify/rate-limit and other plugins signal intent through statusCode.
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Slow down and retry shortly.',
          request_id: request.id,
        },
      });
    }

    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error }, 'client error');
      return reply.status(error.statusCode).send({
        error: {
          code: 'BAD_REQUEST',
          message: error.message,
          request_id: request.id,
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        // Deliberately generic: an unexpected error's message may contain a
        // connection string, a provider payload or a stack fragment.
        message: 'Something went wrong handling this request.',
        request_id: request.id,
      },
    });
  });
}
