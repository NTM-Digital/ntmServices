import {
  youtubeReportingDatasource,
  type ReportingReport,
  type ReportingErrorKind,
} from "../datasources/youtubeReportingDatasource.js";
import {
  getAllYoutubeAnalyticsParams,
  getOwnedVideoIdsForChannel,
  getOwnedShortIdsForChannel,
  getAnalyticsReportJob,
  upsertAnalyticsReportJob,
  touchAnalyticsReportJobPolled,
  getImportedReportIds,
  getImportCursor,
  ledgerSupersededReport,
  importAnalyticsReport,
  markTrailingReimportDone,
  analyticsColumnsFor,
  type AnalyticsImportRow,
  type AnalyticsReportSource,
  type AnalyticsReportTarget,
  type YoutubeAnalyticsParamsRow,
} from "../datasources/ntmDataDatasource.js";
import { discordController } from "./discordController.js";
import { isProduction } from "../lib/env.js";

// The two bulk report types we import, both verified present in reportTypes.list.
// channel_basic_a3 is video-level user activity; channel_reach_basic_a1 carries the
// thumbnail impressions and CTR, which no other report type exposes.
const REPORT_TYPES: { id: string; source: AnalyticsReportSource }[] = [
  { id: 'channel_basic_a3', source: 'basic' },
  { id: 'channel_reach_basic_a1', source: 'reach' },
];

// Shown in YouTube Studio's list of reporting jobs, so whoever finds it there can tell
// what created it.
const JOB_NAME_PREFIX = 'ntmservices';

// Same recipient the thumbnail rotation notifies.
const DISCORD_NOTIFY_USER_ID = '897201950544789576';

// A channel that cannot authenticate stays that way until a human re-consents it, and
// the loop comes back every six hours - so alerting on every failure would be about 52
// discord messages a day for the 13 channels currently missing the scope, which is the
// volume at which people mute the channel and stop seeing the real ones. One message per
// channel per failure kind per day keeps it visible instead.
//
// Held in memory, which means a restart re-alerts once for everything still broken. In
// production that is a useful startup summary. In development it is not: `npm run dev`
// is `tsx watch`, so every file save restarts the process, and because each service does
// its work before sleeping, every save triggers a full immediate pass - the interval
// only governs a process that stays up. That would be one message per broken channel per
// save, which is why the send below is gated on isProduction.
const FAILURE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Bounds a first run. A newly created job backfills 30 days, so 15 channels x 2 report
// types would otherwise attempt ~900 downloads in a single pass. This is only safe
// because the cap is applied to reports NOT already in the ledger - capping a list that
// still included imported reports would re-take the same ten every pass and never reach
// the eleventh.
const MAX_REPORTS_PER_JOB_PER_RUN = 10;

// createdAfter is exclusive and two reports can share a createTime, so the poll reaches
// back slightly past the cursor. Re-listing an already-imported report costs nothing,
// because the ledger filters it out before anything is downloaded.
const CURSOR_OVERLAP_MS = 60 * 60 * 1000;

// How far back to re-import unconditionally, ignoring the ledger, and how often.
//
// This is the only thing that recovers a day whose rows were dropped because
// owned_videos / owned_shorts had not caught up with youtube yet - a brand new upload,
// or a whole channel the crawler has not synced. Those rows are skipped and counted, but
// without this sweep the only way to get them back is deleting ledger rows by hand, and
// reports vanish 60 days after youtube generates them. The import is idempotent, so
// re-importing a day that was already correct costs a download and changes nothing.
const TRAILING_REIMPORT_DAYS = 7;
const TRAILING_REIMPORT_INTERVAL_MS = TRAILING_REIMPORT_DAYS * 24 * 60 * 60 * 1000;

// A sweep is 7-ish reports per job, and a basic report for a large channel is tens of
// thousands of rows - so letting all 30 jobs sweep in one pass would make that pass wildly
// more expensive than every other. Spreading it over several passes keeps any single pass
// predictable; with a 6 hour interval the whole estate is still swept well inside a day.
const MAX_TRAILING_JOBS_PER_RUN = 4;

