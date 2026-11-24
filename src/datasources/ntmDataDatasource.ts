  import pg  from 'pg';
  import { NTM_DATA_DATABASE_URL } from '../lib/env.js';

  const pool = new pg.Pool({
    connectionString: NTM_DATA_DATABASE_URL,
    // Every service in this process shares this pool. pg defaults to 10, which the
    // description backfill can saturate on its own once it is running several videos
    // in parallel — and a saturated pool makes the other services queue rather than
    // fail, which is hard to spot. The headroom keeps them independent.
    max: 20
  });

  export interface VideoWithoutCreator {
    video_id: string;
    owned_channel_id: number;
    filming_date: string | null;
    data_users_id: number | null;
    ctr_first_24h: Record<string, any> | null;
  }
  export const findVideosWithoutCreatorsOrFilmingDates = async (): Promise<VideoWithoutCreator[]> => {
    const client = await pool.connect();
    try {
      const query = `SELECT DISTINCT
            ow.video_id,
            ow.owned_channel_id,
            ow.filming_date,
            ouj.data_users_id 
        FROM owned_videos ow
        INNER JOIN videos v
            ON ow.video_id = v.video_id
        LEFT JOIN owned_videos_data_users_junction ouj
            ON ouj.video_id = ow.video_id
        WHERE v.publish_date >= TIMESTAMP '2024-01-01'
        AND (ow.filming_date IS NULL OR ouj.video_id IS NULL)`;
      const result = await client.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error finding videos without creators:', error);
      throw error;
    } finally {
      client.release();
    }
  }

    export const findShortsWithoutCreatorsOrFilmingDates = async (): Promise<VideoWithoutCreator[]> => {
    const client = await pool.connect();
    try {
      const query = `SELECT DISTINCT
            os.video_id,
            os.owned_channel_id,
            os.filming_date,
            ouj.data_users_id 
        FROM owned_shorts os
        INNER JOIN shorts s
            ON os.video_id = s.video_id
        LEFT JOIN owned_shorts_data_users_junction ouj
            ON ouj.video_id = os.video_id
        WHERE s.publish_date >= TIMESTAMP '2024-01-01'
        AND (os.filming_date IS NULL OR ouj.video_id IS NULL)`;
      const result = await client.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error finding shorts without creators:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  export const getDataUserIdByName = async (name: string): Promise<number | null> => {
    const client = await pool.connect();
    try {
      const query = `SELECT id FROM data_users WHERE name ilike $1 LIMIT 1`;
        const result = await client.query(query, [name]);
        if (result.rows.length > 0) {
          return result.rows[0].id;
        } else {
          return null;
        }
    } catch (error) {
      console.error('Error getting data user ID by name:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  export const setFilmingDateForVideo = async (videoId: string, filmingDate: string): Promise<void> => {
    const client = await pool.connect();
    try {
        const query = `UPDATE owned_videos SET filming_date = $1 WHERE video_id = $2`;
        await client.query(query, [filmingDate, videoId]);
    } catch (error) {
        console.error('Error setting filming date for video:', error);
        throw error;
    } finally {
        client.release();
    }
  } 

    export const setFilmingDateForShort = async (videoId: string, filmingDate: string): Promise<void> => {
    const client = await pool.connect();
    try {
        const query = `UPDATE owned_shorts SET filming_date = $1 WHERE video_id = $2`;
        await client.query(query, [filmingDate, videoId]);
    } catch (error) {
        console.error('Error setting filming date for short:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export const setVideoCreator = async (videoId: string, dataUserId: number, owned_channel_id:number): Promise<void> => {
    const client = await pool.connect();
    try {
      // First, delete any existing assignments for this video/channel combination
      const deleteQuery = `DELETE FROM owned_videos_data_users_junction
                          WHERE video_id = $1 AND owned_channels_id = $2`;
      await client.query(deleteQuery, [videoId, owned_channel_id]);
      
      const query = `INSERT INTO owned_videos_data_users_junction (video_id, data_users_id, owned_channels_id, percentage) VALUES ($1, $2, $3, 100)
                       ON CONFLICT DO NOTHING`; 
      await client.query(query, [videoId, dataUserId, owned_channel_id]);
    } catch (error) {
        console.error('Error setting video creator:', error);
        throw error;
    } finally {
        client.release();
    }
  }

    export const setShortCreator = async (videoId: string, dataUserId: number, owned_channel_id:number): Promise<void> => {
    const client = await pool.connect();
    try {
        const deleteQuery = `DELETE FROM owned_shorts_data_users_junction
                            WHERE video_id = $1 AND owned_channels_id = $2`;
        await client.query(deleteQuery, [videoId, owned_channel_id]);

        const query = `INSERT INTO owned_shorts_data_users_junction (video_id, data_users_id, owned_channels_id, percentage) VALUES ($1, $2, $3, 100)
                       ON CONFLICT DO NOTHING`; 
        await client.query(query, [videoId, dataUserId, owned_channel_id]);
    } catch (error) {
        console.error('Error setting short creator:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export interface OwnedVideoPublishedRecently {
    video_id: string;
    owned_channel_id: number;
    filming_date: string | null;
    ctr_first_24h: Record<string, any> | null;
  }

  const PUBLISHED_LOOKBACK_HOURS = 24;

  // owned_channels ids we automate thumbnail handling for. Anything not listed here is left alone,
  // so widening the automation is a matter of adding the channel id.
  export const PERMITTED_CHANNELS = [1, 2, 3, 45, 46];

  export const getOwnedVideosPublishedLast24Hours = async (): Promise<OwnedVideoPublishedRecently[]> => {
    const client = await pool.connect();
    try {
      const query = `SELECT ow.video_id, ow.owned_channel_id, ow.filming_date, ow.ctr_first_24h
                     FROM owned_videos ow
                     INNER JOIN videos v
                        ON ow.video_id = v.video_id
                     WHERE ow.owned_channel_id = ANY($1::int[])
                     AND v.publish_date >= NOW() - MAKE_INTERVAL(hours => ${PUBLISHED_LOOKBACK_HOURS})
                     -- duration is a numeric string like "123", but can also be ISO 8601
                     -- like "PT39M16S" - fall back to duration_seconds in that case
                     AND (CASE WHEN v.duration ~ '^[0-9]+$' THEN v.duration::integer ELSE v.duration_seconds END) > 180`;
      const result = await client.query(query, [PERMITTED_CHANNELS]);
      return result.rows;
    } catch (error) {
        console.error('Error fetching owned videos published in the last 24 hours:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export interface ThumbnailCtrEntry {
    ctr: number;
    timestamp: string;
  }

  export interface Thumbnail {
    id: number;
    video_id: string;
    url: string;
    ctrs: ThumbnailCtrEntry[] | null;
    currently_published: boolean;
    // When this thumbnail was last put live on youtube. NULL for rows published before the
    // column existed. Only meaningful as "the current publication started then" while
    // currently_published is true.
    published_at: Date | null;
  }

  export const getThumbnailUrlsForVideo = async (videoId: string): Promise<string[]> => {
    const client = await pool.connect();
    try {
        const query = `SELECT url FROM thumbnails WHERE video_id = $1 AND url IS NOT NULL`;
        const result = await client.query(query, [videoId]);
        return result.rows.map(row => row.url);
    } catch (error) {
        console.error('Error getting thumbnail urls for video:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Ordered by id, which is the order the thumbnails were added and therefore the rotation order.
  export const getThumbnailsForVideo = async (videoId: string): Promise<Thumbnail[]> => {
    const client = await pool.connect();
    try {
        // published_at is a `timestamp without time zone` holding utc, so node-pg would
        // otherwise read it back as a local-time Date and shift the instant by the box's
        // offset. The AT TIME ZONE cast makes it a timestamptz, which parses as the real
        // instant no matter where this runs.
        const query = `SELECT id, video_id, url, ctrs, currently_published,
                              (published_at AT TIME ZONE 'UTC') AS published_at
                       FROM thumbnails
                       WHERE video_id = $1 AND url IS NOT NULL
                       ORDER BY id`;
        const result = await client.query(query, [videoId]);
        return result.rows;
    } catch (error) {
        console.error('Error getting thumbnails for video:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export const addThumbnailsToVideo = async (videoId: string, thumbnails: string[]): Promise<void> => {
    const client = await pool.connect();
    try {
        const query = `INSERT INTO thumbnails(video_id, url) VALUES ($1, $2)
                       ON CONFLICT (video_id, url) DO NOTHING`;
        for (const thumbnail of thumbnails) {
            await client.query(query, [videoId, thumbnail]);
        }
    } catch (error) {
        console.error('Error adding thumbnails to video:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export interface YoutubeAuthParams {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    access_token: string | null;
    channel_id: string | null;
  }

  export const getYoutubeAuthParamsForChannel = async (ownedChannelId: number): Promise<YoutubeAuthParams | null> => {
    const client = await pool.connect();
    try {
        const query = `SELECT client_id, client_secret, refresh_token, access_token, channel_id
                       FROM youtube_analytics_params
                       WHERE owned_channels_id = $1
                       AND client_id IS NOT NULL
                       AND client_secret IS NOT NULL
                       AND refresh_token IS NOT NULL
                       LIMIT 1`;
        const result = await client.query(query, [ownedChannelId]);
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
        console.error('Error getting youtube auth params for channel:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Appends {ctr, timestamp} to the thumbnail's ctrs jsonb array, treating NULL as an empty array.
  export const updateThumbnailCtr = async (thumbnailId:number, ctr:number): Promise<void> => {
    const client = await pool.connect();
    try {
        const entry = { ctr, timestamp: new Date().toISOString() };
        const query = `UPDATE thumbnails
                       SET ctrs = COALESCE(ctrs, '[]'::jsonb) || $1::jsonb
                       WHERE id = $2`;
        await client.query(query, [JSON.stringify([entry]), thumbnailId]);
    } catch (error) {
        console.error('Error updating thumbnail ctr:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Marks one thumbnail as the published one and clears the flag on every other thumbnail of that
  // video. published_at starts the clock the rotation waits on, so it is stamped here and left
  // untouched on the others, where it keeps reading as the last time they were live.
  export const setThumbnailAsPublished = async (thumbnailId:number, videoId:string): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `UPDATE thumbnails SET currently_published = false WHERE video_id = $1 AND id != $2`;
        await client.query(query, [videoId, thumbnailId]);
        // NOW() is a timestamptz; the cast stores it as utc to match how it is read back.
        const query2 = `UPDATE thumbnails
                        SET currently_published = true, published_at = (NOW() AT TIME ZONE 'UTC')
                        WHERE id = $1`;
        await client.query(query2, [thumbnailId]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error setting thumbnail as published:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export interface VideoDescriptionSegment {
    title: string;
    segment_type: string;
    description: string;
    key_topics: string[];
    // Whole seconds from the start of the video. The prompt keeps playback
    // positions out of the prose so the embedded text stays clean, and asks for
    // them here instead.
    start_time?: number | null;
    // One analysis call produces every segment of a video, so its cost is split
    // evenly across them. That keeps SUM(estimated_cost) equal to what was
    // actually spent, whether summed per video or across the whole table.
    estimated_cost?: number | null;
  }

  // Replaces a video's description segments. video_description has no uniqueness
  // on video_id, so without the delete a re-run would quietly leave a second set
  // of segments sitting alongside the first.
  export const setVideoDescriptionSegments = async (videoId: string, segments: VideoDescriptionSegment[]): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM video_description WHERE video_id = $1', [videoId]);

        if (segments.length > 0) {
          const COLUMNS_PER_ROW = 7;
          const values: unknown[] = [];
          const rows = segments.map((segment, index) => {
            const offset = index * COLUMNS_PER_ROW;
            values.push(
              segment.title,
              segment.segment_type,
              segment.start_time ?? null,
              segment.description,
              // key_topics is a text column rather than text[], so the list is stored comma separated.
              segment.key_topics.join(', '),
              videoId,
              segment.estimated_cost ?? null,
            );
            return `(${Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${offset + i + 1}`).join(', ')})`;
          });

          // id is GENERATED ALWAYS AS IDENTITY, so it is left out of the column list.
          const query = `INSERT INTO video_description (title, segment_type, start_time, description, key_topics, video_id, estimated_cost)
                         VALUES ${rows.join(', ')}`;
          await client.query(query, values);
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error setting video description segments:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // segment_type of the marker row written for a video that cannot be described.
  // Every consumer reading descriptions to embed them must exclude this value.
  export const FAILED_SEGMENT_TYPE = 'Failed';

  export interface VideoToDescribe {
    video_id: string;
    // Null only for the two rows in the whole table whose duration is not numeric.
    duration_seconds: number | null;
    publish_date: Date | null;
    channel_title: string | null;
  }

  // Newest videos in a project that have no video_description rows yet. A video that
  // failed permanently has a marker row, so it is excluded here too and will not be
  // retried until the marker is cleared.
  //
  // `publishedSinceHours` narrows this to recent uploads for the daily job; left out,
  // it walks the whole back catalogue for the backfill. Note the window is on
  // publish_date, because the videos table records no date on which a row was added —
  // so a channel newly joined to a project brings a back catalogue the daily job will
  // never see. The backfill is what picks those up.
  export const findVideosWithoutDescriptions = async (
    projectName: string,
    limit: number,
    options: { maxDurationSeconds?: number; publishedSinceHours?: number } = {},
  ): Promise<VideoToDescribe[]> => {
    const { maxDurationSeconds = 3600, publishedSinceHours } = options;
    const client = await pool.connect();
    try {
        // videos.duration_seconds is not populated; videos.duration holds whole
        // seconds as a varchar. The CASE guards the cast rather than relying on a
        // regex in the WHERE clause, because Postgres does not promise to evaluate
        // predicates in written order and two rows are not numeric.
        const query = `SELECT v.video_id,
                              (CASE WHEN v.duration ~ '^[0-9]+$' THEN v.duration::int END) AS duration_seconds,
                              v.publish_date,
                              c.title AS channel_title
                       FROM videos v
                       JOIN project_channel_junction pcj ON pcj.channel_id = v.channel_id
                       JOIN projects p ON p.id = pcj.project_id
                       LEFT JOIN channels c ON c.channel_id = v.channel_id
                       WHERE lower(p.name) = lower($1)
                         AND (CASE WHEN v.duration ~ '^[0-9]+$' THEN v.duration::int END) < $3
                         AND ($4::int IS NULL OR v.publish_date >= now() - make_interval(hours => $4::int))
                         AND NOT EXISTS (SELECT 1 FROM video_description d WHERE d.video_id = v.video_id)
                       ORDER BY v.publish_date DESC NULLS LAST
                       LIMIT $2`;
        const result = await client.query(query, [projectName, limit, maxDurationSeconds, publishedSinceHours ?? null]);
        return result.rows;
    } catch (error) {
        console.error('Error finding videos without descriptions:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Whole seconds of runtime, or null when the stored value is not numeric. Used to
  // tell the describing model how long the video is, since left to itself it will
  // sometimes place a segment past the end.
  export const getVideoDurationSeconds = async (videoId: string): Promise<number | null> => {
    const client = await pool.connect();
    try {
        const query = `SELECT (CASE WHEN duration ~ '^[0-9]+$' THEN duration::int END) AS duration_seconds
                       FROM videos WHERE video_id = $1`;
        const result = await client.query(query, [videoId]);
        return result.rows[0]?.duration_seconds ?? null;
    } catch (error) {
        console.error('Error getting video duration:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Records a video that cannot be described, so later runs skip it instead of paying
  // for the same failure again. Only for errors that will not improve on a retry —
  // see the caller, which leaves rate limits and timeouts unmarked.
  export const markVideoDescriptionFailed = async (
    videoId: string,
    reason: string,
    estimatedCost?: number | null,
  ): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM video_description WHERE video_id = $1', [videoId]);
        const query = `INSERT INTO video_description (title, segment_type, description, video_id, estimated_cost)
                       VALUES (NULL, $1, $2, $3, $4)`;
        await client.query(query, [FAILED_SEGMENT_TYPE, reason, videoId, estimatedCost ?? null]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error marking video description as failed:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Drops every failure marker so those videos are picked up again. Returns how many
  // were cleared.
  export const clearVideoDescriptionFailures = async (): Promise<number> => {
    const client = await pool.connect();
    try {
        const result = await client.query('DELETE FROM video_description WHERE segment_type = $1', [FAILED_SEGMENT_TYPE]);
        return result.rowCount ?? 0;
    } catch (error) {
        console.error('Error clearing video description failures:', error);
        throw error;
    } finally {
        client.release();
    }
  }
  // ===========================================================================
  // YouTube Reporting API imports (analytics_report and friends)
  // ===========================================================================
  // DDL lives in sql/analytics_report.sql and is applied by hand to both the public and
  // dev schemas - this repo has no migration runner.

  export interface YoutubeAnalyticsParamsRow extends YoutubeAuthParams {
    owned_channels_id: number;
    channel_name: string | null;
  }

  // Every channel we hold usable credentials for. Driven off youtube_analytics_params
  // rather than owned_channels on purpose: three owned_channels rows (wprofile, flocal,
  // TC Spanish) have a null channel_id and no credentials, and must never be visited.
  export const getAllYoutubeAnalyticsParams = async (): Promise<YoutubeAnalyticsParamsRow[]> => {
    const client = await pool.connect();
    try {
        const query = `SELECT owned_channels_id, channel_name, client_id, client_secret,
                              refresh_token, access_token, channel_id
                       FROM youtube_analytics_params
                       WHERE client_id IS NOT NULL
                         AND client_secret IS NOT NULL
                         AND refresh_token IS NOT NULL
                       ORDER BY owned_channels_id`;
        const result = await client.query(query);
        return result.rows;
    } catch (error) {
        console.error('Error getting all youtube analytics params:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // video_id -> owned_videos.id, used to attribute report rows. Loaded once per channel
  // per run rather than queried per row.
  export const getOwnedVideoIdsForChannel = async (ownedChannelId: number): Promise<Map<string, number>> => {
    const client = await pool.connect();
    try {
        const result = await client.query(
          `SELECT id, video_id FROM owned_videos WHERE owned_channel_id = $1 AND video_id IS NOT NULL`,
          [ownedChannelId],
        );
        return new Map(result.rows.map(row => [row.video_id as string, row.id as number]));
    } catch (error) {
        console.error('Error loading owned video ids for channel:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // The shorts equivalent. Shorts are not in owned_videos, so without this every short
  // in a report would be discarded as an unknown video.
  export const getOwnedShortIdsForChannel = async (ownedChannelId: number): Promise<Map<string, number>> => {
    const client = await pool.connect();
    try {
        const result = await client.query(
          `SELECT id, video_id FROM owned_shorts WHERE owned_channel_id = $1 AND video_id IS NOT NULL`,
          [ownedChannelId],
        );
        return new Map(result.rows.map(row => [row.video_id as string, row.id as number]));
    } catch (error) {
        console.error('Error loading owned short ids for channel:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export interface AnalyticsReportJob {
    owned_channels_id: number;
    report_type_id: string;
    job_id: string;
    job_name: string | null;
    job_create_time: Date | null;
  }

  export const getAnalyticsReportJob = async (
    ownedChannelsId: number,
    reportTypeId: string,
  ): Promise<AnalyticsReportJob | null> => {
    const client = await pool.connect();
    try {
        const result = await client.query(
          `SELECT owned_channels_id, report_type_id, job_id, job_name, job_create_time
             FROM analytics_report_jobs
            WHERE owned_channels_id = $1 AND report_type_id = $2`,
          [ownedChannelsId, reportTypeId],
        );
        return result.rows[0] ?? null;
    } catch (error) {
        console.error('Error getting analytics report job:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export const upsertAnalyticsReportJob = async (job: AnalyticsReportJob): Promise<void> => {
    const client = await pool.connect();
    try {
        // Conflict on the channel/type pair rather than on job_id: re-binding a channel
        // to a different youtube job is a legitimate update, whereas two channels
        // claiming one job is the thing the job_id unique constraint rejects.
        await client.query(
          `INSERT INTO analytics_report_jobs
             (owned_channels_id, report_type_id, job_id, job_name, job_create_time, last_polled_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (owned_channels_id, report_type_id) DO UPDATE
              SET job_id = EXCLUDED.job_id,
                  job_name = EXCLUDED.job_name,
                  job_create_time = EXCLUDED.job_create_time,
                  last_polled_at = now()`,
          [job.owned_channels_id, job.report_type_id, job.job_id, job.job_name, job.job_create_time],
        );
    } catch (error) {
        console.error('Error upserting analytics report job:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export const touchAnalyticsReportJobPolled = async (jobId: string): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query(`UPDATE analytics_report_jobs SET last_polled_at = now() WHERE job_id = $1`, [jobId]);
    } catch (error) {
        console.error('Error updating analytics report job poll time:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // The import cursor. Reports already in this table are filtered out of every poll,
  // which is what makes a per-run download cap safe - see sql/analytics_report.sql.
  export const getImportedReportIds = async (jobId: string): Promise<Set<string>> => {
    const client = await pool.connect();
    try {
        const result = await client.query(
          `SELECT report_id FROM analytics_report_imports WHERE job_id = $1`,
          [jobId],
        );
        return new Set(result.rows.map(row => row.report_id as string));
    } catch (error) {
        console.error('Error loading imported report ids:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export const getImportCursor = async (jobId: string): Promise<Date | null> => {
    const client = await pool.connect();
    try {
        const result = await client.query(
          `SELECT MAX(create_time) AS cursor FROM analytics_report_imports WHERE job_id = $1`,
          [jobId],
        );
        return result.rows[0]?.cursor ?? null;
    } catch (error) {
        console.error('Error loading analytics import cursor:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Records a report we deliberately did not import because a newer report covers the
  // same day. Without the ledger row it would be re-listed and re-considered every run.
  export const ledgerSupersededReport = async (entry: {
    reportId: string;
    jobId: string;
    ownedChannelsId: number;
    reportTypeId: string;
    reportDate: string;
    createTime: string;
  }): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query(
          `INSERT INTO analytics_report_imports
             (report_id, job_id, owned_channels_id, report_type_id, report_date, create_time,
              rows_written, rows_skipped, superseded)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 0, true)
           ON CONFLICT (report_id) DO NOTHING`,
          [entry.reportId, entry.jobId, entry.ownedChannelsId, entry.reportTypeId,
           entry.reportDate, entry.createTime],
        );
    } catch (error) {
        console.error('Error recording superseded report:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  // Startup guard: the DDL is applied by hand, so a deployment can easily be pointed at
  // a schema that never got it.
  export const analyticsReportTablesExist = async (): Promise<boolean> => {
    const client = await pool.connect();
    try {
        const result = await client.query(
          `SELECT to_regclass('analytics_report')          AS videos,
                  to_regclass('analytics_report_shorts')   AS shorts,
                  to_regclass('analytics_report_channel')  AS channel,
                  to_regclass('analytics_report_jobs')     AS jobs,
                  to_regclass('analytics_report_imports')  AS imports`,
        );
        const row = result.rows[0] ?? {};
        return Object.values(row).every(value => value !== null);
    } catch (error) {
        console.error('Error checking for the analytics report tables:', error);
        throw error;
    } finally {
        client.release();
    }
  }

  export type AnalyticsReportSource = 'basic' | 'reach';
  export type AnalyticsReportTarget = 'video' | 'short' | 'channel';

  // Columns each report type owns, per target table. These lists are the single source
  // of truth for the upsert, for the clearing pass and for which CSV columns the
  // controller is allowed to aggregate - a column missing here is a column that never
  // reaches the database.
  const BASIC_COLUMNS = [
    'views', 'engaged_views', 'watch_time_minutes',
    'average_view_duration_seconds', 'average_view_duration_percentage',
    'likes', 'dislikes', 'comments', 'shares',
    'videos_added_to_playlists', 'videos_removed_from_playlists',
    'subscribers_gained', 'subscribers_lost',
    'red_views', 'red_watch_time_minutes',
  ] as const;

  const REACH_COLUMNS = ['thumbnail_impressions', 'impressions_ctr'] as const;

  // The channel table carries no average_view_duration_* (those are views-weighted
  // within one video, and the weighting is invalid across videos of differing length)
  // and no playlist columns (they are per-video actions).
  const BASIC_CHANNEL_COLUMNS = [
    'views', 'engaged_views', 'watch_time_minutes',
    'likes', 'dislikes', 'comments', 'shares',
    'subscribers_gained', 'subscribers_lost',
    'red_views', 'red_watch_time_minutes',
  ] as const;

  const REACH_CHANNEL_COLUMNS = ['thumbnail_impressions'] as const;

  // Every report type's provenance column, in one place. The reaper below deletes a row
  // once all of them are null, so adding a third report type means adding it here and
  // nowhere else - which is the whole reason this is a constant rather than a literal.
  const PROVENANCE_COLUMNS = ['basic_report_id', 'reach_report_id'] as const;

  interface TargetConfig {
    table: string;
    keyColumns: string[];
    // Key columns that are NOT part of the conflict target, and so can be refreshed on
    // a conflicting write.
    updatableKeyColumns: string[];
    conflictTarget: string;
    // Scopes a statement to one channel. `$$SCOPE$$` is replaced with the real
    // placeholder number, because it lands in different positions in different queries.
    channelScope: string;
  }

  const TARGET_CONFIG: Record<AnalyticsReportTarget, TargetConfig> = {
    video: {
      table: 'analytics_report',
      keyColumns: ['owned_video_id', 'video_id', 'date'],
      updatableKeyColumns: ['owned_video_id'],
      conflictTarget: '(video_id, date)',
      channelScope: 'owned_video_id IN (SELECT id FROM owned_videos WHERE owned_channel_id = $$SCOPE$$)',
    },
    short: {
      table: 'analytics_report_shorts',
      keyColumns: ['owned_short_id', 'video_id', 'date'],
      updatableKeyColumns: ['owned_short_id'],
      conflictTarget: '(video_id, date)',
      channelScope: 'owned_short_id IN (SELECT id FROM owned_shorts WHERE owned_channel_id = $$SCOPE$$)',
    },
    channel: {
      table: 'analytics_report_channel',
      keyColumns: ['owned_channels_id', 'date'],
      updatableKeyColumns: [],
      conflictTarget: '(owned_channels_id, date)',
      channelScope: 'owned_channels_id = $$SCOPE$$',
    },
  };

  export const analyticsColumnsFor = (target: AnalyticsReportTarget, source: AnalyticsReportSource): string[] => {
    if (target === 'channel') {
      return [...(source === 'basic' ? BASIC_CHANNEL_COLUMNS : REACH_CHANNEL_COLUMNS)];
    }
    return [...(source === 'basic' ? BASIC_COLUMNS : REACH_COLUMNS)];
  }

  export interface AnalyticsImportRow {
    // owned_videos.id, owned_shorts.id or owned_channels.id, matching the target.
    entityId: number;
    // Absent for the channel target, whose rows belong to no single video.
    videoId?: string;
    date: string;
    metrics: Record<string, number | null>;
  }

  // Keeps a single INSERT well inside Postgres' 65535 parameter cap. The ceiling is
  // derived rather than hard-coded, so a wider column set degrades the chunk size
  // instead of failing with an opaque "bind message supplies N parameters".
  const MAX_CHUNK_ROWS = 500;
  const MAX_CHUNK_PARAMETERS = 60_000;

  /**
   * Imports one downloaded report, atomically.
   *
   * Everything for the report happens in one transaction: the upserts into all three
   * target tables, the clearing of data this report supersedes, the reaping of rows left
   * with no source, and the ledger row that records the report as imported. Because the
   * ledger is written here rather than afterwards, there is no state in which the data
   * landed but the cursor did not - a crash simply means the report is downloaded again,
   * which is harmless.
   *
   * `reportDates` comes from the report's own startTime/endTime metadata, never from the
   * parsed rows. That matters for a replacement report covering a day that turned out to
   * have no activity: its body is a header row and nothing else, so dates derived from
   * the body would be empty, clear nothing, and leave the superseded figures standing.
   */
  export const importAnalyticsReport = async (args: {
    source: AnalyticsReportSource;
    reportTypeId: string;
    ownedChannelId: number;
    jobId: string;
    report: { id: string; createTime: string };
    reportDates: string[];
    rowsByTarget: Record<AnalyticsReportTarget, AnalyticsImportRow[]>;
    rowsSkipped: number;
  }): Promise<number> => {
    const { source, reportTypeId, ownedChannelId, jobId, report, reportDates, rowsByTarget, rowsSkipped } = args;
    const reportIdColumn = `${source}_report_id`;
    const reportCreateTimeColumn = `${source}_report_create_time`;

    const client = await pool.connect();
    let rowsWritten = 0;
    try {
        await client.query('BEGIN');

        for (const target of Object.keys(TARGET_CONFIG) as AnalyticsReportTarget[]) {
          const config = TARGET_CONFIG[target];
          const metricColumns = analyticsColumnsFor(target, source);
          const rows = rowsByTarget[target] ?? [];

          // --- 1. Upsert this report's rows, in chunks. -------------------------------
          const insertColumns = [...config.keyColumns, ...metricColumns, reportIdColumn, reportCreateTimeColumn];
          const columnsPerRow = insertColumns.length;
          const chunkSize = Math.max(1, Math.min(MAX_CHUNK_ROWS, Math.floor(MAX_CHUNK_PARAMETERS / columnsPerRow)));
          const updateAssignments = [
            ...config.updatableKeyColumns.map(column => `${column} = EXCLUDED.${column}`),
            ...metricColumns.map(column => `${column} = EXCLUDED.${column}`),
            `${reportIdColumn} = EXCLUDED.${reportIdColumn}`,
            `${reportCreateTimeColumn} = EXCLUDED.${reportCreateTimeColumn}`,
            'last_update = now()',
          ].join(', ');

          for (let offset = 0; offset < rows.length; offset += chunkSize) {
            const chunk = rows.slice(offset, offset + chunkSize);
            const values: unknown[] = [];
            const tuples = chunk.map((row, index) => {
              const base = index * columnsPerRow;
              const keyValues = target === 'channel'
                ? [row.entityId, row.date]
                : [row.entityId, row.videoId, row.date];
              values.push(
                ...keyValues,
                ...metricColumns.map(column => row.metrics[column] ?? null),
                report.id,
                report.createTime,
              );
              // last_update is written as now() rather than passed as a parameter, so
              // each tuple is one column wider than columnsPerRow.
              const placeholders = Array.from({ length: columnsPerRow }, (_, i) => `$${base + i + 1}`);
              return `(${placeholders.join(', ')}, now())`;
            });

            // id is GENERATED ALWAYS AS IDENTITY, so it is left out of the column list.
            await client.query(
              `INSERT INTO ${config.table} (${insertColumns.join(', ')}, last_update)
               VALUES ${tuples.join(', ')}
               ON CONFLICT ${config.conflictTarget} DO UPDATE SET ${updateAssignments}`,
              values,
            );
            rowsWritten += chunk.length;
          }

          // --- 2. Clear what this report supersedes. ----------------------------------
          // Step 1 stamped this report's id onto every row it touched, so anything for
          // these days still carrying a different id is a row the new report no longer
          // mentions. Running this *after* the upsert rather than before halves the row
          // versions written: a pre-clear would rewrite every row twice.
          //
          // The provenance columns have to be nulled alongside the metrics, or step 3's
          // predicate can never fire and the reaper becomes dead code.
          const clearAssignments = [
            ...metricColumns.map(column => `${column} = NULL`),
            `${reportIdColumn} = NULL`,
            `${reportCreateTimeColumn} = NULL`,
          ].join(', ');
          await client.query(
            `UPDATE ${config.table}
                SET ${clearAssignments}
              WHERE date = ANY($1::date[])
                AND ${config.channelScope.replace('$$SCOPE$$', '$2')}
                AND ${reportIdColumn} IS DISTINCT FROM $3`,
            [reportDates, ownedChannelId, report.id],
          );

          // --- 3. Reap rows that now have no source at all. ---------------------------
          await client.query(
            `DELETE FROM ${config.table}
              WHERE date = ANY($1::date[])
                AND ${config.channelScope.replace('$$SCOPE$$', '$2')}
                AND ${PROVENANCE_COLUMNS.map(column => `${column} IS NULL`).join(' AND ')}`,
            [reportDates, ownedChannelId],
          );
        }

        // --- 4. Ledger the report, in the same transaction as its data. ---------------
        await client.query(
          `INSERT INTO analytics_report_imports
             (report_id, job_id, owned_channels_id, report_type_id, report_date, create_time,
              rows_written, rows_skipped, superseded)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
           ON CONFLICT (report_id) DO UPDATE
              SET rows_written = EXCLUDED.rows_written,
                  rows_skipped = EXCLUDED.rows_skipped,
                  superseded = false,
                  imported_at = now()`,
          [report.id, jobId, ownedChannelId, reportTypeId, reportDates[0] ?? null,
           report.createTime, rowsWritten, rowsSkipped],
        );

        await client.query('COMMIT');
        return rowsWritten;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error importing analytics report ${report.id} (${reportTypeId}, channel ${ownedChannelId}):`, error);
        throw error;
    } finally {
        client.release();
    }
  }
