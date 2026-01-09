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

  export const setVideoCreator = async (videoId: string, dataUserId: number, owned_channel_id:number): Promise<void> => {
    const client = await pool.connect();
    try {
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