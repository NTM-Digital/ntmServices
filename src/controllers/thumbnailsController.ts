import { getOwnedVideosPublishedLast24Hours, getThumbnailUrlsForVideo, getThumbnailsForVideo, addThumbnailsToVideo, updateThumbnailCtr, setThumbnailAsPublished, OwnedVideoPublishedRecently, Thumbnail } from '../datasources/ntmDataDatasource.js';
import { getGDriveThumbnailIdsForVIdeo, VideoExtraInfo, JobInfo, ThumbnailInfo, ThumbnailRedo, VideoThumbnailSources } from '../datasources/ntmTasksDatasource.js';
import { youtubeDatasource } from '../datasources/youtubeDatasource.js';
import { discordController } from './discordController.js';

const GDRIVE_THUMBNAIL_SIZE = 'w1000';

// Who gets the dm whenever the rotation drops or switches a thumbnail.
const DISCORD_NOTIFY_USER_ID = '897201950544789576';

// How many times each thumbnail of a video gets published before we compare their average
// ctrs and settle on a winner. A thumbnail dropped for poor performance (see CTR_THRESHOLD)
// does not get its remaining turns.
const MAX_PUBLISHING_NUM = 2;

// How long one turn in the rotation lasts. A thumbnail holding up gets the full window before
// the next one takes over.
const PUBLISHING_WINDOW_MINUTES = 2 * 60;

// A thumbnail measuring below this ctr (in percent) is performing poorly enough that there is
// no point leaving it up: its ctr is recorded, it is swapped out right away and it is dropped
// from the rotation rather than getting its remaining turns.
const CTR_THRESHOLD = 6.5;

// How long a thumbnail is given before it can be dropped for poor performance. Anything
// shorter has too little data behind it to act on.
const MIN_MINUTES_BEFORE_DROP = 20;

// The measured window needs this many impressions behind it before its ctr counts as a ctr at
// all; below it the window reads as "no ctr yet" and the thumbnail stays live longer. A floor
// is needed because youtube reports views rounded to the nearest hundred, which puts an error
// of roughly 100 / impressions on a window's ctr - ~2pp at 5k impressions, but ~20pp at 500,
// which is no basis for dropping a thumbnail. Lower it to judge slower videos sooner, at the
// cost of deciding on numbers that are largely rounding.
const MIN_IMPRESSIONS_FOR_CTR = 5000;

// A full rotation takes up to 1 + MAX_PUBLISHING_NUM * thumbnails windows, and at a two hour
// window more than five thumbnails no longer fits inside the 24 hours of ctr_first_24h data,
// so the rest are ignored.
const MAX_THUMBNAILS_PER_VIDEO = 5;

class ThumbnailsController {

  constructor() {
    // Initialize any necessary properties or dependencies here
  }

  async syncThumbnailsForRecentVideos() {
    const videos: OwnedVideoPublishedRecently[] = await getOwnedVideosPublishedLast24Hours();
    console.log(`Checking thumbnails for ${videos.length} recently published video(s).`);

    for (const video of videos) {
      try {
        await this.syncThumbnailsForVideo(video.video_id);
        await this.rotateThumbnailsForVideo(video);
      } catch (error) {
        // Keep going so one bad video does not stop the whole run.
        console.error(`Error syncing thumbnails for video ${video.video_id}:`, error);
      }
    }
  }

  private async syncThumbnailsForVideo(videoId: string) {
    const extraInfo = await getGDriveThumbnailIdsForVIdeo(videoId);
    const gDriveIds = this.extractThumbnailIds(extraInfo);
    if (gDriveIds.length === 0) {
      return;
    }

    const urls = gDriveIds.map(id => this.buildThumbnailUrl(id));
    const existingUrls = await getThumbnailUrlsForVideo(videoId);
    const newUrls = urls.filter(url => !existingUrls.includes(url));

    if (newUrls.length === 0) {
      return;
    }

    // The cap counts what is already stored, so late arrivals cannot push a video over it either.
    const capacity = MAX_THUMBNAILS_PER_VIDEO - existingUrls.length;
    if (capacity <= 0) {
      console.log(`Video ${videoId} already has ${existingUrls.length} thumbnail(s), ignoring ${newUrls.length} more.`);
      return;
    }

    const urlsToAdd = newUrls.slice(0, capacity);
    if (urlsToAdd.length < newUrls.length) {
      console.log(`Ignoring ${newUrls.length - urlsToAdd.length} thumbnail(s) for video ${videoId} over the cap of ${MAX_THUMBNAILS_PER_VIDEO}.`);
    }

    await addThumbnailsToVideo(videoId, urlsToAdd);
    console.log(`Added ${urlsToAdd.length} new thumbnail(s) for video ${videoId}.`);
  }

