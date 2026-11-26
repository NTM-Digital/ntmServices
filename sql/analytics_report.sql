-- Daily YouTube analytics, imported from the YouTube Reporting API (youtubereporting v1)
-- by src/services/analyticsReportService.ts.
--
-- This repo has no migration runner, so this file is applied by hand. The ntmData DB
-- carries parallel `public` and `dev` schemas and nothing in src/ qualifies a schema
-- name, so APPLY THIS TWICE - once per schema:
--
--   psql "$NTM_DATA_DATABASE_URL" -f sql/analytics_report.sql
--   PGOPTIONS='-c search_path=dev' psql "$NTM_DATA_DATABASE_URL" -f sql/analytics_report.sql
--
-- PGOPTIONS is used rather than a leading `SET search_path`, because psql's -c and -f
-- cannot be combined in one invocation and the unqualified names below have to resolve
-- to the target schema for the whole file - including the REFERENCES clauses, which
-- must point at that schema's own owned_videos / owned_shorts / owned_channels.
--
-- Timestamps here are `timestamptz` throughout. The older tables in this DB store naive
-- `timestamp` holding UTC, which node-pg then reads back as local time - a foot-gun the
-- app already works around with an explicit `AT TIME ZONE 'UTC'` cast. Using timestamptz
-- in the new tables means no cast is ever needed. The inconsistency is between old and
-- new tables, never within one.

-- ---------------------------------------------------------------------------
-- analytics_report: one row per owned video per day.
-- ---------------------------------------------------------------------------
-- `date` is a PACIFIC calendar date: YouTube's analytics day runs midnight to midnight
-- America/Los_Angeles. Joining it against videos.publish_date (UTC) can therefore show
-- "views before publish" at the edges.
--
-- Provenance contract for consumers: when basic_report_id IS NOT NULL the
-- channel_basic_a3 metrics on that row are authoritative, and a NULL among them means
-- zero. When it IS NULL they were never imported. Same for reach_report_id and the
-- thumbnail columns. A row can legitimately carry only one source - thumbnail
-- impressions with no views that day, for instance - so never read `views IS NULL` as
-- "zero views".
--
-- There is deliberately no owned_channel_id here: channel is reached by joining
-- owned_videos. The import scopes its per-channel statements with
-- `owned_video_id IN (SELECT id FROM owned_videos WHERE owned_channel_id = $1)`.
CREATE TABLE analytics_report (
    id                               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owned_video_id                   integer NOT NULL
                                       REFERENCES owned_videos(id) ON UPDATE CASCADE ON DELETE CASCADE,
    video_id                         text    NOT NULL,
    date                             date    NOT NULL,

    -- channel_basic_a3, summed over country_code / subscribed_status / live_or_on_demand
    views                            bigint,
    engaged_views                    bigint,
    watch_time_minutes               double precision,
    average_view_duration_seconds    double precision,   -- views-weighted, never summed
    average_view_duration_percentage double precision,   -- views-weighted, never summed
    likes                            integer,
    dislikes                         integer,
    comments                         integer,
    shares                           integer,
    videos_added_to_playlists        integer,
    videos_removed_from_playlists    integer,
    subscribers_gained               integer,
    subscribers_lost                 integer,
    red_views                        bigint,
    red_watch_time_minutes           double precision,

    -- channel_reach_basic_a1
    thumbnail_impressions            bigint,
    -- video_thumbnail_impressions_ctr, normalised to a PERCENTAGE on import so it
    -- matches the scale the rest of this codebase works in (CTR_THRESHOLD = 6.5 in
    -- thumbnailsController.ts, and thumbnails.ctrs).
    impressions_ctr                  double precision,

    basic_report_id                  text,
    basic_report_create_time         timestamptz,
    reach_report_id                  text,
    reach_report_create_time         timestamptz,
    last_update                      timestamptz DEFAULT now(),

    CONSTRAINT analytics_report_uc UNIQUE (video_id, date)
);

CREATE INDEX analytics_report_date_idx        ON analytics_report (date);
CREATE INDEX analytics_report_owned_video_idx ON analytics_report (owned_video_id, date);

