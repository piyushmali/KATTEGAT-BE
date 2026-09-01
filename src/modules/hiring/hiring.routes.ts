import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { agentIdParamSchema } from '../agents/agent.schema.js';
import {
  agentSessionSchema,
  listSessionsResponseSchema,
  recordSessionBodySchema,
  recordSessionResponseSchema,
  sessionKeyParamSchema,
  sponsorGasBodySchema,
  sponsorGasResponseSchema,
} from './hiring.schema.js';

/**
 * Hiring routes.
 *
 * Note what is absent: there is no endpoint that grants authority, because the backend holds
 * no key that could. The user's passkey signs the grant in their browser and these endpoints
 * verify and record it. `POST /sessions` is a report, not a command.
 */
export const hiringRoutes: FastifyPluginAsyncZod = (app) => {
  const { hiring } = app.services;

  app.post(
    '/agents/:id/sessions/gas',
    {
      schema: {
        operationId: 'sponsorWalletGas',
        tags: ['hiring'],
        summary: 'Top up a wallet with enough native gas to grant a session',
        description:
          'Sends a small fixed amount of the native token to the caller wallet so a first-time user can hire without funding an account first. Bounded per address by current balance, so a repeat call is a no-op rather than a top-up. The sponsor key can only send native tokens: it holds no authority over any account.',
        params: agentIdParamSchema,
        body: sponsorGasBodySchema,
        response: { 200: sponsorGasResponseSchema },
      },
    },
    async (request) => ({ data: await hiring.sponsorGas(request.body.wallet_address) }),
  );

  app.post(
    '/agents/:id/sessions',
    {
      schema: {
        operationId: 'recordAgentSession',
        tags: ['hiring'],
        summary: 'Record a session the user granted in their browser',
        description:
          'Reports authority that already exists on chain. The session is verified against the public Altana Keystore before anything is stored, so a fabricated claim is rejected rather than displayed as a live spend cap. Returns 400 when the Keystore does not show the key as authorised on that wallet.',
        params: agentIdParamSchema,
        body: recordSessionBodySchema,
        response: { 201: recordSessionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await hiring.recordSession(request.params.id, request.body);
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
          'Every session recorded for this agent, newest first. `status` is read from the Keystore rather than from our own columns, so a revocation performed anywhere (another app, or the Altana MCP server) is reflected here. `meta` carries everything chain-specific the client needs, so no UI hardcodes a network.',
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
        operationId: 'confirmSessionRevoked',
        tags: ['hiring'],
        summary: 'Confirm a revocation the user performed in their browser',
        description:
          'Records that authority has ended. Verified first: returns 400 while the Keystore still shows the session as authorised, because marking it revoked early would switch off the revoke button while the agent could still act. The revocation itself is signed by the user passkey, never here.',
        params: sessionKeyParamSchema,
        response: { 200: agentSessionSchema },
      },
    },
    async (request) => hiring.confirmRevoked(request.params.public_key),
  );

  return Promise.resolve();
};