  /**
   * Records the ctr of the currently published thumbnail and moves the rotation on.
   *
   * Each thumbnail is published MAX_PUBLISHING_NUM times for PUBLISHING_WINDOW_MINUTES at a
   * time, collecting one ctr sample per turn it is live. Once no thumbnail is owed another
   * turn we keep the one with the highest average ctr and stop rotating.
   *
   * The exception is a poor performer: from MIN_MINUTES_BEFORE_DROP into its turn, a thumbnail
   * measuring below CTR_THRESHOLD has its ctr recorded there and then, hands over early and is
   * dropped from the rotation instead of getting its remaining turns. If that happens to every
   * thumbnail of a video, the best of them goes back up and a human gets told.
   *
   * Without a usable ctr nothing happens at all: the thumbnail stays live until there is
   * something to judge it on.
   */
  private async rotateThumbnailsForVideo(video: OwnedVideoPublishedRecently) {
    const thumbnails = await getThumbnailsForVideo(video.video_id);
    if (thumbnails.length === 0) {
      return;
    }

    const published = thumbnails.find(thumbnail => thumbnail.currently_published);
    if (!published) {
      // Nothing live yet, so this is the first run for this video: start with the first in line.
      await this.publishThumbnail(thumbnails[0], video);
      return;
    }

    if (this.isRotationFinished(thumbnails)) {
      // Nothing left to measure. The only thing that can still need doing is the switch to the
      // winner, in case it failed the first time around.
      await this.ensureWinnerIsLive(thumbnails, video);
      return;
    }

    if (!published.published_at) {
      // Published before published_at was recorded. It is already live, so only the clock is
      // missing - start it here and give it a full turn from now.
      await setThumbnailAsPublished(published.id, video.video_id);
      console.log(`Started the publishing clock for thumbnail ${published.id} of video ${video.video_id}.`);
      return;
    }

    const minutesLive = (Date.now() - published.published_at.getTime()) / 60000;
    if (minutesLive < MIN_MINUTES_BEFORE_DROP) {
      return;
    }

    const ctr = this.calculateCtrSincePublished(video.ctr_first_24h, published.published_at);
    if (ctr === null) {
      return;
    }

    // Still doing fine, so let it serve out the rest of its turn.
    if (ctr >= CTR_THRESHOLD && minutesLive < PUBLISHING_WINDOW_MINUTES) {
      return;
    }

    await updateThumbnailCtr(published.id, ctr);
    if (ctr < CTR_THRESHOLD) {
      console.log(`Thumbnail ${published.id} of video ${video.video_id} only managed ${ctr.toFixed(2)}% ctr after ${Math.round(minutesLive)} min, below the ${CTR_THRESHOLD}% threshold - dropping it from the rotation.`);
      await this.notify([
        `**Thumbnail dropped** - ${this.videoLink(video)}`,
        `Thumbnail ${published.id} only managed **${ctr.toFixed(2)}% ctr** over ${Math.round(minutesLive)} min, below the ${CTR_THRESHOLD}% threshold, so it is out of the rotation.`,
        published.url,
      ]);
    } else {
      console.log(`Recorded ctr ${ctr.toFixed(2)}% for thumbnail ${published.id} of video ${video.video_id}.`);
    }

    // Reflect the ctr we just wrote so the checks below see the up to date state.
    const updated = thumbnails.map(thumbnail => thumbnail.id === published.id
      ? { ...thumbnail, ctrs: [...(thumbnail.ctrs ?? []), { ctr, timestamp: new Date().toISOString() }] }
      : thumbnail);

    const next = this.findNextInRotation(updated, published);
    if (!next) {
      await this.concludeRotation(updated, video);
      return;
    }

    if (next.id === published.id) {
      // The live thumbnail is the only one still owed a turn, so there is nothing to switch to
      // and it keeps the slot. Re-stamping published_at gives the next turn a window of its own
      // without re-uploading the same image to youtube.
      await setThumbnailAsPublished(next.id, video.video_id);
      console.log(`Thumbnail ${next.id} of video ${video.video_id} is the only one left in the rotation, giving it another turn.`);
      return;
    }

    await this.publishThumbnail(next, video);
    await this.notify([
      `**Thumbnail switched** - ${this.videoLink(video)}`,
      `Thumbnail ${published.id} came off at ${ctr.toFixed(2)}% ctr, thumbnail ${next.id} is now live.`,
      next.url,
    ]);
  }

  /**
   * A thumbnail is still in the rotation while it is owed turns and has not been dropped.
   * Both come off the ctrs it has collected, so a restart cannot hand one an extra turn or put
   * a dropped one back in.
   */
  private isInRotation(thumbnail: Thumbnail): boolean {
    const ctrs = thumbnail.ctrs ?? [];
    return ctrs.length < MAX_PUBLISHING_NUM && ctrs.every(entry => entry.ctr >= CTR_THRESHOLD);
  }

