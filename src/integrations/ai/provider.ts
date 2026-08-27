import type { Env } from '../../config/env.js';

/**
 * Provider-agnostic AI boundary.
 *
 * KATTEGAT will likely change model providers during the hackathon depending on
 * credits, quota and latency, so no provider name appears anywhere outside this
 * file. Callers depend on {@link AiProvider}.
 *
 * There is intentionally no SDK dependency. The only provider implemented speaks
 * the OpenAI-compatible `/chat/completions` shape over plain `fetch`, which every
 * major host (OpenAI, Groq, Together, OpenRouter, Ollama, vLLM) accepts. Adding a
 * vendor SDK for one HTTP POST would be a dependency with no payoff.
 *
 * Nothing in the bootstrap requires this: classification is deterministic by
 * design (see modules/classification/classifier.ts). It exists so that
 * natural-language search — the one place a model genuinely earns its latency —
 * can be added without threading a provider through the app.
 */

export interface AiCompletionRequest {
  system: string;
  user: string;
  /** Caps spend and latency. Providers treat this as an upper bound. */
  maxOutputTokens?: number;
  /** 0 for extraction-style tasks where determinism matters more than variety. */
  temperature?: number;
}

export interface AiProvider {
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<string>;
}

/**
 * Returns null when no provider is configured.
 *
 * A null provider is a supported state, not a failure: every feature behind this
 * boundary must degrade to a deterministic path, so the marketplace never depends
 * on model availability to render.
 */
export function createAiProvider(env: Env): AiProvider | null {
  if (env.AI_PROVIDER === 'none') return null;

  const baseUrl = env.AI_BASE_URL.replace(/\/$/, '');
  const model = env.AI_MODEL;
  const apiKey = env.AI_API_KEY;

  return {
    name: `openai-compatible:${model || 'unspecified'}`,
    async complete(request: AiCompletionRequest): Promise<string> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxOutputTokens ?? 512,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
      });

      if (!response.ok) {
        // The body may echo the API key or account details — never surfaced.
        throw new Error(`AI provider returned ${String(response.status)}`);
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };

      return payload.choices?.[0]?.message?.content ?? '';
    },
  };
}
