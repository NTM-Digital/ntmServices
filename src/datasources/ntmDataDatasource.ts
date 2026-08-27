  import pg  from 'pg';
  import dotenv from 'dotenv';

  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }

  const pool = new pg.Pool({
    connectionString: process.env.NTM_DATA_DATABASE_URL
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
        const query = `SELECT id, video_id, url, ctrs, currently_published
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

  // Marks one thumbnail as the published one and clears the flag on every other thumbnail of that video.
  export const setThumbnailAsPublished = async (thumbnailId:number, videoId:string): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `UPDATE thumbnails SET currently_published = false WHERE video_id = $1 AND id != $2`;
        await client.query(query, [videoId, thumbnailId]);
        const query2 = `UPDATE thumbnails SET currently_published = true WHERE id = $1`;
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