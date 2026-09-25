import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { walletParamSchema, walletTrackingResponseSchema } from './tracking.schema.js';

/**
 * Campaign verification.
 *
 * Exists because two things the Set and Earn quest asks about are not answerable from chain state
 * alone. A hire is an on-chain session grant, but the session names contract addresses rather than
 * an agent, so which agent was hired is KATTEGAT's record. And "listed an agent of their own" is a
 * question about ownership in the ERC-8004 registry that a verifier would otherwise have to walk
 * 325,546 ids to answer.
 *
 * Read-only, unauthenticated and keyed on a public address, which is the same posture as the rest
 * of the API. Nothing here is writable and nothing returned is private: a session public key, a
 * spend ceiling and a transaction hash are all already on chain.
 */
export const trackingRoutes: FastifyPluginAsyncZod = (app) => {
  const { tracking } = app.services;

  app.get(
    '/tracking/wallets/:address',
    {
      schema: {
        operationId: 'trackWallet',
        tags: ['tracking'],
        summary: 'Quest progress and hiring evidence for one wallet',
        description:
          'Everything needed to verify a wallet against the Set and Earn quest: which of the four campaign categories it has hired in, whether it owns an agent in the catalogue, and the evidence behind both. `quest.complete` is the single field a verifier can read if it reads nothing else. Both halves of the quest come with on-chain proof: every hire carries `granted_tx_hash` for the session grant, and every listed agent carries `registration_tx_hash` for the registration, whose own `Registered` log names the owner. Neither has to be taken on trust. Address matching is case-insensitive, because session wallets are stored checksummed and registry owners lowercased. An unknown wallet is a 200 with empty lists rather than a 404: "this wallet did nothing" is an answer, not a missing resource.',
        params: walletParamSchema,
        response: { 200: walletTrackingResponseSchema },
      },
    },
    async (request) => tracking.forWallet(request.params.address),
  );

  return Promise.resolve();
};
