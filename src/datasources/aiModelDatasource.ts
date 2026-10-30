import PG from 'pg';
import { POSTGRES_URL } from '../lib/env.js';

export interface AiModel {
  id: number;
  name: string | null;
  key: string | null; // upper snake case, e.g. GEMINI_FLASH
  value: string | null; // the provider's model id, e.g. gemini-3.8-flash
  last_updated: Date | null;
}

class AiModelDatasource {
  private pool: PG.Pool;

  constructor() {
    // Lives in the Auth DB alongside the credential table, and like it is
    // bootstrap config read straight from process.env.
    this.pool = new PG.Pool({
      connectionString: POSTGRES_URL
    });
  }

  /**
   * App-specific model wins if one exists; otherwise falls back to the global
   * one (no app_ai_model rows). Matched on the model's own `key` column — the
   * same resolution order the credential table uses.
   *
   * Values here are plain text: unlike credentials, a model id is not a secret.
   */
  public async getModelForApp(appName: string, key: string): Promise<AiModel | null> {
    const result = await this.pool.query(
      `SELECT m.id, m.name, m.key, m.value, m.last_updated,
              am.app_name IS NOT NULL AS app_specific
       FROM ai_model m
       LEFT JOIN app_ai_model am ON am.ai_model_id = m.id AND am.app_name = $1
       WHERE m.key = $2
         AND (
           am.app_name IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM app_ai_model a2 WHERE a2.ai_model_id = m.id)
         )
       ORDER BY app_specific DESC
       LIMIT 1`,
      [appName, key]
    );

    if (result.rows.length === 0) return null;
    const { app_specific, ...row } = result.rows[0];
    return row;
  }

  /** Every model this app can see, app-specific shadowing global. */
  public async getModelsForApp(appName: string): Promise<AiModel[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (m.key) m.id, m.name, m.key, m.value, m.last_updated
       FROM ai_model m
       LEFT JOIN app_ai_model am ON am.ai_model_id = m.id AND am.app_name = $1
       WHERE am.app_name IS NOT NULL
          OR NOT EXISTS (SELECT 1 FROM app_ai_model a2 WHERE a2.ai_model_id = m.id)
       ORDER BY m.key, (am.app_name IS NOT NULL) DESC`,
      [appName]
    );
    return result.rows;
  }
}

export const aiModelDatasource = new AiModelDatasource();
