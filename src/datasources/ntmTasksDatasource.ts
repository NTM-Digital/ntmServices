  import pg  from 'pg';
  import dotenv from 'dotenv';

  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }

  const pool = new pg.Pool({
    connectionString: process.env.NTM_TASKS_DATABASE_URL
  });

  export const findVideoCreatorsAndFilmingDatesForVideos = async (videoIds:string[]) => {
    const client = await pool.connect();
    try {
      const query = `
        SELECT 
          "Video"."youtubeId" as video_id, 
          "User"."firstName" as name, 
          "Job"."filmingDate" as filming_date
        FROM "Video"
        JOIN "User" ON "Video"."userId" = "User".id
        JOIN "Job" ON "Video"."jobId" = "Job".id
        WHERE "Video"."youtubeId" = ANY($1::text[])
          AND "Video".status = 'Posted'
      `;
      const result = await client.query(query, [videoIds]);
      return result.rows;
    } catch (error) {
      console.error('Error finding video creators:', error);
      throw error;
    } finally {
      client.release();
    }
  };

  export interface ThumbnailRedo {
    images?: string[];
    timestamp?: string;
  }

  export interface ThumbnailInfo {
    images?: string[];
    // Usually an array of revisions, but a handful of jobs store a single bare object.
    redo?: ThumbnailRedo[] | ThumbnailRedo;
  }

  export interface VideoExtraInfo {
    thumbnail?: ThumbnailInfo;
  }

  export interface JobInfo {
    thumbnail?: ThumbnailInfo;
  }

  export interface VideoThumbnailSources {
    extraInfo: VideoExtraInfo | string | null;
    jobInfo: JobInfo | string | null;
  }

  // Both columns are jsonb, so pg hands back parsed objects; older rows may still hold a json string.
  // "Video"."extraInfo" is frequently NULL, in which case the thumbnails live on the job the video
  // was produced from, hence pulling both in one go.
  export const getGDriveThumbnailIdsForVIdeo = async (videoId:string): Promise<VideoThumbnailSources | null> => {
    const client = await pool.connect();
    try {
      const query = `SELECT v."extraInfo", j."jobInfo"
                     FROM "Video" v
                     LEFT JOIN "Job" j ON j.id = v."jobId"
                     WHERE v."youtubeId" = $1`;
      const result = await client.query(query, [videoId]);
      if (result.rows.length === 0) {
        return null;
      }
      return { extraInfo: result.rows[0].extraInfo, jobInfo: result.rows[0].jobInfo };
    } catch (error) {
      console.error('Error getting GDrive thumbnail IDs for video:', error);
      throw error;
    } finally {
      client.release();
    }
  };