// YouTube's analytics day runs midnight to midnight Pacific, so the day a report covers
// has to be derived in that zone rather than in UTC.
const REPORT_TIME_ZONE = 'America/Los_Angeles';

// Which CSV column feeds which database column, and how repeated dimension buckets are
// combined into one row.
//
// `sum` is exact: channel_basic_a3's dimensions (country_code x subscribed_status x
// live_or_on_demand) partition the events, so every view falls in exactly one bucket.
//
// `weighted` is for averages and rates. Summing an average is meaningless, and deriving
// view duration as watch_time / views is biased, because watch_time_minutes is reported
// per bucket at whole-minute granularity and a long-tail video's hundreds of tiny
// buckets each round toward zero. A weighted mean keeps the API's own precision.
//
// `weightBy` names the CSV column to weight by, and it is NOT always `views`:
// channel_reach_basic_a1 carries no views column at all, only
// video_thumbnail_impressions and its ctr. Weighting a ctr by impressions is also simply
// the right thing - a ctr is clicks over impressions. (That report's only dimensions are
// date, channel_id and video_id, so it already has one row per video per day and the
// fold is a pass-through for it; the weighting matters only if youtube ever widens it.)
//
// A weighted value is only valid within a single video, which holds because the fold key
// includes the video id - do not reuse these values across videos.
//
// `scale` converts the API's units to this schema's. Verified against a real report:
// video_thumbnail_impressions_ctr arrives as a RATIO (0.0819985 = 8.2%), while
// average_view_duration_percentage already arrives as a percentage (91.6). The ratio is
// scaled to a percentage so impressions_ctr matches the scale the rest of this codebase
// compares against (CTR_THRESHOLD = 6.5 in thumbnailsController.ts).
type AggregationMode = 'sum' | 'weighted';

interface ColumnMapping {
  column: string;
  mode: AggregationMode;
  weightBy?: string;
  scale?: number;
}

const COLUMN_AGGREGATION: Record<string, ColumnMapping> = {
  views:                            { column: 'views', mode: 'sum' },
  engaged_views:                    { column: 'engaged_views', mode: 'sum' },
  watch_time_minutes:               { column: 'watch_time_minutes', mode: 'sum' },
  comments:                         { column: 'comments', mode: 'sum' },
  likes:                            { column: 'likes', mode: 'sum' },
  dislikes:                         { column: 'dislikes', mode: 'sum' },
  shares:                           { column: 'shares', mode: 'sum' },
  videos_added_to_playlists:        { column: 'videos_added_to_playlists', mode: 'sum' },
  videos_removed_from_playlists:    { column: 'videos_removed_from_playlists', mode: 'sum' },
  subscribers_gained:               { column: 'subscribers_gained', mode: 'sum' },
  subscribers_lost:                 { column: 'subscribers_lost', mode: 'sum' },
  red_views:                        { column: 'red_views', mode: 'sum' },
  red_watch_time_minutes:           { column: 'red_watch_time_minutes', mode: 'sum' },
  average_view_duration_seconds:    { column: 'average_view_duration_seconds', mode: 'weighted', weightBy: 'views' },
  average_view_duration_percentage: { column: 'average_view_duration_percentage', mode: 'weighted', weightBy: 'views' },
  video_thumbnail_impressions:      { column: 'thumbnail_impressions', mode: 'sum' },
  video_thumbnail_impressions_ctr:  { column: 'impressions_ctr', mode: 'weighted', weightBy: 'video_thumbnail_impressions', scale: 100 },
};

// Columns deliberately ignored. They are rates, so summing them is wrong, and the card
// and annotation counters are not wanted in these tables. Listed explicitly so they do
// not trip the "unmapped column" warning on every single report.
const IGNORED_COLUMNS = new Set([
  'annotation_click_through_rate', 'annotation_close_rate', 'annotation_impressions',
  'annotation_clickable_impressions', 'annotation_closable_impressions',
  'annotation_clicks', 'annotation_closes',
  'card_click_rate', 'card_teaser_click_rate', 'card_impressions',
  'card_teaser_impressions', 'card_clicks', 'card_teaser_clicks',
]);

