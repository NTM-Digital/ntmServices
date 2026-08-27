import { getOwnedVideosPublishedLast24Hours, getThumbnailUrlsForVideo, getThumbnailsForVideo, addThumbnailsToVideo, updateThumbnailCtr, setThumbnailAsPublished, OwnedVideoPublishedRecently, Thumbnail } from '../datasources/ntmDataDatasource.js';
import { getGDriveThumbnailIdsForVIdeo, VideoExtraInfo, JobInfo, ThumbnailInfo, ThumbnailRedo, VideoThumbnailSources } from '../datasources/ntmTasksDatasource.js';
import { youtubeDatasource } from '../datasources/youtubeDatasource.js';

const GDRIVE_THUMBNAIL_SIZE = 'w1000';

// How many times each thumbnail of a video gets published before we compare their average
// ctrs and settle on a winner.
const MAX_PUBLISHING_NUM = 2;

// A full rotation needs 1 + 2 * thumbnails runs, and at a two hour interval more than five
// thumbnails no longer fits inside the 24 hours of ctr_first_24h data, so the rest are ignored.
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
   * Each thumbnail is published MAX_PUBLISHING_NUM times, collecting one ctr sample per run
   * it is live. Once every thumbnail has that many samples we keep the one with the highest
   * average ctr and stop rotating.
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
      return;
    }

    const ctr = this.calculateLatestCtr(video.ctr_first_24h);
    if (ctr === null) {
      console.log(`Not enough ctr data yet for video ${video.video_id}, skipping rotation.`);
      return;
    }

    await updateThumbnailCtr(published.id, ctr);
    console.log(`Recorded ctr ${ctr.toFixed(2)}% for thumbnail ${published.id} of video ${video.video_id}.`);

    // Reflect the ctr we just wrote so the checks below see the up to date state.
    const updated = thumbnails.map(thumbnail => thumbnail.id === published.id
      ? { ...thumbnail, ctrs: [...(thumbnail.ctrs ?? []), { ctr, timestamp: new Date().toISOString() }] }
      : thumbnail);

    if (this.isRotationFinished(updated)) {
      await this.pickWinningThumbnail(updated, video);
      return;
    }

    await this.switchToNextThumbnail(updated, published, video);
  }

  private isRotationFinished(thumbnails: Thumbnail[]): boolean {
    return thumbnails.every(thumbnail => (thumbnail.ctrs ?? []).length >= MAX_PUBLISHING_NUM);
  }

  private async pickWinningThumbnail(thumbnails: Thumbnail[], video: OwnedVideoPublishedRecently) {
    let winner: Thumbnail | null = null;
    let winnerAverage = -Infinity;

    for (const thumbnail of thumbnails) {
      const average = this.averageCtr(thumbnail);
      if (average !== null && average > winnerAverage) {
        winner = thumbnail;
        winnerAverage = average;
      }
    }

    if (!winner) {
      return;
    }

    if (winner.currently_published) {
      console.log(`Rotation finished for video ${video.video_id}, keeping thumbnail ${winner.id} (avg ctr ${winnerAverage.toFixed(2)}%).`);
      return;
    }

    console.log(`Rotation finished for video ${video.video_id}, switching to winning thumbnail ${winner.id} (avg ctr ${winnerAverage.toFixed(2)}%).`);
    await this.publishThumbnail(winner, video);
  }

  private async switchToNextThumbnail(thumbnails: Thumbnail[], current: Thumbnail, video: OwnedVideoPublishedRecently) {
    const currentIndex = thumbnails.findIndex(thumbnail => thumbnail.id === current.id);
    const next = thumbnails[(currentIndex + 1) % thumbnails.length];
    if (next.id === current.id) {
      // Only one thumbnail for this video, so there is nothing to rotate to.
      return;
    }

    await this.publishThumbnail(next, video);
  }

  // The YouTube upload has to land before we record the thumbnail as published, so that a failed
  // upload leaves the previous thumbnail marked live and the rotation retries on the next run.
  private async publishThumbnail(thumbnail: Thumbnail, video: OwnedVideoPublishedRecently) {
    await youtubeDatasource.setVideoThumbnail(video.video_id, thumbnail.url, video.owned_channel_id);
    await setThumbnailAsPublished(thumbnail.id, video.video_id);
    console.log(`Published thumbnail ${thumbnail.id} for video ${video.video_id}.`);
  }

  /**
   * Derives the ctr of the last measured window from the two most recent ctr_first_24h entries,
   * as deltaViews / deltaImpressions. Returned as a percentage to match the scale of the
   * impressionClickThroughRate values youtube reports.
   */
  private calculateLatestCtr(ctrFirst24h: Record<string, any> | null): number | null {
    if (!Array.isArray(ctrFirst24h) || ctrFirst24h.length < 2) {
      return null;
    }

    const sorted = [...ctrFirst24h].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const previous = sorted[sorted.length - 2];
    const latest = sorted[sorted.length - 1];

    const deltaViews = latest.views - previous.views;
    const deltaImpressions = latest.impressions - previous.impressions;
    if (!(deltaImpressions > 0) || deltaViews < 0) {
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
