import dotenv from 'dotenv';
import { google } from "googleapis";
import { Readable } from "node:stream";
import { getYoutubeAuthParamsForChannel } from './ntmDataDatasource.js';
import { gDriveDatasource } from './gDriveDatasource.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

class YoutubeDatasource {

  constructor() {}

  /**
   * Sets the thumbnail of a YouTube video from a Google Drive thumbnail url.
   * The bytes are pulled from Drive with the service account and pushed straight to YouTube,
   * authenticated as the channel that owns the video.
   */
  async setVideoThumbnail(videoId: string, thumbnailUrl: string, ownedChannelId: number): Promise<void> {
    const fileId = this.extractGDriveFileId(thumbnailUrl);
    if (!fileId) {
      throw new Error(`Could not extract a Google Drive file id from ${thumbnailUrl}`);
    }

    const authParams = await getYoutubeAuthParamsForChannel(ownedChannelId);
    if (!authParams) {
      throw new Error(`No youtube oauth params for owned channel ${ownedChannelId}`);
    }

    const { data, mimeType } = await gDriveDatasource.downloadFile(fileId);

    const auth = new google.auth.OAuth2(authParams.client_id, authParams.client_secret);
    auth.setCredentials({ refresh_token: authParams.refresh_token });

    const youtube = google.youtube({ version: "v3", auth });
    await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType,
        body: Readable.from(data),
      },
    });

    console.log(`Uploaded thumbnail to YouTube for video ${videoId} (drive file ${fileId}, ${data.length} bytes).`);
  }

  private extractGDriveFileId(thumbnailUrl: string): string | null {
    const match = thumbnailUrl.match(/[?&]id=([^&]+)/);
    return match ? match[1] : null;
  }
}

export const youtubeDatasource = new YoutubeDatasource();