// Dimension columns, which key the fold rather than being aggregated into it.
const DIMENSION_COLUMNS = new Set([
  'date', 'channel_id', 'video_id', 'live_or_on_demand', 'subscribed_status', 'country_code',
]);

interface FoldedRow {
  videoId: string;
  date: string;
  sums: Map<string, number>;
  // numerator and denominator for each views-weighted column
  weighted: Map<string, { total: number; weight: number }>;
}

interface ParseOutcome {
  rows: FoldedRow[];
  // Rows YouTube reported for a video this channel has no owned_videos/owned_shorts row
  // for. Counted separately from shorts and channel-level rows because it is the only
  // bucket that means something is wrong.
  unknownVideoIds: Set<string>;
  unmappedColumns: Set<string>;
  // Weighted columns whose weight column this report does not carry.
  missingWeights: Set<string>;
}

class AnalyticsReportController {

  // channel id + failure kind -> when that pairing was last alerted on.
  private lastAlertedAt = new Map<string, number>();

  /**
   * One pass: for every channel we hold credentials for, make sure both reporting jobs
   * exist, then import whatever new reports they have produced.
   */
  async importReports(): Promise<void> {
    const channels = await getAllYoutubeAnalyticsParams();
    console.log(`Importing youtube reports for ${channels.length} channels.`);

    // Sequentially, one channel at a time. Concurrent transactions competing for the
    // same (video_id, date) conflict target deadlock, and the pg pool is shared with
    // every other service in this process.
    // Shared across the whole pass so the trailing sweep is spread over several passes
    // rather than all landing at once.
    const trailingBudget = { remaining: MAX_TRAILING_JOBS_PER_RUN };

    for (const channel of channels) {
      try {
        await this.importChannel(channel, trailingBudget);
      } catch (error) {
        await this.reportChannelFailure(channel, error);
      }
    }
  }

  private async importChannel(
    channel: YoutubeAnalyticsParamsRow,
    trailingBudget: { remaining: number },
  ): Promise<void> {
    const ownedChannelId = channel.owned_channels_id;
    const label = `${channel.channel_name ?? 'unnamed'} (${ownedChannelId})`;

    const [videoIds, shortIds] = await Promise.all([
      getOwnedVideoIdsForChannel(ownedChannelId),
      getOwnedShortIdsForChannel(ownedChannelId),
    ]);

    for (const reportType of REPORT_TYPES) {
      const job = await this.ensureJob(ownedChannelId, reportType.id, label);
      const reports = await this.pendingReports(ownedChannelId, job.jobId, reportType.id, label);

      for (const report of reports) {
        await this.importOneReport({
          channel, reportType, jobId: job.jobId, report, videoIds, shortIds, label,
        });
      }

      // After the normal poll, never instead of it: forward progress must not be
      // blocked by a sweep, and the sweep must not compete with it for the per-run cap.
      await this.trailingReimport({
        channel, reportType, job, videoIds, shortIds, label, trailingBudget,
      });
    }
  }

  /**
   * Re-imports the trailing window for one job, ignoring the ledger entirely, at most
   * once every TRAILING_REIMPORT_DAYS.
   *
   * Bounded by the date window rather than by MAX_REPORTS_PER_JOB_PER_RUN: one report per
   * day means the sweep is inherently about TRAILING_REIMPORT_DAYS reports, and keeping it
   * out of the capped path preserves the rule that the cap only ever applies to reports
   * not yet in the ledger.
   */
  private async trailingReimport(args: {
    channel: YoutubeAnalyticsParamsRow;
    reportType: { id: string; source: AnalyticsReportSource };
    job: { jobId: string; lastTrailingReimportAt: Date | null };
    videoIds: Map<string, number>;
    shortIds: Map<string, number>;
    label: string;
    trailingBudget: { remaining: number };
  }): Promise<void> {
    const { channel, reportType, job, videoIds, shortIds, label, trailingBudget } = args;

    const last = job.lastTrailingReimportAt;
    const due = !last || Date.now() - last.getTime() >= TRAILING_REIMPORT_INTERVAL_MS;
    if (!due || trailingBudget.remaining <= 0) {
      return;
    }
    trailingBudget.remaining--;

    const since = new Date(Date.now() - TRAILING_REIMPORT_DAYS * 24 * 60 * 60 * 1000);
    const reports = await youtubeReportingDatasource.listReports(
      channel.owned_channels_id, job.jobId, { startTimeAtOrAfter: since });

    // Same replacement rule as the normal poll: where several reports cover one day, only
    // the newest createTime is real.
    const newest = this.newestPerDay(reports);
    console.log(`${label}: trailing re-import of ${reportType.id}, ${newest.length} day(s) since ${since.toISOString().slice(0, 10)}.`);

    for (const report of newest) {
      await this.importOneReport({
        channel, reportType, jobId: job.jobId, report, videoIds, shortIds, label,
      });
    }

    // Only once the whole window is through, so an interrupted sweep runs again.
    await markTrailingReimportDone(job.jobId);
  }

