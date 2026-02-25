  import pg  from 'pg';
  import dotenv from 'dotenv';

  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }

  export interface ChannelMedianViews {
    channel_id: string;
    median_first_24h: number;
    median_first_week: number;
    median_trajectory: number;
    p90_trajectory: number;
  }

class VideoViewsOutlierDatasource {
    private pool: pg.Pool;

    constructor() {
        this.pool = new pg.Pool({
            connectionString: process.env.NTM_DATA_DATABASE_URL
        });
    }

    async getMedianViewsFromVideos(): Promise<ChannelMedianViews[]> {
        const client = await this.pool.connect();
        try{
            const query =`
            SELECT 
                channel_id,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY views_first_24h) FILTER (
                    WHERE
                    publish_date <= now() - interval '1 day'
                    AND views_first_24h IS NOT NULL
                    AND views_first_24h > 0
                ) AS median_first_24h,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY views_first_week) 
                    FILTER (
                    WHERE
                        publish_date <= now() - interval '7 days'
                        AND views_first_week IS NOT NULL
                        AND views_first_week > 0
                    ) 
                AS median_first_week,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY (views_first_week::float / NULLIF(views_first_24h, 0))) 
                AS median_trajectory,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY (views_first_week::float / NULLIF(views_first_24h, 0))) 
                AS p90_trajectory
            FROM videos
            GROUP BY channel_id`
            const result = await client.query(query);
            return result.rows;
        }
        catch (error) {
            console.error('Error fetching median views:', error);
            throw error;
        }
        finally {
            client.release();
        }
    }

    async setMedianViewsForChannels(data: ChannelMedianViews[]) {
        const client = await this.pool.connect();
        try {
            const query = `UPDATE channels
            SET median_first_24h = $1,
                median_first_week = $2,
                median_trajectory = $3,
                p90_trajectory = $4
            WHERE channel_id = $5`;
            
            for (const item of data) {
                await client.query(query, [
                    item.median_first_24h,
                    item.median_first_week,
                    item.median_trajectory,
                    item.p90_trajectory,
                    item.channel_id
                ]);
            }
        } catch (error) {
            console.error('Error updating median views for channels:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}

export const videoViewsOutlierDatasource = new VideoViewsOutlierDatasource();