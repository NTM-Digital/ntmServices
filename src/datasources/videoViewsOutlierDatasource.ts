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
        this.listenToDbChanges().catch(err => {
            console.error("Failed to set up database listener", err);
        });
    }

    async getMedianViewsFromVideos(channelIds?: string[]): Promise<ChannelMedianViews[]> {
        const client = await this.pool.connect();
        try{
            const channelFilter = channelIds && channelIds.length > 0
                ? `WHERE pcj.channel_id = ANY($1)`
                : '';

            const query =`
            WITH channel_project_settings AS (
                -- Get unique settings per channel (if a channel is in multiple projects, pick one consistently)
                SELECT DISTINCT ON (pcj.channel_id)
                    pcj.channel_id,
                    p.low_performer_cutoff_prcnt,
                    p.publication_cutoff_months
                FROM project_channel_junction pcj
                JOIN projects p ON pcj.project_id = p.id
                ${channelFilter}
                ORDER BY pcj.channel_id, p.id
            ),
            per_channel_floor AS (
                SELECT
                    cps.channel_id,
                    cps.low_performer_cutoff_prcnt,
                    cps.publication_cutoff_months,
                    -- floor for "low performers" using dynamic cutoff percentage (divide by 100 to convert percentage to decimal)
                    percentile_cont(cps.low_performer_cutoff_prcnt / 100.0) WITHIN GROUP (ORDER BY v.views_first_24h) FILTER (
                    WHERE v.publish_date <= now() - interval '1 day'
                        AND v.publish_date >= now() - (cps.publication_cutoff_months || ' months')::interval
                        AND v.views_first_24h IS NOT NULL
                        AND v.views_first_24h > 0
                    ) AS floor_24h,
                    percentile_cont(cps.low_performer_cutoff_prcnt / 100.0) WITHIN GROUP (ORDER BY v.views_first_week) FILTER (
                    WHERE v.publish_date <= now() - interval '7 days'
                        AND v.publish_date >= now() - (cps.publication_cutoff_months || ' months')::interval
                        AND v.views_first_week IS NOT NULL
                        AND v.views_first_week > 0
                    ) AS floor_week
                FROM channel_project_settings cps
                JOIN videos v ON v.channel_id = cps.channel_id
                GROUP BY cps.channel_id, cps.low_performer_cutoff_prcnt, cps.publication_cutoff_months
                )
                SELECT
                v.channel_id,

                percentile_cont(0.5) WITHIN GROUP (ORDER BY v.views_first_24h) FILTER (
                    WHERE v.publish_date <= now() - interval '1 day'
                    AND v.publish_date >= now() - (f.publication_cutoff_months || ' months')::interval
                    AND v.views_first_24h IS NOT NULL
                    AND v.views_first_24h > 0
                    AND v.views_first_24h >= f.floor_24h
                ) AS median_first_24h,

                percentile_cont(0.5) WITHIN GROUP (ORDER BY v.views_first_week) FILTER (
                    WHERE v.publish_date <= now() - interval '7 days'
                    AND v.publish_date >= now() - (f.publication_cutoff_months || ' months')::interval
                    AND v.views_first_week IS NOT NULL
                    AND v.views_first_week > 0
                    AND v.views_first_week >= f.floor_week
                ) AS median_first_week,

                percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY (v.views_first_week::float / NULLIF(v.views_first_24h, 0))
                ) FILTER (
                    WHERE v.publish_date <= now() - interval '7 days'
                    AND v.publish_date >= now() - (f.publication_cutoff_months || ' months')::interval
                    AND v.views_first_24h > 0
                    AND v.views_first_week > 0
                    AND v.views_first_24h >= f.floor_24h
                    AND v.views_first_week >= f.floor_week
                ) AS median_trajectory,

                percentile_cont(0.9) WITHIN GROUP (
                    ORDER BY (v.views_first_week::float / NULLIF(v.views_first_24h, 0))
                ) FILTER (
                    WHERE v.publish_date <= now() - interval '7 days'
                    AND v.publish_date >= now() - (f.publication_cutoff_months || ' months')::interval
                    AND v.views_first_24h > 0
                    AND v.views_first_week > 0
                    AND v.views_first_24h >= f.floor_24h
                    AND v.views_first_week >= f.floor_week
                ) AS p90_trajectory

                FROM videos v
                JOIN per_channel_floor f ON v.channel_id = f.channel_id
                GROUP BY v.channel_id;`

            const result = channelIds && channelIds.length > 0
                ? await client.query(query, [channelIds])
                : await client.query(query);

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
     * Calculates the growth factor for videos based on the average views of the last N days (from trend_starter_cutoff_days)
     * compared to the median views of the previous days (30 - trend_starter_cutoff_days).
     * The growth factor is set to NULL for videos that do not have a valid baseline median (less than 500 views) or if the recent average is not available.
     * growth_factor ~1 means the video is performing in line with its historical median, while a value >1 indicates faster growth and <1 indicates slower growth.
     */
    async setGrowthFactor(){
        const client = await this.pool.connect();
        try {
            const query = `UPDATE videos v
                            SET growth_factor = sub.growth_factor
                            FROM (
                            WITH channel_project_settings AS (
                                SELECT DISTINCT ON (pcj.channel_id)
                                    pcj.channel_id,
                                    p.trend_starter_cutoff_days
                                FROM project_channel_junction pcj
                                JOIN projects p ON pcj.project_id = p.id
                                ORDER BY pcj.channel_id, p.id
                            ),
                            eligible AS (
                                SELECT
                                v.video_id,
                                v.channel_id,
                                v.views_snapshots_last_30_days,
                                cps.trend_starter_cutoff_days
                                FROM videos v
                                JOIN channel_project_settings cps ON v.channel_id = cps.channel_id
                                WHERE jsonb_typeof(v.views_snapshots_last_30_days) = 'array'
                                AND jsonb_array_length(v.views_snapshots_last_30_days) = 30
                            ),

                            expanded AS (
                                SELECT
                                e.video_id,
                                e.trend_starter_cutoff_days,
                                (j->>'date')::date     AS d,
                                (j->>'views')::numeric AS views
                                FROM eligible e
                                CROSS JOIN LATERAL jsonb_array_elements(e.views_snapshots_last_30_days) AS j
                            ),

                            stats AS (
                                SELECT
                                video_id,

                                -- last N days average (using trend_starter_cutoff_days)
                                AVG(views) FILTER (
                                    WHERE d >= current_date - (trend_starter_cutoff_days - 1)
                                ) AS recent_avg,

                                -- baseline median: last 30 days excluding the recent trend_starter_cutoff_days
                                percentile_cont(0.5) WITHIN GROUP (ORDER BY views) FILTER (
                                    WHERE d >= current_date - 30
                                    AND d <  current_date - (trend_starter_cutoff_days - 1)
                                    AND views > 0
                                ) AS baseline_median

                                FROM expanded
                                GROUP BY video_id
                            )

                            SELECT
                                video_id,
                                CASE
                                WHEN baseline_median IS NULL OR baseline_median < 500 THEN NULL
                                WHEN recent_avg IS NULL THEN NULL
                                ELSE (recent_avg / baseline_median)::double precision
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
    /**
     * Calculates video performance as the ratio of views in the last 24 hours to the p20-logarithmic average views in the last 24 hours for the channel, and similarly for shorts. 
     * This allows us to identify videos that are outperforming or underperforming compared to the channel's typical performance. Videos with a performance ratio significantly above 1 are considered strong performers, while those significantly below 1 may be underperforming. The method updates the video_performance field for videos and shorts that have valid views data and a corresponding median for their channel.
     */
    async calculateVideoPerformance() {
        const client = await this.pool.connect();
        try{
            await client.query('BEGIN');
            const channelsQuery = `SELECT DISTINCT channel_id, average_views_last_24h, average_short_views_last_24h FROM channels`;
            const channelsResult = await client.query(channelsQuery);
            const channels = channelsResult.rows;

            for (const channel of channels) {
                const { channel_id, average_views_last_24h, average_short_views_last_24h } = channel;
                //update video performances
                if (average_views_last_24h === 0) {
                    continue; // Skip if we don't have enough data to calculate performance
                }
                const performanceQuery = `UPDATE videos
                SET video_performance = views_last_24h_sum::double precision / $1 
                WHERE channel_id = $2
                AND views_last_24h_sum IS NOT NULL
                AND views_last_24h_sum > 0`;
                await client.query(performanceQuery, [average_views_last_24h, channel_id]);
                //update short video performances
                if (average_short_views_last_24h === 0) {
                    continue; // Skip if we don't have enough data to calculate performance
                }
                const shortPerformanceQuery = `UPDATE shorts
                SET video_performance = views_last_24h::double precision / $1 
                WHERE channel_id = $2
                AND views_last_24h IS NOT NULL
                AND views_last_24h > 0`;
                await client.query(shortPerformanceQuery, [average_short_views_last_24h, channel_id]);
            }
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error('Error calculating video performance:', error);
            throw error;
        }
        finally {
            client.release();

        }
    }

    /**
     * Sets up a listener for changes to project settings in the database. When a change is detected, it triggers a reload of the project settings in the application.
     */
    private async listenToDbChanges(){
        const client = await this.pool.connect();
        await client.query("LISTEN projects_settings_changed");

        console.log("Listening for project config changes...");

        client.on("notification", async (msg) => {
        if (msg.channel !== "projects_settings_changed") return;

        try {
            const payload = JSON.parse(msg.payload || "{}");
            const projectId = payload.project_id;

            console.log("Project settings updated:", projectId);

            const channels = await this.getChannelsForProject(projectId);
            console.log(`Recalculating medians for ${channels.length} channels in project ${projectId}`);

            const medianData = await this.getMedianViewsFromVideos(channels);
            await this.setMedianViewsForChannels(medianData);

            console.log(`Successfully updated medians for ${medianData.length} channels`);

        } catch (err) {
            console.error("Failed to handle notification", err);
        }
        });
    }

    private async getChannelsForProject(projectId: string): Promise<string[]> {
    const client = await this.pool.connect();

    try {
        const query = `
            SELECT DISTINCT channel_id
            FROM (
                SELECT pcj.channel_id
                FROM project_channel_junction pcj
                WHERE pcj.project_id = $1

                UNION

                SELECT cpcj.channel_id
                FROM child_projects cp
                INNER JOIN child_project_channel_junction cpcj
                    ON cpcj.child_project_id = cp.id
                WHERE cp.parent_project_id = $1
            ) channels
        `;

        const result = await client.query(query, [projectId]);
        return result.rows.map(row => row.channel_id);
    } catch (error) {
        console.error('Error fetching channels for project and child projects:', error);
        throw error;
    } finally {
        client.release();
    }
}

}
export const videoViewsOutlierDatasource = new VideoViewsOutlierDatasource();