  /** Keeps, per report day, only the report with the newest createTime. */
  private newestPerDay(reports: ReportingReport[]): ReportingReport[] {
    const byDay = new Map<string, ReportingReport>();
    for (const report of reports) {
      const existing = byDay.get(report.startTime);
      if (!existing || existing.createTime < report.createTime) {
        byDay.set(report.startTime, report);
      }
    }
    return [...byDay.values()].sort((a, b) => a.createTime.localeCompare(b.createTime));
  }

  /**
   * Returns the job id for this channel and report type, creating the job if YouTube
   * does not already have one.
   *
   * The order - stored row, then jobs.list, then jobs.create - matters: if a previous
   * run created the job but failed before storing it, the jobs.list step adopts it
   * instead of creating a duplicate.
   */
  private async ensureJob(
    ownedChannelId: number,
    reportTypeId: string,
    label: string,
  ): Promise<{ jobId: string; lastTrailingReimportAt: Date | null }> {
    const stored = await getAnalyticsReportJob(ownedChannelId, reportTypeId);
    if (stored) {
      return { jobId: stored.job_id, lastTrailingReimportAt: stored.last_trailing_reimport_at ?? null };
    }

    const existing = (await youtubeReportingDatasource.listJobs(ownedChannelId))
      .filter(job => job.reportTypeId === reportTypeId && !job.systemManaged)
      // Oldest first. Picking arbitrarily among several matching jobs can switch jobs
      // between runs and abandon the backfill history of the one left behind.
      .sort((a, b) => (a.createTime ?? '').localeCompare(b.createTime ?? ''));

    const job = existing[0]
      ?? await youtubeReportingDatasource.createJob(
        ownedChannelId, reportTypeId, `${JOB_NAME_PREFIX} ${reportTypeId}`);

    if (existing[0]) {
      console.log(`Adopted existing ${reportTypeId} job ${job.id} for ${label}.`);
    } else {
      console.log(`Created ${reportTypeId} job ${job.id} for ${label}. First report lands within ~48 hours.`);
    }

    await upsertAnalyticsReportJob({
      owned_channels_id: ownedChannelId,
      report_type_id: reportTypeId,
      job_id: job.id,
      job_name: job.name,
      job_create_time: job.createTime ? new Date(job.createTime) : null,
    });
    // A job this run just created has no history to sweep, but leaving the timestamp NULL
    // costs only one listReports call on the next pass and keeps the "NULL means due"
    // rule simple.
    return { jobId: job.id, lastTrailingReimportAt: null };
  }

