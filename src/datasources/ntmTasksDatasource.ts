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