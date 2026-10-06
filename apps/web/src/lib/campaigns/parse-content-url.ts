// apps/web/src/lib/campaigns/parse-content-url.ts
//
// Pure URL -> {platform, contentId} parser for content submitted by a creator.
//
// No DB access, no network calls — it only string-matches a URL and returns
// the platform the content lives on plus the platform's canonical content ID.
// Everything the route needs (platform, contentId, socialAccountId) is derived
// server-side; the client may only supply the raw contentUrl.
//
// Supported URL shapes:
//   YouTube Shorts : https://www.youtube.com/shorts/<11 char id>
//   YouTube watch  : https://www.youtube.com/watch?v=<11 char id>
//   YouTube short  : https://youtu.be/<11 char id>
//   Instagram post : https://www.instagram.com/p/<shortcode>/
//   Instagram reel : https://www.instagram.com/reel/<shortcode>/
//
// Anything that does not match one of the five shapes above, or whose
// extracted ID fails format validation, returns null. The caller treats null
// as a 400 Bad Request — never a crash.

import { SocialPlatform } from '@repo/database';

// YouTube IDs are always 11 chars of [a-zA-Z0-9_-]. Reused from the same
// validation that guard-rails verifyIsShort() in youtube/analytics.ts.
const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

// Instagram shortcodes are undocumented by Instagram. We follow the
// conservative practice used elsewhere in the codebase (e.g. the campaign
// dashboard) and are permissive rather than reject a valid-looking code:
// alphanumeric, underscore, hyphen, length 5-15.
const INSTAGRAM_SHORTCODE_PATTERN = /^[a-zA-Z0-9_\-]{5,15}$/;

export type ContentUrlParsed = {
  platform: SocialPlatform;
  contentId: string;
};

/**
 * Parse a creator-submitted content URL into its platform and content ID.
 *
 * @param url - A raw URL from the request body (untrusted until parsed).
 * @returns The { platform, contentId } pair if the URL matches a supported
 *          shape and passes format validation; null otherwise.
 */
export function parseContentUrl(url: string): ContentUrlParsed | null {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  // --- YouTube -------------------------------------------------------------

  // https://www.youtube.com/shorts/<id>
  const shortsMatch = url.match(
    /^https:\/\/www\.youtube\.com\/shorts\/([a-zA-Z0-9_-]+)$/,
  );
  if (shortsMatch) {
    if (!YOUTUBE_VIDEO_ID_PATTERN.test(shortsMatch[1])) {
      return null;
    }
    return { platform: SocialPlatform.YOUTUBE, contentId: shortsMatch[1] };
  }

  // https://www.youtube.com/watch?v=<id> (any other query params ignored)
  const watchMatch = url.match(/^https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)(?:&|$)/);
  if (watchMatch) {
    if (!YOUTUBE_VIDEO_ID_PATTERN.test(watchMatch[1])) {
      return null;
    }
    return { platform: SocialPlatform.YOUTUBE, contentId: watchMatch[1] };
  }

  // https://youtu.be/<id>
  const youtuBeMatch = url.match(/^https:\/\/youtu\.be\/([a-zA-Z0-9_-]+)(?:\?|$)/);
  if (youtuBeMatch) {
    if (!YOUTUBE_VIDEO_ID_PATTERN.test(youtuBeMatch[1])) {
      return null;
    }
    return { platform: SocialPlatform.YOUTUBE, contentId: youtuBeMatch[1] };
  }

  // --- Instagram -----------------------------------------------------------

  // https://www.instagram.com/p/<shortcode>/
  const postMatch = url.match(/^https:\/\/www\.instagram\.com\/p\/([a-zA-Z0-9_\-]+)\/*$/);
  if (postMatch) {
    if (!INSTAGRAM_SHORTCODE_PATTERN.test(postMatch[1])) {
      return null;
    }
    return { platform: SocialPlatform.INSTAGRAM, contentId: postMatch[1] };
  }

  // https://www.instagram.com/reel/<shortcode>/
  const reelMatch = url.match(/^https:\/\/www\.instagram\.com\/reel\/([a-zA-Z0-9_\-]+)\/*$/);
  if (reelMatch) {
    if (!INSTAGRAM_SHORTCODE_PATTERN.test(reelMatch[1])) {
      return null;
    }
    return { platform: SocialPlatform.INSTAGRAM, contentId: reelMatch[1] };
  }

  // Nothing matched.
  return null;
}