  /**
   * The reports for this job that still need importing, oldest first.
   *
   * Pagination is exhausted before anything is sorted or capped, because capping a
   * partially fetched list would let the cursor advance past reports that were never
   * seen - and once createdAfter passes them they are gone for good.
   */
  private async pendingReports(
    ownedChannelId: number,
    jobId: string,
    reportTypeId: string,
    label: string,
  ): Promise<ReportingReport[]> {
    const [cursor, imported] = await Promise.all([
      getImportCursor(jobId),
      getImportedReportIds(jobId),
    ]);
    const createdAfter = cursor ? new Date(cursor.getTime() - CURSOR_OVERLAP_MS) : undefined;

    const all = await youtubeReportingDatasource.listReports(ownedChannelId, jobId, { createdAfter });
    await touchAnalyticsReportJobPolled(jobId);

    const fresh = all
      .filter(report => !imported.has(report.id))
      .sort((a, b) => a.createTime.localeCompare(b.createTime));

    // Where several reports cover the same day, only the newest is real: YouTube issues
    // a replacement with a new id, the same startTime and a later createTime. Ledger the
    // older ones as superseded so they are not re-listed and re-weighed every run.
    const newestPerDay = new Map<string, ReportingReport>();
    for (const report of fresh) {
      const existing = newestPerDay.get(report.startTime);
      if (!existing || existing.createTime < report.createTime) {
        if (existing) {
          await ledgerSupersededReport({
            reportId: existing.id,
            jobId,
            ownedChannelsId: ownedChannelId,
            reportTypeId,
            reportDate: this.pacificDate(existing.startTime),
            createTime: existing.createTime,
          });
        }
        newestPerDay.set(report.startTime, report);
      } else {
        await ledgerSupersededReport({
          reportId: report.id,
          jobId,
          ownedChannelsId: ownedChannelId,
          reportTypeId,
          reportDate: this.pacificDate(report.startTime),
          createTime: report.createTime,
        });
      }
    }

    const pending = [...newestPerDay.values()]
      .sort((a, b) => a.createTime.localeCompare(b.createTime));

    if (pending.length > MAX_REPORTS_PER_JOB_PER_RUN) {
      console.log(`${label}: ${pending.length} ${reportTypeId} reports pending, taking the oldest ${MAX_REPORTS_PER_JOB_PER_RUN} this pass.`);
    }
    return pending.slice(0, MAX_REPORTS_PER_JOB_PER_RUN);
  }

  private async importOneReport(args: {
    channel: YoutubeAnalyticsParamsRow;
    reportType: { id: string; source: AnalyticsReportSource };
    jobId: string;
    report: ReportingReport;
    videoIds: Map<string, number>;
    shortIds: Map<string, number>;
    label: string;
  }): Promise<void> {
    const { channel, reportType, jobId, report, videoIds, shortIds, label } = args;
    const ownedChannelId = channel.owned_channels_id;
    const reportDate = this.pacificDate(report.startTime);

    const parsed = await this.parseReport(ownedChannelId, report);
    const rowsByTarget = this.routeRows(parsed, reportType.source, videoIds, shortIds, ownedChannelId);

    if (parsed.missingWeights.size > 0) {
      console.error(`${label}: ${reportType.id} report ${report.id} is missing the weight column for [${[...parsed.missingWeights].join(', ')}] - those columns will be NULL for every row. Fix COLUMN_AGGREGATION.`);
    }
    if (parsed.unmappedColumns.size > 0) {
      console.warn(`${label}: ${reportType.id} report ${report.id} carried unmapped columns [${[...parsed.unmappedColumns].join(', ')}] - they were not imported.`);
    }
    if (parsed.unknownVideoIds.size > 0) {
      // Not benign: the video exists on youtube but not in owned_videos/owned_shorts, so
      // this day's numbers for it are being dropped, and the report is only downloadable
      // for 60 days. Once the sync catches up, delete this report's ledger row to replay it.
      console.error(`${label}: ${parsed.unknownVideoIds.size} video id(s) in ${reportType.id} report ${report.id} (${reportDate}) are in neither owned_videos nor owned_shorts and were skipped: ${[...parsed.unknownVideoIds].slice(0, 10).join(', ')}`);
    }

    const written = await importAnalyticsReport({
      source: reportType.source,
      reportTypeId: reportType.id,
      ownedChannelId,
      jobId,
      report: { id: report.id, createTime: report.createTime },
      reportDates: [reportDate],
      rowsByTarget,
      rowsSkipped: parsed.unknownVideoIds.size,
    });

    console.log(`${label}: imported ${reportType.id} report ${report.id} for ${reportDate} (${written} rows: ${rowsByTarget.video.length} video, ${rowsByTarget.short.length} shorts, ${rowsByTarget.channel.length} channel).`);
  }

