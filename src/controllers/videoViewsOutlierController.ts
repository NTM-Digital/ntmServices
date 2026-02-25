
import { videoViewsOutlierDatasource, ChannelMedianViews } from "../datasources/videoViewsOutlierDatasource.js";

class VideoViewsOutlierController {

  constructor() {
    // Initialize any necessary properties or dependencies here
  }
    async calculateAndStoreMedianViews() {
        try {
            const medianViewsData: ChannelMedianViews[] = await videoViewsOutlierDatasource.getMedianViewsFromVideos();
            const filteredData = medianViewsData.filter(data => data.median_first_24h != null && data.median_first_24h > 0 && data.median_first_week != null && data.median_first_week > 0);
            await videoViewsOutlierDatasource.setMedianViewsForChannels(filteredData);
        } catch (error) {
            console.error('Error calculating and storing median views:', error);
            throw error;
        }
    }
}

export const videoViewsOutlierController = new VideoViewsOutlierController();