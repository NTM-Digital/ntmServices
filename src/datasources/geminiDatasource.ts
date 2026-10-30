import { GoogleGenAI } from '@google/genai';
import { getEnv } from '../lib/env.js';
import { AI_MODEL, getAiModel } from '../lib/ai-models.js';

/** How long to wait between polls of a background interaction. */
const POLL_INTERVAL_MS = 5_000;

/** Give up on an interaction that has not finished within this long. Agentic
 *  video processing is slow, but an unbounded wait would hang the calling
 *  service's sync loop forever if an interaction ever got stuck. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Statuses that mean the interaction is still working. Note that a background
 *  interaction starts out `queued`, not `in_progress`, so polling only on
 *  `in_progress` would fall straight through and read an empty result. */
const PENDING_STATUSES = new Set(['queued', 'in_progress']);

/**
 * Token statistics, for cost tracking. The scalars worth billing against are
 * named; the index signature carries the per-modality breakdowns and anything
 * a future API version adds, so this does not have to mirror the SDK's whole
 * Usage type to stay accurate.
 */
export interface TokenUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  /** Thinking-model reasoning tokens — billed, and typically the largest share. */
  total_thought_tokens?: number;
  total_cached_tokens?: number;
  total_tool_use_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface VideoAnalysis<T> {
  /** The model's answer, parsed from JSON. */
  data: T;
  /** The unparsed response, kept for logging a result that parsed but looks wrong. */
  raw: string;
  /** Undefined if the API omitted it. */
  usage?: TokenUsage;
  /** Best-effort USD cost of this call — see estimateCostUsd. */
  estimatedCostUsd?: number;
}

/**
 * Gemini 3.8 Flash rates, USD per million tokens. These are introductory rates
 * that run to 2026-12-31 and double on 2027-01-01, so they need revisiting
 * then — an argument for eventually sourcing them from the ai_model table
 * alongside the model id, rather than redeploying every app that prices a call.
 */
const USD_PER_MILLION = {
  input: 0.75,
  /** Thought tokens bill at the output rate, not the input rate. */
  output: 3.75,
  cacheRead: 0.075,
};

/**
 * Best-effort cost of one interaction in USD.
 *
 * Two parts are inferred rather than documented, which is why this is only an
 * estimate: that tool-use tokens — the frames and transcripts agentic
 * processing pulls on demand — bill at the input rate, and that the cached
 * count overlaps the input and tool-use volume rather than adding to it, which
 * is what `total_tokens` excluding it implies.
 *
 * Reasoning usually dominates: it is charged at the output rate and is largely
 * insensitive to prompt size, so it sets the floor on what a call can cost.
 */
export function estimateCostUsd(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;

  const input = usage.total_input_tokens ?? 0;
  const toolUse = usage.total_tool_use_tokens ?? 0;
  const cached = usage.total_cached_tokens ?? 0;
  const output = usage.total_output_tokens ?? 0;
  const thought = usage.total_thought_tokens ?? 0;

  const atFullInputRate = Math.max(0, input + toolUse - cached);

  return (
    atFullInputRate * USD_PER_MILLION.input
    + cached * USD_PER_MILLION.cacheRead
    + (output + thought) * USD_PER_MILLION.output
  ) / 1_000_000;
}

export interface AnalyzeOptions {
  /**
   * JSON schema the response must conform to. Without one the model is only
   * told to emit JSON, so the keys it picks can drift between calls; with one
   * the shape is enforced server-side. Note that the API ignores `minLength`,
   * `maxLength`, `minProperties`, `maxProperties`, `uniqueItems` and
   * `contains` — validate those here if they matter.
   */
  schema?: Record<string, unknown>;
  /** How long to keep polling before giving up. */
  timeoutMs?: number;
}

class GeminiDatasource {
  constructor() {}