  /**
   * Streams the report and folds its rows down to one per video per day.
   *
   * Columns are located by header name, never by position: the docs state the header row
   * is authoritative and that new metrics appear as new columns over time.
   */
  private async parseReport(ownedChannelId: number, report: ReportingReport): Promise<ParseOutcome> {
    const folded = new Map<string, FoldedRow>();
    const unknownVideoIds = new Set<string>();
    const unmappedColumns = new Set<string>();
    const missingWeights = new Set<string>();
    let header: string[] | null = null;

    for await (const line of youtubeReportingDatasource.streamReportLines(ownedChannelId, report.downloadUrl)) {
      if (line.length === 0) continue;

      if (!header) {
        header = line.split(',').map(column => column.trim());
        for (const column of header) {
          if (!DIMENSION_COLUMNS.has(column) && !COLUMN_AGGREGATION[column] && !IGNORED_COLUMNS.has(column)) {
            unmappedColumns.add(column);
          }
          // A weighted column whose weight is not in this report would silently divide
          // by a zero weight and store NULL for every row. Catch it at the header rather
          // than discovering it as a column of nulls in the database.
          const mapping = COLUMN_AGGREGATION[column];
          if (mapping?.mode === 'weighted' && !header.includes(mapping.weightBy ?? '')) {
            missingWeights.add(`${column} (weightBy ${mapping.weightBy})`);
          }
        }
        continue;
      }

      const cells = line.split(',');
      const valueAt = (column: string): string => {
        const index = header!.indexOf(column);
        return index === -1 ? '' : (cells[index] ?? '').trim();
      };

      const date = valueAt('date');
      if (!date) continue;
      // An empty video_id is not a missing value: youtube uses it for activity that
      // belongs to the channel rather than to one video, such as subscribers gained from
      // the channel page. Those rows are kept and routed to the channel table.
      const videoId = valueAt('video_id');

      const key = `${videoId}|${date}`;
      let row = folded.get(key);
      if (!row) {
        row = { videoId, date, sums: new Map(), weighted: new Map() };
        folded.set(key, row);
      }

      for (const column of header) {
        const mapping = COLUMN_AGGREGATION[column];
        if (!mapping) continue;
        const raw = this.toNumber(valueAt(column));
        if (raw === null) continue;
        const value = mapping.scale ? raw * mapping.scale : raw;

        if (mapping.mode === 'sum') {
          row.sums.set(mapping.column, (row.sums.get(mapping.column) ?? 0) + value);
          continue;
        }

        // Read per column rather than once per row, because different weighted columns
        // weight by different things - and a column named here that the report does not
        // carry would otherwise silently weight everything by zero, which is exactly how
        // impressions_ctr came out null for every row.
        const weight = this.toNumber(valueAt(mapping.weightBy ?? '')) ?? 0;
        const accumulator = row.weighted.get(mapping.column) ?? { total: 0, weight: 0 };
        accumulator.total += value * weight;
        accumulator.weight += weight;
        row.weighted.set(mapping.column, accumulator);
      }
    }

    // Note on dimension values: ZZ country codes and NULL-anonymised buckets are real
    // parts of the partition and are deliberately NOT filtered out - dropping them would
    // undercount every total.
    return { rows: [...folded.values()], unknownVideoIds, unmappedColumns, missingWeights };
  }

  /**
   * Sends each folded row to the table that can hold it: the channel table for
   * channel-level rows, analytics_report for owned videos, analytics_report_shorts for
   * shorts, and nowhere for a video this channel does not track.
   */
  private routeRows(
    parsed: ParseOutcome,
    source: AnalyticsReportSource,
    videoIds: Map<string, number>,
    shortIds: Map<string, number>,
    ownedChannelId: number,
  ): Record<AnalyticsReportTarget, AnalyticsImportRow[]> {
    const result: Record<AnalyticsReportTarget, AnalyticsImportRow[]> = { video: [], short: [], channel: [] };

    for (const row of parsed.rows) {
      let target: AnalyticsReportTarget;
      let entityId: number | undefined;

      if (row.videoId === '') {
        target = 'channel';
        entityId = ownedChannelId;
      } else if (videoIds.has(row.videoId)) {
        target = 'video';
        entityId = videoIds.get(row.videoId);
      } else if (shortIds.has(row.videoId)) {
        target = 'short';
        entityId = shortIds.get(row.videoId);
      } else {
        parsed.unknownVideoIds.add(row.videoId);
        continue;
      }

      result[target].push({
        entityId: entityId!,
        videoId: target === 'channel' ? undefined : row.videoId,
        date: row.date,
        metrics: this.finalise(row, target, source),
      });
    }

    return result;
  }

