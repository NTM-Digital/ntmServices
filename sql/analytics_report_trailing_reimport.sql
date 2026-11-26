-- Adds the trailing re-import bookkeeping to analytics_report_jobs.
--
-- Apply once per schema, same as sql/analytics_report.sql:
--
--   psql "$NTM_DATA_DATABASE_URL" -f sql/analytics_report_trailing_reimport.sql
--   PGOPTIONS='-c search_path=dev' psql "$NTM_DATA_DATABASE_URL" -f sql/analytics_report_trailing_reimport.sql
--
-- A NULL here means "a trailing sweep is due", so existing rows sweep on the next pass -
-- which is the point: it is what recovers the days whose rows were skipped because
-- owned_videos had not caught up with youtube yet.
ALTER TABLE analytics_report_jobs
  ADD COLUMN IF NOT EXISTS last_trailing_reimport_at timestamptz;
