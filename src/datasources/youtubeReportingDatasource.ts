import { google, youtubereporting_v1 } from "googleapis";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { getYoutubeAuthParamsForChannel } from "./ntmDataDatasource.js";

// A report download that never answers would park the service's loop forever, and that
// loop is shared with every other service in this process.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// Transient failures get a few tries with widening gaps. Reports stay downloadable for
// 60 days, so there is no value in fighting hard for one right now - the next pass
// picks it up.
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 2_000;

/** gzip's magic number. See streamReport() for why it is sniffed rather than assumed. */
const GZIP_MAGIC = [0x1f, 0x8b];

export type ReportingErrorKind =
  // The refresh token predates yt-analytics.readonly being requested. Needs re-consent
  // through the ntm-data app; no amount of retrying helps.
  | 'needs_reconsent'
  // The YouTube Reporting API is not enabled in the google cloud project that owns this
  // channel's client_id.
  | 'api_disabled'
  // The refresh token has been revoked or expired (a consent screen left in Testing
  // expires its tokens after 7 days).
  | 'invalid_grant'
  | 'transient';

export interface ReportingJob {
  id: string;
  reportTypeId: string;
  name: string | null;
  createTime: string | null;
  systemManaged: boolean;
}

export interface ReportingReport {
  id: string;
  jobId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  downloadUrl: string;
}

class YoutubeReportingDatasource {

  constructor() {}