  /** Resolves the fold's accumulators into the exact column set the target table has. */
  private finalise(
    row: FoldedRow,
    target: AnalyticsReportTarget,
    source: AnalyticsReportSource,
  ): Record<string, number | null> {
    const metrics: Record<string, number | null> = {};

    for (const column of analyticsColumnsFor(target, source)) {
      if (row.sums.has(column)) {
        metrics[column] = row.sums.get(column)!;
        continue;
      }
      const weighted = row.weighted.get(column);
      // Null rather than zero when there is nothing to weight by: a bucket can carry
      // subscribers_gained with no views at all, and 0/0 is NaN, which pg rejects on a
      // double precision bind.
      metrics[column] = weighted && weighted.weight > 0 ? weighted.total / weighted.weight : null;
    }

    return metrics;
  }

  /**
   * True at most once per cooldown per channel and failure kind. A channel that changes
   * from one failure kind to another alerts immediately, because that is new
   * information - re-consenting a channel onto a project without the Reporting API
   * enabled, say, turns needs_reconsent into api_disabled and is worth hearing about.
   */
  private shouldAlert(ownedChannelId: number, kind: ReportingErrorKind): boolean {
    const key = `${ownedChannelId}:${kind}`;
    const last = this.lastAlertedAt.get(key);
    if (last !== undefined && Date.now() - last < FAILURE_ALERT_COOLDOWN_MS) {
      return false;
    }
    this.lastAlertedAt.set(key, Date.now());
    return true;
  }

  /** '' and 'NULL' both mean "no value here", not zero. */
  private toNumber(value: string): number | null {
    if (value === '' || value.toUpperCase() === 'NULL') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** The Pacific calendar day an RFC3339 instant falls in, as YYYY-MM-DD. */
  private pacificDate(instant: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: REPORT_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(instant));
  }

  /**
   * A channel that cannot authenticate produces no analytics, and reports expire after
   * 60 days, so these three failures are losses that compound silently. They get a
   * discord message as well as a log line; everything else is left to the logs.
   */
  private async reportChannelFailure(channel: YoutubeAnalyticsParamsRow, error: unknown): Promise<void> {
    const label = `${channel.channel_name ?? 'unnamed'} (${channel.owned_channels_id})`;
    const kind: ReportingErrorKind = youtubeReportingDatasource.classifyError(error);

    const explanation: Record<ReportingErrorKind, string> = {
      needs_reconsent: `needs re-consent: its refresh token lacks the yt-analytics.readonly scope the Reporting API requires. Re-authenticate it from Owned Channels in ntm-data.`,
      invalid_grant: `has a revoked or expired refresh token. Re-authenticate it from Owned Channels in ntm-data.`,
      api_disabled: `cannot be read: the YouTube Reporting API is not enabled in the google cloud project that owns its client_id.`,
      transient: `failed this pass; the next run will retry.`,
    };

    console.error(`Analytics report import for ${label} ${explanation[kind]}`, error);

    if (kind === 'transient') return;
    // Logged above either way; only production pages anyone. See the cooldown note.
    if (!isProduction) return;
    if (!this.shouldAlert(channel.owned_channels_id, kind)) return;
    try {
      await discordController.messageUser(
        DISCORD_NOTIFY_USER_ID,
        `YouTube analytics import: **${label}** ${explanation[kind]}`,
      );
    } catch (notifyError) {
      // A notice is a side channel; a discord outage must not take the import down.
      console.error('Could not send the analytics import discord notice:', notifyError);
    }
  }
}

export const analyticsReportController = new AnalyticsReportController();
