import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { agentIdParamSchema } from '../agents/agent.schema.js';
import {
  grantSessionBodySchema,
  grantSessionResponseSchema,
  listSessionsResponseSchema,
  sessionKeyParamSchema,
  agentSessionSchema,
} from './hiring.schema.js';

/**
 * Hiring routes: grant scoped authority to an agent, see it, take it back.
 *
 * Three endpoints, and the third is not optional. A marketplace that can grant authority and
 * cannot withdraw it has shipped the dangerous half of the feature.
 */
export const hiringRoutes: FastifyPluginAsyncZod = (app) => {
  const { hiring } = app.services;

  app.post(
    '/agents/:id/sessions',
    {
      schema: {
        operationId: 'hireAgent',
        tags: ['hiring'],
        summary: 'Grant an agent scoped, revocable authority',
        description:
          'Grants an Altana session key bounded by a spend ceiling, a call allowlist and an expiry, and registers it in the public Keystore so the authority is verifiable on chain rather than only in this API. The limits are enforced by the account contract, so they hold even if KATTEGAT stops running. Currently granted on a KATTEGAT-operated BSC testnet account rather than the caller wallet: see `sandbox` on the list endpoint.',
        params: agentIdParamSchema,
        body: grantSessionBodySchema,
        response: { 201: grantSessionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await hiring.grant(request.params.id, request.body);
      // 201: the grant created something that did not exist, on chain and here.
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/agents/:id/sessions',
    {
      schema: {
        operationId: 'listAgentSessions',
        tags: ['hiring'],
        summary: 'Authority granted to this agent',
        description:
          'Every session ever granted to this agent, newest first, with a derived `status` of active, expired or revoked. Expired and revoked are kept rather than deleted: what a user granted and when they withdrew it is the record that makes the safety claim checkable.',
        params: agentIdParamSchema,
        response: { 200: listSessionsResponseSchema },
      },
    },
    async (request) => hiring.listForAgent(request.params.id),
  );

  app.delete(
    '/sessions/:public_key',
    {
      schema: {
        operationId: 'revokeAgentSession',
        tags: ['hiring'],
        summary: 'Revoke an agent session',
        description:
          'Revokes on chain, then records it. One transaction, effective immediately: the session cannot act again. If the chain call fails the session stays marked active, because it still is.',
        params: sessionKeyParamSchema,
        response: { 200: agentSessionSchema },
      },
    },
    async (request) => hiring.revoke(request.params.public_key),
  );

  return Promise.resolve();
};
