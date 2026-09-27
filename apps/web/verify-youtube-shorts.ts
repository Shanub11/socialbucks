import { verifyIsShort } from './src/lib/youtube/analytics';

async function main() {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) {
    console.error('Please set YOUTUBE_ACCESS_TOKEN environment variable');
    process.exit(1);
  }

  // Replace these with actual video IDs from the authenticated channel
  const shortVideoId = process.env.SHORT_VIDEO_ID || 'REPLACE_WITH_SHORT_ID';
  const longVideoId = process.env.LONG_VIDEO_ID || 'REPLACE_WITH_LONG_ID';

  console.log(`Testing verifyIsShort for Short video (${shortVideoId})...`);
  try {
    const isShort = await verifyIsShort(shortVideoId, token);
    console.log(`Result for ${shortVideoId}: isShort = ${isShort}`);
  } catch (err) {
    console.error(`Error testing Short video:`, err);
  }

  console.log(`\nTesting verifyIsShort for Long video (${longVideoId})...`);
  try {
    const isShort = await verifyIsShort(longVideoId, token);
    console.log(`Result for ${longVideoId}: isShort = ${isShort}`);
  } catch (err) {
    console.error(`Error testing Long video:`, err);
  }
}

main().catch(console.error);