  /**
   * Builds a client per call rather than holding one on the instance. The API
   * key comes from the credential table with a TTL (see lib/config-cache.ts),
   * so a key rotated in ntmbase lands without a restart — which only works if
   * nothing pins the old one. Constructing GoogleGenAI costs microseconds
   * against the ~180ms the credential lookup takes, so there is nothing to
   * gain by caching it.
   */
  private async getClient(): Promise<GoogleGenAI> {
    return new GoogleGenAI({ apiKey: await getEnv.GOOGLE_GEMINI_API_KEY() });
  }

  /**
   * Asks Gemini a question about a YouTube video and returns the answer parsed
   * from JSON.
   *
   * The video is handed over as a URL with `processing: 'agentic'` — the model
   * watches it server-side, so nothing is downloaded or uploaded here. That is
   * slow enough that the interaction is created with `background: true` and
   * then polled, rather than held open on one long request.
   *
   * JSON comes from `response_format`, not from asking for it in the prompt:
   * the mime type is enforced by the API, so the result does not arrive wrapped
   * in prose or a markdown fence. Pass `options.schema` to pin the shape too.
   *
   * @param youtubeUrl A watch URL, e.g. https://www.youtube.com/watch?v=ID
   * @param prompt     What to ask about the video.
   * @throws if the interaction fails, is cancelled, exceeds its budget, times
   *         out, finishes with no text, or returns text that is not valid JSON.
   *         A silent empty or malformed result would otherwise be written to the
   *         database as if it were real output.
   */
  async analyzeYoutubeVideo<T = unknown>(
    youtubeUrl: string,
    prompt: string,
    options: AnalyzeOptions = {},
  ): Promise<VideoAnalysis<T>> {
    const { schema, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const client = await this.getClient();

    let interaction = await client.interactions.create({
      // The model id comes from the ai_model table, never a hardcoded string,
      // so it can be changed in ntmbase without a redeploy.
      model: await getAiModel(AI_MODEL.GEMINI_FLASH),
      input: [
        { type: 'video', uri: youtubeUrl, processing: 'agentic' },
        { type: 'text', text: prompt },
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        ...(schema ? { schema } : {}),
      },
      background: true,
    });

    const deadline = Date.now() + timeoutMs;
    while (PENDING_STATUSES.has(interaction.status)) {
      if (Date.now() > deadline) {
        // Leaving a background interaction running would keep burning budget
        // long after nothing is listening for its result.
        await client.interactions.cancel(interaction.id).catch(error =>
          console.error(`Failed to cancel timed-out interaction ${interaction.id}:`, error)
        );
        throw new Error(
          `Gemini interaction ${interaction.id} did not finish within ${Math.round(timeoutMs / 1000)}s `
          + `for ${youtubeUrl} (last status "${interaction.status}").`
        );
      }

      await this.sleep(POLL_INTERVAL_MS);
      interaction = await client.interactions.get(interaction.id);
    }

    if (interaction.status !== 'completed') {
      const errors = interaction.errors?.map(e => JSON.stringify(e)).join('; ');
      throw new Error(
        `Gemini interaction ${interaction.id} ended with status "${interaction.status}" for ${youtubeUrl}`
        + (errors ? `: ${errors}` : '')
      );
    }

    const raw = interaction.output_text;
    if (!raw) {
      throw new Error(
        `Gemini interaction ${interaction.id} completed without any output text for ${youtubeUrl}.`
      );
    }

    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch (error) {
      // The raw text is the only way to tell a truncated response from a model
      // that ignored the format, so a snippet of it goes in the message.
      throw new Error(
        `Gemini interaction ${interaction.id} returned text that is not valid JSON for ${youtubeUrl}: `
        + `${(error as Error).message}. Response starts: ${raw.slice(0, 200)}`
      );
    }

    return {
      data,
      raw,
      usage: interaction.usage,
      estimatedCostUsd: estimateCostUsd(interaction.usage),
    };
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const geminiDatasource = new GeminiDatasource();
