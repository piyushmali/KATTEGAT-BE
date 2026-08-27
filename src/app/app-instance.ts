import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';

/**
 * The concrete Fastify instance type this app uses.
 *
 * Named once here for two reasons. `FastifyInstance` with default generics assumes
 * the default type provider, while ours runs the Zod provider — mixing them
 * produces a wall of route-signature mismatches. And the logger is pino's
 * `Logger`, not Fastify's narrower `FastifyBaseLogger`, so that domain services
 * can take a real pino instance without every call site widening its type.
 *
 * Type-only module; erased at build.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  ZodTypeProvider
>;
