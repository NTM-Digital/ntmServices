// Single source of truth for environment configuration.
//
// Most variables here can be overridden by a row in the `credential` table of
// the Auth DB (app-specific first, then global) — see resolveEnv() below —
// falling back to process.env when there's no override. That means an API key
// rotated once in ntmbase reaches this app without editing .env on the box and
// without a redeploy. Three variables never go through that lookup because
// they're needed to reach the table in the first place:
//
//   - POSTGRES_URL: the connection string for the Auth DB the credential
//     table lives in.
//   - ENCRYPTION_KEY: needed to decrypt whatever the table returns.
//   - APP_NAME: the "app-specific" half of the lookup itself (app-name.ts).
//
// Sourcing any of them from the credential table would be circular.
//
// The other connection strings are deliberately kept as plain process.env
// reads so they stay synchronous: NTM_TASKS_DATABASE_URL and
// NTM_DATA_DATABASE_URL both back `new Pool(...)` calls built at module load,
// and routing them through the async lookup would push every datasource onto
// lazy, promise-cached pools for no benefit.
//
// dotenv is loaded here, before any of the reads below, so that importing this
// module is enough to get a populated process.env.
import dotenv from 'dotenv';
import { decryptValues } from './encryption.js';
import { cachedResolve } from './config-cache.js';
import { APP_NAME } from './app-name.js';

// In production (Coolify) environment variables are injected directly.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Bootstrap — see the note above.
export const POSTGRES_URL = process.env.POSTGRES_URL;
export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// Synchronous by design: both back connection pools built at module load.
export const NTM_TASKS_DATABASE_URL = process.env.NTM_TASKS_DATABASE_URL;
export const NTM_DATA_DATABASE_URL = process.env.NTM_DATA_DATABASE_URL;

// This deployment's own app identity in the `apps` table — used as the
// "app-specific" half of the credential lookup below.
const CURRENT_APP = APP_NAME;

/**
 * Resolves a config value, preferring a credential-table override (matched by
 * the credential's `key` column against `name`, app-specific beating global)
 * and falling back to `fallback` (i.e. process.env.<name>) otherwise. Only a
 * credential whose value bag has exactly one entry counts as a valid
 * override — a multi-field credential (e.g. a service account) isn't a
 * single string. Results are cached with a TTL (see config-cache.ts), so a
 * value changed in ntmbase is picked up without a restart.
 */
async function resolveEnv(name: string, fallback: string | undefined): Promise<string | undefined> {
  return cachedResolve(name, async () => {
    let resolved = fallback;
    try {
      // Dynamic import avoids a top-level circular dependency: credentialsDatasource
      // reads POSTGRES_URL from this module at construction time, so this module
      // can't import it eagerly at the top level.
      const { credentialsDatasource } = await import('../datasources/credentialsDatasource.js');
      const credential = await credentialsDatasource.getCredentialForApp(CURRENT_APP, name);
      if (credential) {
        const values = decryptValues(credential.values ?? {});
        const entries = Object.values(values);
        if (entries.length === 1) {
          resolved = entries[0];
        } else if (entries.length > 1) {
          console.error(`Credential "${credential.name}" (key ${name}) has ${entries.length} values — expected exactly 1 for an env override. Falling back to process.env.`);
        }
      }
    } catch (error) {
      console.error(`Error resolving "${name}" from the credential table, falling back to process.env:`, error);
    }

    if (!resolved) {
      console.error(`Environment variable "${name}" is not set and no valid credential override found.`);
    }
    return resolved;
  });
}

/**
 * Resolves one named field out of a multi-field credential — a service account,
 * say, whose value bag holds several related secrets under a single `key`.
 * resolveEnv()'s single-value rule deliberately rejects those, so this is the
 * way to reach them. Falls back to `fallback` when the credential is absent,
 * the field is missing from it, or the lookup fails.
 */
async function resolveEnvField(
  credentialKey: string,
  field: string,
  fallback: string | undefined
): Promise<string | undefined> {
  return cachedResolve(`${credentialKey}.${field}`, async () => {
    let resolved = fallback;
    try {
      const { credentialsDatasource } = await import('../datasources/credentialsDatasource.js');
      const credential = await credentialsDatasource.getCredentialForApp(CURRENT_APP, credentialKey);
      if (credential) {
        const values = decryptValues(credential.values ?? {});
        if (values[field] !== undefined) {
          resolved = values[field];
        } else {
          console.error(`Credential "${credential.name}" (key ${credentialKey}) has no field "${field}" — expected one of [${Object.keys(values).join(', ')}]. Falling back to process.env.`);
        }
      }
    } catch (error) {
      console.error(`Error resolving "${credentialKey}.${field}" from the credential table, falling back to process.env:`, error);
    }

    if (!resolved) {
      console.error(`Environment value "${credentialKey}.${field}" is not set and no valid credential override found.`);
    }
    return resolved;
  });
}

export const getEnv = {
  // One entry per credential-backed variable. `as Promise<string>` only where
  // the consumer genuinely cannot handle undefined.
  NTM_DATA_PROTECTED_API_ENDPOINT_KEY: () => resolveEnv('NTM_DATA_PROTECTED_API_ENDPOINT_KEY', process.env.NTM_DATA_PROTECTED_API_ENDPOINT_KEY) as Promise<string>,
  TRELLO_API_KEY: () => resolveEnv('TRELLO_API_KEY', process.env.TRELLO_API_KEY) as Promise<string>,
  TRELLO_TOKEN: () => resolveEnv('TRELLO_TOKEN', process.env.TRELLO_TOKEN) as Promise<string>,
  TRELLO_NTM_BOARD_ID: () => resolveEnv('TRELLO_NTM_BOARD_ID', process.env.TRELLO_NTM_BOARD_ID) as Promise<string>,

  // Resolved entirely from the credential table: there is a global
  // GOOGLE_GEMINI_API_KEY row, and no copy of this key in .env.
  GOOGLE_GEMINI_API_KEY: () => resolveEnv('GOOGLE_GEMINI_API_KEY', process.env.GOOGLE_GEMINI_API_KEY) as Promise<string>,

  // A two-field service-account credential: reached by field, not by key.
  GOOGLE_CLIENT_EMAIL: () => resolveEnvField('GOOGLE_SERVICE_ACCOUNT', 'google_client_email', process.env.GOOGLE_CLIENT_EMAIL),
  GOOGLE_PRIVATE_KEY: () => resolveEnvField('GOOGLE_SERVICE_ACCOUNT', 'google_private_key', process.env.GOOGLE_PRIVATE_KEY),
};

export const isProduction = process.env.NODE_ENV === 'production';
