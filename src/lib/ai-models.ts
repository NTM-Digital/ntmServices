// Which model each AI call should use, resolved from the `ai_model` table in
// the Auth DB rather than from an env var or a hardcoded string.
//
// Same resolution order as the credential table: a row scoped to this app via
// `app_ai_model` wins, otherwise the global row (no app_ai_model rows at all).
// Values are plain text — a model id is not a secret, so unlike credentials
// there is no decryption step.
//
// There is deliberately no process.env fallback. A model id has no sensible
// default: guessing one produces a confusing 404 from the provider, so a
// missing row throws with the key and app named instead.
import { APP_NAME } from './app-name.js';
import { cachedResolve } from './config-cache.js';

/**
 * Keys in `ai_model.key`. Add a row in the Auth DB before adding one here.
 *
 * As of 2026-10-28 the Auth DB offers three rows, all global and so already
 * visible to this app: OPEN_AI, GEMINI_FLASH and DEEP_SEEK_FLASH. Only the
 * ones actually called are listed here.
 */
export const AI_MODEL = {
  GEMINI_FLASH: 'GEMINI_FLASH',
} as const;

export type AiModelKey = (typeof AI_MODEL)[keyof typeof AI_MODEL];

/**
 * The model id for `key`, cached with a TTL (see config-cache.ts) — a model
 * changed in ntmbase is picked up without a restart, exactly like a
 * credential.
 *
 * Throws when no row matches, or the row has an empty value: sending
 * `undefined` to a provider surfaces as an opaque "model not found" far from
 * the real cause.
 */
export async function getAiModel(key: AiModelKey): Promise<string> {
  const value = await cachedResolve(`ai_model.${key}`, async () => {
    // Dynamic import keeps this module free of a top-level dependency on pg,
    // matching how env.ts reaches credentialsDatasource.
    const { aiModelDatasource } = await import('../datasources/aiModelDatasource.js');
    const model = await aiModelDatasource.getModelForApp(APP_NAME, key);
    return model?.value ?? undefined;
  });

  if (!value) {
    throw new Error(
      `No AI model configured for key "${key}" (app "${APP_NAME}"). ` +
      `Add a row to ai_model with that key, scoped to this app via app_ai_model or left global.`
    );
  }

  return value;
}
