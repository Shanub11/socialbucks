// ONE-TIME MANUAL VERIFICATION SCRIPT. Not part of the app, not imported by
// anything else, not run automatically. Delete this file once its result is
// recorded in docs/adr/0002-payout-settlement-engine.md (OQ-2) — do not leave
// it sitting in the repo afterward.

import { verifyIsShort } from './src/lib/youtube/analytics';

const ACCESS_TOKEN = process.env.YOUTUBE_ACCESS_TOKEN;
const SHORT_VIDEO_ID = process.env.SHORT_VIDEO_ID;
const LONG_VIDEO_ID = process.env.LONG_VIDEO_ID;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function fetchRawCreatorContentType(
  videoId: string,
  accessToken: string,
): Promise<{ status: number; raw: unknown }> {
  const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
  url.searchParams.set('ids', 'channel==MINE');
  url.searchParams.set('startDate', '2020-01-01');
  url.searchParams.set('endDate', '2030-01-01');
  url.searchParams.set('filters', `video==${videoId}`);
  url.searchParams.set('dimensions', 'creatorContentType');
  url.searchParams.set('metrics', 'views');

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const raw = await response.json();
  return { status: response.status, raw };
}

async function checkVideo(label: string, videoId: string, accessToken: string) {
  console.log(`\n=== ${label}: ${videoId} ===`);

  try {
    const result = await verifyIsShort(videoId, accessToken);
    console.log(`verifyIsShort() returned: ${result}`);
  } catch (err) {
    console.log('verifyIsShort() threw:', err);
  }

  try {
    const { status, raw } = await fetchRawCreatorContentType(videoId, accessToken);
    console.log(`Raw API status: ${status}`);
    console.log('Raw API response:', JSON.stringify(raw, null, 2));

    const parsed = raw as { columnHeaders?: { name: string }[]; rows?: unknown[][] };
    const dimensionIndex = parsed.columnHeaders?.findIndex(
      (h) => h.name === 'creatorContentType',
    );
    if (dimensionIndex !== undefined && dimensionIndex >= 0 && parsed.rows) {
      console.log(
        'Actual creatorContentType value(s) returned:',
        parsed.rows.map((row) => row[dimensionIndex]),
      );
    } else {
      console.log('Could not locate creatorContentType in columnHeaders — inspect the raw response above by hand.');
    }
  } catch (err) {
    console.log('Raw API call threw:', err);
  }
}

async function main() {
  const accessToken = requireEnv('YOUTUBE_ACCESS_TOKEN', ACCESS_TOKEN);
  const shortId = requireEnv('SHORT_VIDEO_ID', SHORT_VIDEO_ID);
  const longId = requireEnv('LONG_VIDEO_ID', LONG_VIDEO_ID);

  await checkVideo('Known SHORT video', shortId, accessToken);
  await checkVideo('Known LONG-FORM video', longId, accessToken);
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});