import {findVideosWithoutCreatorsOrFilmingDates, VideoWithoutCreator, getDataUserIdByName, setFilmingDateForVideo, setVideoCreator} from '../datasources/ntmDataDatasource.js';
import {findVideoCreatorsAndFilmingDatesForVideos} from '../datasources/ntmTasksDatasource.js';

export const syncVideoCreatorsAndFilmingDates = async () => {
  try {
    const videos: VideoWithoutCreator[] = await findVideosWithoutCreatorsOrFilmingDates();
    console.log(`Found ${videos.length} videos without creators or filming dates.`);    
    if (videos.length === 0) {
      return;
    }
    const videoIds = videos.map(v => v.video_id);
    const ntmTasksVideoData = await findVideoCreatorsAndFilmingDatesForVideos(videoIds);
    console.log(`Fetched creators and filming dates for ${ntmTasksVideoData.length} videos.`);
    if(ntmTasksVideoData.length === 0) {
      console.log('No video creator or filming date data found.');
      return;
    }
    for (const data of ntmTasksVideoData) {
        const dataUserId = await getDataUserIdByName(data.name);
        if(!dataUserId) {
          console.warn(`No data user found for name: ${data.name}`);
          continue;
        }
        data['data_user_id'] = dataUserId;
    }
    console.log('Prepared video creator and filming date data:', ntmTasksVideoData);

    // Create combined array with data from both sources
    const combinedData = ntmTasksVideoData.map(taskData => {
      const videoData = videos.find(v => v.video_id === taskData.video_id);
      if (!videoData) {
        console.warn(`No matching video data found for video ID: ${taskData.video_id}`);
        return null;
      }

      // Get filming date and convert to UTC
      const filmingDateSource = videoData?.filming_date ?? taskData.filming_date;
      const filmingDateUTC = filmingDateSource ? new Date(filmingDateSource).toISOString() : null;

      return {
        video_id: taskData.video_id,
        name: taskData.name,
        filming_date: filmingDateUTC,
        data_users_id: videoData.data_users_id ?? taskData.data_user_id,
        owned_channel_id: videoData.owned_channel_id
      };
    });
    for (const data of combinedData) {
      if (!data) {
        continue;
      }
      if (data.filming_date) {
        await setFilmingDateForVideo(data.video_id, data.filming_date);
      }
      if (data.data_users_id) {
        await setVideoCreator(data.video_id, data.data_users_id, data.owned_channel_id);
      }
    } 
    console.log(`Combined data for ${combinedData.length} videos.`);
    console.log(combinedData);

  } catch (error) {
    console.error('Error syncing video creators:', error);
    throw error;
  }
};