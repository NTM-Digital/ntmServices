import { geminiDatasource } from '../datasources/geminiDatasource.js';
import {
  setVideoDescriptionSegments,
  findVideosWithoutDescriptions,
  markVideoDescriptionFailed,
  getVideoDurationSeconds,
  VideoDescriptionSegment,
  VideoToDescribe,
} from '../datasources/ntmDataDatasource.js';

/** Videos are identified by their YouTube id everywhere else in this codebase,
 *  so this controller takes an id and builds the watch url the model needs. */
const YOUTUBE_WATCH_URL = 'https://www.youtube.com/watch?v=';

/** The video to describe while this controller is still being tried out. */
const TEST_VIDEO_ID = 'ascvz0cEiXw';

/**
 * The model watches the video before writing anything, which for a long
 * compilation runs past the datasource's ten minute default.
 */
const ANALYSIS_TIMEOUT_MS = 30 * 60 * 1000;

/** How many videos to describe at once during a backfill. */
const DEFAULT_CONCURRENCY = 6;

/** Videos longer than this are left alone — they cost several times the average and
 *  the longest exceed what the model can take in at all. */
const DEFAULT_MAX_DURATION_SECONDS = 3600;

/**
 * Rough pre-run cost estimate, fitted to one measured run: navigation reasoning is
 * near-fixed per call and bills at the output rate, while retrieval scales with how
 * much video there is to watch. Only for deciding whether a batch is affordable — the
 * real per-video figure comes back from the API afterwards.
 */
const ESTIMATE_FIXED_USD = 0.032;
const ESTIMATE_USD_PER_MINUTE = 0.0013;

/**
 * Failures that will not improve on a retry, so the video earns a marker row and is
 * skipped from then on.
 *
 * Everything not matched here is treated as transient and left unmarked for the next
 * run. That default matters: at six requests in parallel a rate-limit rejection is the
 * likeliest failure of all, and marking a throttled video would exclude a perfectly
 * good one forever. Each pattern is deliberately scoped to the video rather than the
 * request — a bare /not found/, for instance, would also match a misconfigured model
 * name and would then condemn every video in the batch.
 */
const PERMANENT_FAILURES = [
  /video unavailable/i,
  /private video/i,
  /video (?:has been )?(?:removed|deleted)/i,
  /video not found/i,
  /age[- ]?restricted/i,
  /context (?:length|window)/i,
  /token limit/i,
  /without any output text/i, // ours: the model finished but produced nothing
  /returned no segments/i,    // ours: the model finished with an empty array
];

/** Recognised only to log throttling distinctly, so concurrency can be tuned down. */
const RATE_LIMITED = /\b429\b|RESOURCE_EXHAUSTED|rate limit|quota/i;

export interface BackfillSummary {
  processed: number;
  failed: number;
  /** Left undone because the spend ceiling was reached. */
  skipped: number;
  totalCostUsd: number;
}

/** The segment types the prompt allows, mirrored by the schema below. */
const SEGMENT_TYPES = [
  'Continuous video',
  'Compilation item',
  'Introduction',
  'Advertisement',
  'Interstitial',
  'Conclusion',
] as const;

export interface VideoSegment {
  /** Sequential, three digits, e.g. "001". */
  SEGMENT_ID: string;
  TITLE: string;
  SEGMENT_TYPE: (typeof SEGMENT_TYPES)[number];
  /** Whole seconds from the start of the video to where this segment begins. */
  START_TIME: number;
  /** Self-contained prose, roughly 120-200 words. This is what gets embedded. */
  DESCRIPTION: string;
  /** Main searchable concepts. Empty only if the segment genuinely has none. */
  KEY_TOPICS: string[];
}

export interface VideoDescription {
  segments: VideoSegment[];
  /** Best-effort USD cost of the analysis call — undefined if the API omitted usage. */
  estimatedCostUsd?: number;
}

/**
 * Pins the response shape server-side. Worth doing even though the prompt also
 * describes the format: without it the model picks its own key casing and the
 * optional fields drift between runs, which is exactly the inconsistency that
 * breaks a retrieval index built up over many videos.
 *
 * `propertyOrdering` asks for the fields in prompt order, which keeps DESCRIPTION
 * being written after TITLE and SEGMENT_TYPE rather than before them.
 */
const SEGMENTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      SEGMENT_ID: { type: 'string', description: 'Sequential three-digit id, starting at 001.' },
      TITLE: { type: 'string', description: 'A specific descriptive title.' },
      SEGMENT_TYPE: { type: 'string', enum: [...SEGMENT_TYPES] },
      START_TIME: { type: 'integer', description: 'Whole seconds from the start of the video to where this segment begins. 0 for the first segment.' },
      DESCRIPTION: { type: 'string', description: 'Self-contained prose about the segment\'s subject, approximately 120-200 words.' },
      KEY_TOPICS: { type: 'array', items: { type: 'string' } },
    },
    required: ['SEGMENT_ID', 'TITLE', 'SEGMENT_TYPE', 'START_TIME', 'DESCRIPTION', 'KEY_TOPICS'],
    propertyOrdering: ['SEGMENT_ID', 'TITLE', 'SEGMENT_TYPE', 'START_TIME', 'DESCRIPTION', 'KEY_TOPICS'],
  },
} as const;

/**
 * The segmentation and content rules are reproduced verbatim from the agreed
 * brief. Only the OUTPUT FORMAT section differs: the brief's `<<<SEGMENT_START>>>`
 * delimiters cannot coexist with a JSON response, so the same field names are
 * asked for as objects in a JSON array instead, and KEY_TOPICS became a string
 * array rather than a "comma-separated list" — the JSON-native form, joined
 * back to text only on the way into the database.
 */
const ANALYSIS_PROMPT = `Analyze the supplied video for semantic indexing and vector retrieval.

Your goal is to produce accurate, information-dense descriptions that can later be split and embedded as independent vectors.

SEGMENTATION

First inspect the entire video sufficiently to determine whether it is:

- One continuous work from a single source, or
- A compilation containing multiple independent videos, clips, stories, demonstrations, advertisements, or source items.

Create a new segment only when there is strong evidence of an independent item, such as:

- A different original video or source
- A new title card, introduction, or closing sequence
- A clear reset in speaker, creator, setting, visual style, or subject
- An embedded clip that functions as a self-contained piece
- A distinct advertisement or promotional section

Do not create a new segment merely because of a camera cut, slide change, example, topic transition, or change of scene within the same continuous work. Prefer fewer, well-supported segments over excessive fragmentation. Do not omit short compilation items.

If the video is not a compilation, return exactly one segment.

CONTENT REQUIREMENTS

These descriptions are embedded as vectors and compared against other videos to find similar content, so describe what the segment is fundamentally about rather than cataloguing everything in it.

For each segment, provide a standalone description covering:

- The principal subject and purpose
- The kind of video it is: its format, genre and intended audience
- The setting, and the participants and their roles
- The main activity, storyline or argument, in outline
- Enough context for the segment to make sense without any other segment

Describe the substance at a level that would still be true of a comparable video on the same subject. Omit incidental specifics — individual props, on-screen text, interface details, exact numbers and passing visual changes — which make the vector describe this recording rather than its subject.

Name people, organizations and products only where they are central to the segment.

Do not invent identities, relationships, sources, or details that cannot be established from the video. Where something is unclear, leave it out rather than hedging in prose.

VECTOR-READINESS RULES

- Do not include timestamps, timecodes, durations, frame numbers, or playback positions in TITLE, DESCRIPTION or KEY_TOPICS. The START_TIME field is the only place a playback position belongs.
- Do not use context-dependent phrases such as "the previous segment," "as mentioned earlier," or "the next clip."
- Repeat essential names and context so every segment is independently understandable.
- Do not combine information from separate compilation items.
- Do not produce an overall summary that mixes the segments.
- Use concise prose, avoiding filler and repetition.
- Aim for approximately 120-200 words per segment, adjusted to the amount of substantive content.

OUTPUT FORMAT

Return a JSON array containing one object per independent segment, in their original order. Produce nothing outside that array.

Each object has exactly these fields:

- SEGMENT_ID: a sequential three-digit string, starting at "001" and incrementing by one.
- TITLE: a specific descriptive title.
- SEGMENT_TYPE: exactly one of "Continuous video", "Compilation item", "Introduction", "Advertisement", "Interstitial" or "Conclusion".
- START_TIME: the approximate start time of the segment within the video, in seconds.
- DESCRIPTION: a self-contained, detailed description written as coherent prose.
- KEY_TOPICS: an array of strings, the main searchable concepts.`;

class VideoDescriptionController {

  constructor() {
    // Initialize any necessary properties or dependencies here
  }