  /**
   * Classifies a failure so the caller can tell "this channel needs a human" from
   * "try again in six hours". The three permanent kinds are reported differently and
   * must not be retried.
   */
  classifyError(error: unknown): ReportingErrorKind {
    const any = error as any;
    const reason = any?.errors?.[0]?.reason
      ?? any?.response?.data?.error?.details?.[0]?.reason
      ?? '';
    // A token exchange failure is shaped differently from an API failure: the body is
    // `{ error: 'invalid_grant' }`, not a google.rpc status with a reason.
    const oauthError = typeof any?.response?.data?.error === 'string'
      ? any.response.data.error
      : '';
    const message = String(any?.message ?? error ?? '');

    if (oauthError === 'invalid_grant' || /invalid_grant/i.test(message)) {
      return 'invalid_grant';
    }
    if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /insufficient authentication scopes/i.test(message)) {
      return 'needs_reconsent';
    }
    if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(message)) {
      return 'api_disabled';
    }
    return 'transient';
  }

  /**
   * Builds an auth client for one channel. Constructed per call and never cached, so a
   * credential changed in the DB is picked up without a restart - the same reasoning
   * gDriveDatasource.getAuth() documents.
   *
   * Only the refresh token is seeded. The stored access_token is always stale (it lives
   * an hour, this service runs every six) and carries no expiry_date, which would make
   * the client believe it is still good and hand a dead token to the API.
   */
  private async authFor(ownedChannelId: number) {
    const params = await getYoutubeAuthParamsForChannel(ownedChannelId);
    if (!params) {
      throw new Error(`No youtube oauth params for owned channel ${ownedChannelId}`);
    }
    const auth = new google.auth.OAuth2(params.client_id, params.client_secret);
    auth.setCredentials({ refresh_token: params.refresh_token });
    return auth;
  }

  private async reportingFor(ownedChannelId: number) {
    const auth = await this.authFor(ownedChannelId);
    return { auth, reporting: google.youtubereporting({ version: "v1", auth }) };
  }

  /**
   * Every reporting job visible to this channel's credentials, including the
   * system-managed ones so the caller can decide about them explicitly.
   */
  async listJobs(ownedChannelId: number): Promise<ReportingJob[]> {
    const { reporting } = await this.reportingFor(ownedChannelId);
    const jobs: ReportingJob[] = [];
    let pageToken: string | undefined;

    do {
      const response = await reporting.jobs.list({ includeSystemManaged: true, pageToken });
      // An empty list comes back as `{}` with no `jobs` key at all, not an empty array.
      for (const job of response.data.jobs ?? []) {
        if (!job.id || !job.reportTypeId) continue;
        jobs.push({
          id: job.id,
          reportTypeId: job.reportTypeId,
          name: job.name ?? null,
          createTime: job.createTime ?? null,
          systemManaged: job.systemManaged === true,
        });
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return jobs;
  }

  async createJob(ownedChannelId: number, reportTypeId: string, name: string): Promise<ReportingJob> {
    const { reporting } = await this.reportingFor(ownedChannelId);
    const response = await reporting.jobs.create({ requestBody: { reportTypeId, name } });
    const job = response.data;
    if (!job.id) {
      throw new Error(`jobs.create for ${reportTypeId} returned no job id`);
    }
    return {
      id: job.id,
      reportTypeId: job.reportTypeId ?? reportTypeId,
      name: job.name ?? name,
      createTime: job.createTime ?? null,
      systemManaged: job.systemManaged === true,
    };
  }

  /**
   * Every report for a job created after `createdAfter`, following nextPageToken to
   * exhaustion before returning. Exhausting the pages here rather than letting the
   * caller stop early is deliberate: the caller sorts and caps the result, and capping
   * a partially fetched list would let the cursor move past reports never seen.
   *
   * Note `createdAfter` is exclusive, which is why the caller subtracts an overlap.
   */
  async listReports(
    ownedChannelId: number,
    jobId: string,
    options: { createdAfter?: Date; startTimeAtOrAfter?: Date } = {},
  ): Promise<ReportingReport[]> {
    const { reporting } = await this.reportingFor(ownedChannelId);
    const reports: ReportingReport[] = [];
    let pageToken: string | undefined;

    do {
      const params: youtubereporting_v1.Params$Resource$Jobs$Reports$List = { jobId, pageToken };
      if (options.createdAfter) {
        params.createdAfter = options.createdAfter.toISOString();
      }
      // Filters on the data's own date rather than on when the report was created, which
      // is what the trailing re-import needs: it wants the last N days of data whether or
      // not those reports have been seen before.
      if (options.startTimeAtOrAfter) {
        params.startTimeAtOrAfter = options.startTimeAtOrAfter.toISOString();
      }
      const response = await reporting.jobs.reports.list(params);
      for (const report of response.data.reports ?? []) {
        if (!report.id || !report.downloadUrl || !report.startTime || !report.createTime) {
          console.warn(`Skipping incomplete report resource on job ${jobId}:`, report);
          continue;
        }
        reports.push({
          id: report.id,
          jobId: report.jobId ?? jobId,
          startTime: report.startTime,
          endTime: report.endTime ?? report.startTime,
          createTime: report.createTime,
          downloadUrl: report.downloadUrl,
        });
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return reports;
  }

  /**
   * Yields the report's CSV one line at a time.
   *
   * Streaming is a hard requirement, not an optimisation: a single day of
   * channel_basic_a3 for the largest channel is tens of thousands of rows, and buffering
   * it into a string would put hundreds of megabytes into a process shared with seven
   * other services. Nothing here may call response.text().
   *
   * The body arrives either gzipped or already inflated - undici sets Accept-Encoding
   * itself and transparently decompresses - so the first two bytes are sniffed for
   * gzip's magic number instead of trusting either outcome.
   */
  async *streamReportLines(ownedChannelId: number, downloadUrl: string): AsyncGenerator<string> {
    const { auth } = await this.reportingFor(ownedChannelId);

    const response = await this.withRetries(async () => {
      const token = await auth.getAccessToken();
      const accessToken = typeof token === 'string' ? token : token?.token;
      if (!accessToken) {
        throw new Error('Could not obtain an access token for the report download');
      }
      const result = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!result.ok) {
        const body = await result.text().catch(() => '');
        const error: any = new Error(`Report download failed: ${result.status} ${result.statusText} ${body.slice(0, 500)}`);
        error.status = result.status;
        throw error;
      }
      if (!result.body) {
        throw new Error('Report download returned no body');
      }
      return result;
    }, `download ${downloadUrl.slice(0, 80)}`);

    const source = Readable.fromWeb(response.body as any);
    const sniffed = await this.gunzipIfNeeded(source);

    const lines = createInterface({ input: sniffed, crlfDelay: Infinity });
    for await (const line of lines) {
      yield line;
    }
  }

  /**
   * Peeks at the first chunk to decide whether the stream needs inflating, then replays
   * that chunk so nothing is consumed. Done by hand because the decision has to be made
   * from the bytes rather than from a header.
   */
  private async gunzipIfNeeded(source: Readable): Promise<Readable> {
    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      return Readable.from([]);
    }

    const head = first.value as Buffer;
    const replayed = Readable.from((async function* () {
      yield head;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })());

    const isGzip = head.length >= 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
    return isGzip ? replayed.pipe(createGunzip()) : replayed;
  }

  /**
   * Retries only what a retry can fix. A permanent classification is rethrown
   * immediately so the caller can report it and move to the next channel instead of
   * spending four attempts on a token that will never work.
   */
  private async withRetries<T>(operation: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const kind = this.classifyError(error);
        const status = (error as any)?.status ?? (error as any)?.code;
        const retryable = kind === 'transient'
          && (status === 429 || status === undefined || (typeof status === 'number' && status >= 500)
              || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|aborted|timeout/i.test(String((error as any)?.message ?? '')));
        if (!retryable || attempt === MAX_ATTEMPTS) {
          throw error;
        }
        const wait = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`Attempt ${attempt}/${MAX_ATTEMPTS} of ${label} failed (${(error as any)?.message}); retrying in ${wait}ms.`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  }
}

export const youtubeReportingDatasource = new YoutubeReportingDatasource();