-- ---------------------------------------------------------------------------
-- analytics_report_shorts: the same, keyed to owned_shorts.
-- ---------------------------------------------------------------------------
-- Shorts live in owned_shorts, not owned_videos, so a video-keyed table would silently
-- drop every one of them. Columns are kept identical to analytics_report so the import
-- and the aggregation code are shared; columns a short has no data for stay NULL.
CREATE TABLE analytics_report_shorts (
    id                               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owned_short_id                   integer NOT NULL
                                       REFERENCES owned_shorts(id) ON UPDATE CASCADE ON DELETE CASCADE,
    video_id                         text    NOT NULL,
    date                             date    NOT NULL,

    views                            bigint,
    engaged_views                    bigint,
    watch_time_minutes               double precision,
    average_view_duration_seconds    double precision,
    average_view_duration_percentage double precision,
    likes                            integer,
    dislikes                         integer,
    comments                         integer,
    shares                           integer,
    videos_added_to_playlists        integer,
    videos_removed_from_playlists    integer,
    subscribers_gained               integer,
    subscribers_lost                 integer,
    red_views                        bigint,
    red_watch_time_minutes           double precision,

    thumbnail_impressions            bigint,
    impressions_ctr                  double precision,

    basic_report_id                  text,
    basic_report_create_time         timestamptz,
    reach_report_id                  text,
    reach_report_create_time         timestamptz,
    last_update                      timestamptz DEFAULT now(),

    CONSTRAINT analytics_report_shorts_uc UNIQUE (video_id, date)
);

CREATE INDEX analytics_report_shorts_date_idx  ON analytics_report_shorts (date);
CREATE INDEX analytics_report_shorts_short_idx ON analytics_report_shorts (owned_short_id, date);

-- ---------------------------------------------------------------------------
-- analytics_report_channel: channel/day totals.
-- ---------------------------------------------------------------------------
-- Built from the rows YouTube reports with an EMPTY video_id - activity that belongs to
-- the channel rather than to any one video, such as subscribers gained from the channel
-- page and channel-surface views. Those rows have no valid owned_video_id, so without
-- this table they would be discarded and channel totals would sit below what Studio
-- shows with nothing to explain the gap.
--
-- No average_view_duration_* here: those are views-weighted within a single video, and
-- the weighting is not valid across videos of differing length.
CREATE TABLE analytics_report_channel (
    id                      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owned_channels_id       integer NOT NULL REFERENCES owned_channels(id) ON DELETE CASCADE,
    date                    date    NOT NULL,

    views                   bigint,
    engaged_views           bigint,
    watch_time_minutes      double precision,
    likes                   integer,
    dislikes                integer,
    comments                integer,
    shares                  integer,
    subscribers_gained      integer,
    subscribers_lost        integer,
    red_views               bigint,
    red_watch_time_minutes  double precision,
    thumbnail_impressions   bigint,

    basic_report_id         text,
    basic_report_create_time timestamptz,
    reach_report_id         text,
    reach_report_create_time timestamptz,
    last_update             timestamptz DEFAULT now(),

    CONSTRAINT analytics_report_channel_uc UNIQUE (owned_channels_id, date)
);

CREATE INDEX analytics_report_channel_date_idx ON analytics_report_channel (date);

-- ---------------------------------------------------------------------------
-- analytics_report_jobs: one reporting job per channel per report type.
-- ---------------------------------------------------------------------------
CREATE TABLE analytics_report_jobs (
    id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owned_channels_id integer NOT NULL REFERENCES owned_channels(id) ON DELETE CASCADE,
    report_type_id    text    NOT NULL,
    job_id            text    NOT NULL,
    job_name          text,
    job_create_time   timestamptz,
    last_polled_at    timestamptz,
    -- When this job last had its trailing window re-imported regardless of the ledger.
    -- NULL means one is due. See TRAILING_REIMPORT_DAYS in analyticsReportController.ts.
    last_trailing_reimport_at timestamptz,

    CONSTRAINT analytics_report_jobs_uc     UNIQUE (owned_channels_id, report_type_id),
    -- Two youtube_analytics_params rows sharing a refresh token would otherwise both
    -- bind the same youtube job and fight over it.
    CONSTRAINT analytics_report_jobs_job_uc UNIQUE (job_id)
);

-- ---------------------------------------------------------------------------
-- analytics_report_imports: the import cursor, not a log.
-- ---------------------------------------------------------------------------
-- jobs.reports.list is filtered against this table, which is what makes a per-run
-- download cap safe: capping a list that still included already-imported reports would
-- re-take the same first N every pass and never reach the N+1th. The row is written in
-- the same transaction as the data it describes, so there is no "data committed but
-- cursor lost" state.
CREATE TABLE analytics_report_imports (
    report_id         text PRIMARY KEY,
    job_id            text    NOT NULL,
    owned_channels_id integer NOT NULL REFERENCES owned_channels(id) ON DELETE CASCADE,
    report_type_id    text    NOT NULL,
    report_date       date    NOT NULL,        -- the Pacific day this report covers
    create_time       timestamptz NOT NULL,    -- youtube's report createTime
    rows_written      integer,
    rows_skipped      integer,
    superseded        boolean DEFAULT false,   -- a newer report replaced this day
    imported_at       timestamptz DEFAULT now()
);

CREATE INDEX analytics_report_imports_job_idx ON analytics_report_imports (job_id, create_time);