  /**
   * Describes a YouTube video as one or more independently embeddable segments.
   * The model watches the video server-side, so this takes minutes rather than
   * seconds.
   */
  async describeVideo(videoId: string): Promise<VideoDescription> {
    const youtubeUrl = `${YOUTUBE_WATCH_URL}${videoId}`;

    // Left to itself the model will occasionally put a segment past the end of the
    // video — it was observed starting one 161s after a 1365s video finished. Telling
    // it the runtime gives it something to check its own answer against. The lookup is
    // a single indexed read against a call that takes minutes, so it is free.
    const durationSeconds = await getVideoDurationSeconds(videoId);
    const prompt = durationSeconds
      ? `${ANALYSIS_PROMPT}\n\nThis video is ${durationSeconds} seconds long. Every START_TIME must be between 0 and ${durationSeconds}.`
      : ANALYSIS_PROMPT;

    const { data, usage, estimatedCostUsd } = await geminiDatasource.analyzeYoutubeVideo<VideoSegment[]>(
      youtubeUrl,
      prompt,
      { schema: SEGMENTS_SCHEMA as unknown as Record<string, unknown>, timeoutMs: ANALYSIS_TIMEOUT_MS },
    );

    // The schema guarantees the shape of each object but not that the root is a
    // populated array, so an empty or non-array result is caught here rather
    // than surfacing later as an undefined property.
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`Gemini returned no segments for ${youtubeUrl}.`);
    }

    // Backstop for the above. A start time past the end is known to be wrong, so it is
    // dropped rather than stored as fact — segment order survives in the row order.
    // Note this only catches overshoots: a start time that is wrong but still inside
    // the video is undetectable here, so the prompt is the real safeguard.
    if (durationSeconds) {
      for (const segment of data) {
        if (segment.START_TIME > durationSeconds || segment.START_TIME < 0) {
          console.warn(
            `Segment ${segment.SEGMENT_ID} of ${videoId} claims START_TIME ${segment.START_TIME}s `
            + `on a ${durationSeconds}s video — storing it as unknown.`
          );
          segment.START_TIME = NaN;
        }
      }
    }

    console.log(
      `Described ${youtubeUrl} as ${data.length} segment(s)`
      + (usage?.total_tokens ? ` using ${usage.total_tokens} tokens` : '')
      + '.'
    );

    // total_tokens already sums the input, output, thought, cached and tool-use
    // components, so it needs nothing added to it — but only the breakdown shows
    // where the cost went. For a video the split between video-modality input
    // tokens and reasoning tokens is what a backfill estimate rests on, and
    // reasoning dominates heavily on this model.
    if (usage) {
      console.log('Token usage:', JSON.stringify(usage));
    }

    if (estimatedCostUsd !== undefined) {
      console.log(`Estimated cost: $${estimatedCostUsd.toFixed(4)}.`);
    }

    return { segments: data, estimatedCostUsd };
  }

  /**
   * Describes a video and replaces its rows in video_description.
   *
   * SEGMENT_ID has no column in that table and is dropped on the way in — the
   * segments' order is preserved by START_TIME, and otherwise only by the order
   * they are inserted in.
   */
  async describeAndStoreVideo(videoId: string): Promise<VideoDescription> {
    const description = await this.describeVideo(videoId);
    const { segments, estimatedCostUsd } = description;

    // One call produces every segment, so its cost is divided evenly between
    // them rather than repeated on each row — repeating it would multiply the
    // apparent spend by the segment count on any SUM().
    const costPerSegment = estimatedCostUsd !== undefined
      ? Math.round(estimatedCostUsd / segments.length * 10000) / 10000
      : null;

    const rows: VideoDescriptionSegment[] = segments.map(segment => ({
      title: segment.TITLE,
      segment_type: segment.SEGMENT_TYPE,
      description: segment.DESCRIPTION,
      key_topics: segment.KEY_TOPICS,
      // describeVideo blanks a start time it knows to be impossible, and a model is
      // free to return something non-numeric regardless, so anything that is not a
      // real number is stored as unknown rather than crashing the insert.
      start_time: Number.isFinite(segment.START_TIME) ? segment.START_TIME : null,
      estimated_cost: costPerSegment,
    }));

    await setVideoDescriptionSegments(videoId, rows);
    console.log(`Stored ${rows.length} description segment(s) for video ${videoId}.`);

    return description;
  }

  /**
   * Describes the newest videos in a project that have no description yet, newest
   * first, and stores each one as it finishes.
   *
   * Safe to re-run: the query excludes anything that already has rows, so a repeat
   * call picks up where the last one stopped rather than redoing work.
   */
  async describeNewestInProject(
    projectName: string,
    limit: number,
    options: {
      concurrency?: number;
      maxSpendUsd?: number;
      maxDurationSeconds?: number;
      /** Only consider videos published within this many hours. Omit for the whole back catalogue. */
      publishedSinceHours?: number;
    } = {},
  ): Promise<BackfillSummary> {
    const {
      concurrency = DEFAULT_CONCURRENCY,
      maxSpendUsd,
      maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
      publishedSinceHours,
    } = options;

    const videos = await findVideosWithoutDescriptions(projectName, limit, {
      maxDurationSeconds,
      publishedSinceHours,
    });
    if (videos.length === 0) {
      console.log(`No videos without descriptions in project "${projectName}".`);
      return { processed: 0, failed: 0, skipped: 0, totalCostUsd: 0 };
    }

    const estimate = videos.reduce(
      (total, video) => total + ESTIMATE_FIXED_USD + ESTIMATE_USD_PER_MINUTE * ((video.duration_seconds ?? 0) / 60),
      0,
    );
    console.log(
      `Describing ${videos.length} video(s) from project "${projectName}" at concurrency ${concurrency}. `
      + `Rough estimate $${estimate.toFixed(2)}`
      + (maxSpendUsd !== undefined ? `, stopping at $${maxSpendUsd.toFixed(2)}` : '')
      + '.'
    );

    let processed = 0;
    let failed = 0;
    let totalCostUsd = 0;
    let next = 0;
    let stopped = false;

    // Hand-rolled worker pool: each worker pulls the next index until the list runs
    // out. Promise.all over a fixed number of workers keeps exactly `concurrency`
    // requests in flight without needing a dependency.
    const worker = async () => {
      while (!stopped) {
        if (maxSpendUsd !== undefined && totalCostUsd >= maxSpendUsd) {
          // Checked between videos, so the ceiling can be overshot by whatever is
          // already in flight. It is a brake, not a hard cap.
          stopped = true;
          return;
        }

        const index = next++;
        if (index >= videos.length) return;
        const video = videos[index];

        try {
          const { estimatedCostUsd } = await this.describeAndStoreVideo(video.video_id);
          totalCostUsd += estimatedCostUsd ?? 0;
          processed++;
        } catch (error) {
          failed++;
          await this.recordFailure(video, error);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, videos.length) }, worker));

    const skipped = videos.length - processed - failed;
    console.log(
      `Finished project "${projectName}": ${processed} described, ${failed} failed`
      + (skipped > 0 ? `, ${skipped} skipped on the spend ceiling` : '')
      + `. Actual cost $${totalCostUsd.toFixed(4)}.`
    );

    return { processed, failed, skipped, totalCostUsd };
  }

  /**
   * Decides whether a failed video should be written off or left for the next run.
   * Only an explicitly recognised permanent error gets a marker — see
   * PERMANENT_FAILURES for why the default is to retry.
   */
  private async recordFailure(video: VideoToDescribe, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (RATE_LIMITED.test(message)) {
      console.warn(
        `Rate limited on video ${video.video_id} — leaving it for the next run. `
        + `Lower the concurrency if this keeps happening: ${message}`
      );
      return;
    }

    if (!PERMANENT_FAILURES.some(pattern => pattern.test(message))) {
      console.error(`Transient failure on video ${video.video_id}, leaving it for the next run: ${message}`);
      return;
    }

    console.error(`Permanent failure on video ${video.video_id}, marking it so later runs skip it: ${message}`);
    try {
      // The cost of the failed attempt is not available here — it is lost with the
      // thrown error — so the marker's estimated_cost stays null for now.
      await markVideoDescriptionFailed(video.video_id, message);
    } catch (markError) {
      console.error(`Could not write the failure marker for video ${video.video_id}:`, markError);
    }
  }

  /**
   * Describes the test video, stores it, and writes the result to the console.
   * Temporary entry point while the output format is being evaluated.
   */
  async describeAndStoreTestVideo() {
    try {
      const { segments } = await this.describeAndStoreVideo(TEST_VIDEO_ID);
      console.log(JSON.stringify(segments, null, 2));
    } catch (error) {
      console.error(`Error describing video ${TEST_VIDEO_ID}:`, error);
      throw error;
    }
  }
}

export const videoDescriptionController = new VideoDescriptionController();
