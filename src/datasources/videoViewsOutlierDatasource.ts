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
            WITH per_channel_floor AS (
                SELECT
                    channel_id,
                    -- floor for "low performers" (tune 0.2 -> 0.1/0.3 depending on strictness)
                    percentile_cont(0.2) WITHIN GROUP (ORDER BY views_first_24h) FILTER (
                    WHERE publish_date <= now() - interval '1 day'
                        AND views_first_24h IS NOT NULL
                        AND views_first_24h > 0
                    ) AS floor_24h,
                    percentile_cont(0.2) WITHIN GROUP (ORDER BY views_first_week) FILTER (
                    WHERE publish_date <= now() - interval '7 days'
                        AND views_first_week IS NOT NULL
                        AND views_first_week > 0
                    ) AS floor_week
                FROM videos
                GROUP BY channel_id
                )
                SELECT
                v.channel_id,

                percentile_cont(0.5) WITHIN GROUP (ORDER BY v.views_first_24h) FILTER (
                    WHERE v.publish_date <= now() - interval '1 day'
                    AND v.views_first_24h IS NOT NULL
                    AND v.views_first_24h > 0
                    AND v.views_first_24h >= f.floor_24h
                ) AS median_first_24h,

                percentile_cont(0.5) WITHIN GROUP (ORDER BY v.views_first_week) FILTER (
                    WHERE v.publish_date <= now() - interval '7 days'
                    AND v.views_first_week IS NOT NULL
                    AND v.views_first_week > 0
                    AND v.views_first_week >= f.floor_week
                ) AS median_first_week,

                percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY (v.views_first_week::float / NULLIF(v.views_first_24h, 0))
                ) FILTER (
                    WHERE v.publish_date <= now() - interval '7 days'
                    AND v.views_first_24h > 0
                    AND v.views_first_week > 0
                    AND v.views_first_24h >= f.floor_24h
                    AND v.views_first_week >= f.floor_week
                ) AS median_trajectory,

                percentile_cont(0.9) WITHIN GROUP (
                    ORDER BY (v.views_first_week::float / NULLIF(v.views_first_24h, 0))
                ) FILTER (
                    WHERE v.publish_date <= now() - interval '7 days'
                    AND v.views_first_24h > 0
                    AND v.views_first_week > 0
                    AND v.views_first_24h >= f.floor_24h
                    AND v.views_first_week >= f.floor_week
                ) AS p90_trajectory

                FROM videos v
                JOIN per_channel_floor f USING (channel_id)
                GROUP BY v.channel_id;`
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
                    Math.round(item.median_first_24h),
                    Math.round(item.median_first_week),
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
    /**
     * 
     * Calculates the trajectory for videos as the ratio of views in the first week to views in the first 24 hours.
     * This method updates the trajectory field for videos that were published at least 7 days ago and have valid views data.
     * Trajectory is set to NULL for videos that do not have valid views in the first 24 hours to avoid division by zero or misleading ratios.
     * A bigger trajectory value indicates that the video continued to gain views at a strong pace after the initial 24 hours, while a smaller value suggests that the video had a strong initial burst but did not maintain that momentum.
     */
    async setVideoTrajectory() {
        const client = await this.pool.connect();
        try {
            const query = `UPDATE videos
            SET trajectory = views_first_week::float / NULLIF(views_first_24h, 0)
            WHERE publish_date <= now() - interval '7 days'
            AND views_first_24h IS NOT NULL
            AND views_first_24h > 0
            AND trajectory IS NULL`;
            
            await client.query(query);
        } catch (error) {
            console.error('Error updating video trajectory:', error);
            throw error;
        } finally {
            client.release();
        }
    }
    /**
     * Calculates the growth factor for videos based on the average views of the last 3 days compared to the median views of the previous 27 days.
     * The growth factor is set to NULL for videos that do not have a valid baseline median (less than 500 views) or if the recent average is not available.
     * growth_factor ~1 means the video is performing in line with its historical median, while a value >1 indicates faster growth and <1 indicates slower growth.
     */
    async setGrowthFactor(){
        const client = await this.pool.connect();
        try {
            const query = `UPDATE videos v
                            SET growth_factor = sub.growth_factor
                            FROM (
                            WITH eligible AS (
                                SELECT
                                v.video_id,
                                v.views_snapshots_last_30_days
                                FROM videos v
                                WHERE jsonb_typeof(v.views_snapshots_last_30_days) = 'array'
                                AND jsonb_array_length(v.views_snapshots_last_30_days) = 30
                            ),

                            expanded AS (
                                SELECT
                                e.video_id,
                                (j->>'date')::date     AS d,
                                (j->>'views')::numeric AS views
                                FROM eligible e
                                CROSS JOIN LATERAL jsonb_array_elements(e.views_snapshots_last_30_days) AS j
                            ),

                            stats AS (
                                SELECT
                                video_id,

                                -- last 3 days average (today + previous 2)
                                AVG(views) FILTER (
                                    WHERE d >= current_date - 2
                                ) AS recent_avg_3d,

                                -- baseline median: last 30 days excluding the last 3 days
                                percentile_cont(0.5) WITHIN GROUP (ORDER BY views) FILTER (
                                    WHERE d >= current_date - 30
                                    AND d <  current_date - 2
                                    AND views > 0
                                ) AS baseline_median

                                FROM expanded
                                GROUP BY video_id
                            )

                            SELECT
                                video_id,
                                CASE
                                WHEN baseline_median IS NULL OR baseline_median < 500 THEN NULL
                                WHEN recent_avg_3d IS NULL THEN NULL
                                ELSE (recent_avg_3d / baseline_median)::double precision
                                END AS growth_factor
                            FROM stats
                            ) sub
                            WHERE v.video_id = sub.video_id`;
            
            await client.query(query);
        } catch (error) {
            console.error('Error updating video growth factor:', error);
            throw error;
        } finally {
            client.release();
        }
    }

}
export const videoViewsOutlierDatasource = new VideoViewsOutlierDatasource();