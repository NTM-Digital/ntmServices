# Video Views Outlier Service - Metrics Explained

This document explains the different performance metrics calculated by the Video Views Outlier Service in non-technical terms.

---

## Channel-Level Metrics

These metrics provide a baseline for understanding how a channel typically performs:

### **Median First 24 Hours**
The typical number of views a channel's videos get in their first 24 hours after publishing.

- **What it means:** Half of the channel's recent videos performed better than this number, and half performed worse
- **How we calculate it:** We look at videos published in recent months (excluding very low performers) and find the middle value
- **Why it matters:** This is your benchmark for "normal" performance in the critical first day

### **Median First Week**
The typical number of views a channel's videos get in their first week after publishing.

- **What it means:** The middle value when looking at all first-week view counts
- **How we calculate it:** Same approach as the 24-hour metric, but measured over 7 days
- **Why it matters:** Shows how videos typically perform over a longer initial period

### **Median Trajectory**
A ratio showing how much views typically grow from day 1 to week 1.

- **What it means:** If this value is 5.0, it means videos typically get 5 times more views in the first week than in the first 24 hours
- **How we calculate it:** First week views divided by first 24-hour views, then we find the middle value across all videos
- **Why it matters:** Shows whether videos have "staying power" or if most views come in the first day

### **P90 Trajectory**
The trajectory value that 90% of videos fall below (top 10% performer threshold).

- **What it means:** Only the best-performing 10% of videos exceed this trajectory value
- **How we calculate it:** Same as median trajectory, but we look at the 90th percentile instead of the 50th
- **Why it matters:** Helps identify truly exceptional video performance

### **Average Views Last 24 Hours**
The typical daily views across all of a channel's active videos.

- **What it means:** How many views per day the channel's content is generating on average
- **How we calculate it:** A P20-logarithmic average (which reduces the impact of outlier viral videos)
- **Why it matters:** Provides a baseline for comparing individual video performance

---

## Video-Level Metrics

These metrics help identify how individual videos are performing:

### **Trajectory** (Individual Video)
How much a specific video's views grew from day 1 to week 1.

- **What it means:** If a video has a trajectory of 6.0, it got 6 times more views in the first week than in the first 24 hours
- **How we calculate it:** First week views ÷ first 24-hour views
- **Why it matters:**
  - Higher values = video gained momentum after launch
  - Lower values = strong start but didn't maintain momentum
  - Compare to your channel's median trajectory to see if this video is typical

### **Growth Factor**
Whether an older video is suddenly getting more (or fewer) views than usual.

- **What it means:**
  - Value around 1.0 = video performing normally
  - Value > 1.0 = video is trending up (getting more daily views than its recent average)
  - Value < 1.0 = video is slowing down
- **How we calculate it:** We compare the last few days' average views to the previous weeks' typical daily views
- **Why it matters:** Helps identify videos that are "going viral" or experiencing a resurgence in interest
- **Note:** Only calculated for videos with consistent viewing history (at least 500 baseline views)

### **Video Performance**
How a video is performing compared to the channel's typical daily views.

- **What it means:**
  - Value around 1.0 = performing at channel average
  - Value > 1.0 = outperforming the channel average
  - Value < 1.0 = underperforming the channel average
- **How we calculate it:** Video's views in last 24 hours ÷ channel's average daily views
- **Why it matters:** Quickly identify which videos are driving your current viewership and which are falling behind

---

## How These Metrics Work Together

1. **Channel medians** establish your baseline - what's "normal" for your content
2. **Individual video trajectory** shows how each video performed in its critical first week
3. **Growth factor** identifies older videos experiencing unusual activity
4. **Video performance** shows which videos are currently driving your channel's views

By monitoring these metrics, you can:
- Identify which videos are outperforming expectations
- Spot trending videos early
- Understand what "normal" looks like for your channel
- Make data-driven decisions about content strategy
