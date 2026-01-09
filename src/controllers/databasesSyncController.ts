import {findVideosWithoutCreatorsOrFilmingDates, findShortsWithoutCreatorsOrFilmingDates, VideoWithoutCreator, getDataUserIdByName, setFilmingDateForVideo, setFilmingDateForShort, setVideoCreator, setShortCreator} from '../datasources/ntmDataDatasource.js';
import {findVideoCreatorsAndFilmingDatesForVideos} from '../datasources/ntmTasksDatasource.js';

export const syncVideoCreatorsAndFilmingDates = async () => {
  try {
    // Process videos
    const videos: VideoWithoutCreator[] = await findVideosWithoutCreatorsOrFilmingDates();
    console.log(`Found ${videos.length} videos without creators or filming dates.`);

    if (videos.length > 0) {
      const videoIds = videos.map(v => v.video_id);
      const ntmTasksVideoData = await findVideoCreatorsAndFilmingDatesForVideos(videoIds);
      console.log(`Fetched creators and filming dates for ${ntmTasksVideoData.length} videos.`);

      if (ntmTasksVideoData.length > 0) {
        for (const data of ntmTasksVideoData) {
          const dataUserId = await getDataUserIdByName(data.name);
          if (!dataUserId) {
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
      }
    }

    // Process shorts
    const shorts: VideoWithoutCreator[] = await findShortsWithoutCreatorsOrFilmingDates();
    console.log(`Found ${shorts.length} shorts without creators or filming dates.`);

    if (shorts.length > 0) {
      const shortIds = shorts.map(s => s.video_id);
      const ntmTasksShortData = await findVideoCreatorsAndFilmingDatesForVideos(shortIds);
      console.log(`Fetched creators and filming dates for ${ntmTasksShortData.length} shorts.`);

      if (ntmTasksShortData.length > 0) {
        for (const data of ntmTasksShortData) {
          const dataUserId = await getDataUserIdByName(data.name);
          if (!dataUserId) {
            console.warn(`No data user found for name: ${data.name}`);
            continue;
          }
          data['data_user_id'] = dataUserId;
        }
        console.log('Prepared short creator and filming date data:', ntmTasksShortData);

        // Create combined array with data from both sources
        const combinedData = ntmTasksShortData.map(taskData => {
          const shortData = shorts.find(s => s.video_id === taskData.video_id);
          if (!shortData) {
            console.warn(`No matching short data found for video ID: ${taskData.video_id}`);
            return null;
          }

          // Get filming date and convert to UTC
          const filmingDateSource = shortData?.filming_date ?? taskData.filming_date;
          const filmingDateUTC = filmingDateSource ? new Date(filmingDateSource).toISOString() : null;

          return {
            video_id: taskData.video_id,
            name: taskData.name,
            filming_date: filmingDateUTC,
            data_users_id: shortData.data_users_id ?? taskData.data_user_id,
            owned_channel_id: shortData.owned_channel_id
          };
        });

        for (const data of combinedData) {
          if (!data) {
            continue;
          }
          if (data.filming_date) {
            await setFilmingDateForShort(data.video_id, data.filming_date);
          }
          if (data.data_users_id) {
            await setShortCreator(data.video_id, data.data_users_id, data.owned_channel_id);
          }
        }
        console.log(`Combined data for ${combinedData.length} shorts.`);
        console.log(combinedData);
      }
    }

  } catch (error) {
    console.error('Error syncing video creators:', error);
    throw error;
  }
};