  private isRotationFinished(thumbnails: Thumbnail[]): boolean {
    return !thumbnails.some(thumbnail => this.isInRotation(thumbnail));
  }

  /**
   * The next thumbnail owed a turn, wrapping around from the current one. Null once none are,
   * which is what ends the rotation. Going by what each thumbnail has collected rather than by
   * position means a thumbnail added mid rotation still gets its turns.
   */
  private findNextInRotation(thumbnails: Thumbnail[], current: Thumbnail): Thumbnail | null {
    const currentIndex = thumbnails.findIndex(thumbnail => thumbnail.id === current.id);

    for (let offset = 1; offset <= thumbnails.length; offset++) {
      const candidate = thumbnails[(currentIndex + offset) % thumbnails.length];
      if (this.isInRotation(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Called the one time the rotation runs out of turns: the winner goes up for good. A video
   * whose every thumbnail was dropped for poor performance has no winner worth the name, so the
   * best of a bad set goes up instead and a human gets told.
   */
  private async concludeRotation(thumbnails: Thumbnail[], video: OwnedVideoPublishedRecently) {
    const winner = this.bestThumbnail(thumbnails);
    if (!winner) {
      return;
    }

    if (thumbnails.every(thumbnail => !this.wasEverAboveThreshold(thumbnail))) {
      console.log(`Every thumbnail of video ${video.video_id} stayed below ${CTR_THRESHOLD}%, settling on the best of them (${winner.id}, avg ctr ${this.averageCtr(winner)?.toFixed(2)}%).`);
      // Sent before the switch below, so a failed switch does not ping twice when the next run
      // retries it.
      await this.notify([
        `**Every thumbnail came in under the threshold** - ${this.videoLink(video)}`,
        `None of the ${thumbnails.length} thumbnail(s) managed ${CTR_THRESHOLD}% ctr, so the rotation is out of options and this one needs a look. Settling on the best of them, thumbnail ${winner.id} (avg **${this.averageCtr(winner)?.toFixed(2)}% ctr**).`,
        winner.url,
      ]);
    } else {
      console.log(`Rotation finished for video ${video.video_id}, winner is thumbnail ${winner.id} (avg ctr ${this.averageCtr(winner)?.toFixed(2)}%).`);
    }

    await this.ensureWinnerIsLive(thumbnails, video);
  }

  /**
   * Puts the winner live if it is not already. Also runs on every pass over a finished rotation,
   * which is what repairs a switch that did not go through: a youtube error on that one call
   * would otherwise leave whichever thumbnail happened to be last in the rotation live for good,
   * since there is nothing left to measure that would move it on.
   */
  private async ensureWinnerIsLive(thumbnails: Thumbnail[], video: OwnedVideoPublishedRecently) {
    const winner = this.bestThumbnail(thumbnails);
    if (!winner || winner.currently_published) {
      return;
    }

    console.log(`Switching video ${video.video_id} to winning thumbnail ${winner.id}.`);
    await this.publishThumbnail(winner, video);
    await this.notify([
      `**Rotation finished** - ${this.videoLink(video)}`,
      `Thumbnail ${winner.id} won with an average of **${this.averageCtr(winner)?.toFixed(2)}% ctr** and is now live for good.`,
      winner.url,
    ]);
  }

  /**
   * Sends one rotation notice as a discord dm. Notices are a side channel, so a discord outage
   * must not take the rotation down with it: this logs and carries on instead of throwing.
   */
  private async notify(lines: string[]) {
    try {
      await discordController.messageUser(DISCORD_NOTIFY_USER_ID, lines.join('\n'));
    } catch (error) {
      console.error('Could not send the thumbnail rotation notice to discord:', error);
    }
  }

  private videoLink(video: OwnedVideoPublishedRecently): string {
    return `https://www.youtube.com/watch?v=${video.video_id}`;
  }

  // Never measured below the threshold, and measured at least once - so it ran a full turn
  // without being dropped.
  private wasEverAboveThreshold(thumbnail: Thumbnail): boolean {
    const ctrs = thumbnail.ctrs ?? [];
    return ctrs.length > 0 && ctrs.every(entry => entry.ctr >= CTR_THRESHOLD);
  }

  /**
   * The thumbnail with the highest average ctr, dropped or not: being dropped only costs a
   * thumbnail the turns it had left, so one that did well before falling below the threshold can
   * still come out on top.
   */
  private bestThumbnail(thumbnails: Thumbnail[]): Thumbnail | null {
    let best: Thumbnail | null = null;
    let bestAverage = -Infinity;

    for (const thumbnail of thumbnails) {
      const average = this.averageCtr(thumbnail);
      if (average !== null && average > bestAverage) {
        best = thumbnail;
        bestAverage = average;
      }
    }

    return best;
  }

  // The YouTube upload has to land before we record the thumbnail as published, so that a failed
  // upload leaves the previous thumbnail marked live and the rotation retries on the next run.
  private async publishThumbnail(thumbnail: Thumbnail, video: OwnedVideoPublishedRecently) {
    await youtubeDatasource.setVideoThumbnail(video.video_id, thumbnail.url, video.owned_channel_id);
    await setThumbnailAsPublished(thumbnail.id, video.video_id);
    console.log(`Published thumbnail ${thumbnail.id} for video ${video.video_id}.`);
  }

  /**
   * Derives the ctr the currently published thumbnail earned while it was live, as
   * deltaViews / deltaImpressions between the first ctr_first_24h snapshot taken after it went up
   * and the most recent one. Starting at the first snapshot after publishing keeps the previous
   * thumbnail's impressions out of the window, at the cost of ignoring the few minutes between
   * publishing and that snapshot.
   *
   * Returned as a percentage to match the scale of the impressionClickThroughRate values youtube
   * reports. Null whenever the window does not carry enough to judge - no snapshot since
   * publishing, or too few impressions in it - which the caller treats as "no ctr yet".
   */
  private calculateCtrSincePublished(ctrFirst24h: Record<string, any> | null, publishedAt: Date): number | null {
    if (!Array.isArray(ctrFirst24h)) {
      return null;
    }

    const sorted = [...ctrFirst24h].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const baselineIndex = sorted.findIndex(entry =>
      new Date(entry.timestamp).getTime() >= publishedAt.getTime());
    // Either nothing has been recorded since publishing, or the only thing recorded since is the
    // baseline itself - no window to measure in both cases.
    if (baselineIndex === -1 || baselineIndex === sorted.length - 1) {
      return null;
    }

    const baseline = sorted[baselineIndex];
    const latest = sorted[sorted.length - 1];

    const deltaViews = latest.views - baseline.views;
    const deltaImpressions = latest.impressions - baseline.impressions;
    if (deltaImpressions < MIN_IMPRESSIONS_FOR_CTR || deltaViews < 0) {
      return null;
    }

    return (deltaViews / deltaImpressions) * 100;
  }

  private averageCtr(thumbnail: Thumbnail): number | null {
    const ctrs = thumbnail.ctrs ?? [];
    if (ctrs.length === 0) {
      return null;
    }
    return ctrs.reduce((sum, entry) => sum + entry.ctr, 0) / ctrs.length;
  }

  /**
   * Thumbnails normally hang off "Video"."extraInfo", but for a lot of videos that column is NULL
   * or an empty object. Whenever it yields nothing, the thumbnails live on the job the video was
   * produced from instead.
   */
  private extractThumbnailIds(sources: VideoThumbnailSources | null): string[] {
    if (!sources) {
      return [];
    }

    const extraInfo = this.parseJson<VideoExtraInfo>(sources.extraInfo, 'extraInfo');
    const fromVideo = this.resolveThumbnailImages(extraInfo?.thumbnail);
    if (fromVideo.length > 0) {
      return fromVideo;
    }

    const jobInfo = this.parseJson<JobInfo>(sources.jobInfo, 'jobInfo');
    return this.resolveThumbnailImages(jobInfo?.thumbnail);
  }

  // A redo supersedes the original images, so the newest revision wins when one is present.
  private resolveThumbnailImages(thumbnail?: ThumbnailInfo): string[] {
    if (!thumbnail) {
      return [];
    }

    const images = this.latestRedoImages(thumbnail.redo) ?? thumbnail.images;
    if (!Array.isArray(images)) {
      return [];
    }
    return images.filter(id => typeof id === 'string' && id.length > 0);
  }

  private latestRedoImages(redo?: ThumbnailRedo[] | ThumbnailRedo): string[] | null {
    if (!redo) {
      return null;
    }

    // Nearly always an array of revisions, but at least one job stores a single bare object.
    const revisions = (Array.isArray(redo) ? redo : [redo])
      .filter(revision => Array.isArray(revision?.images) && revision.images.length > 0);
    if (revisions.length === 0) {
      return null;
    }

    const latest = revisions.reduce((newest, revision) =>
      this.timestampOf(revision) >= this.timestampOf(newest) ? revision : newest);
    return latest.images ?? null;
  }

  private timestampOf(revision: ThumbnailRedo): number {
    const parsed = Date.parse(revision.timestamp ?? '');
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private parseJson<T>(value: T | string | null, label: string): T | null {
    if (!value) {
      return null;
    }
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.error(`Could not parse ${label} as JSON:`, error);
      return null;
    }
  }

  private buildThumbnailUrl(gDriveId: string): string {
    return `https://drive.google.com/thumbnail?id=${gDriveId}&sz=${GDRIVE_THUMBNAIL_SIZE}`;
  }
}

export const thumbnailsController = new ThumbnailsController();
