// apps/web/src/lib/campaigns/parse-content-url.test.ts
//
// Pure-function unit tests for parseContentUrl(). No DB, no network — these
// run without RUN_DB_TESTS=1 so they provide fast feedback in a normal
// vitest run alongside the real-DB route tests.

import { describe, it, expect } from 'vitest';
import { SocialPlatform } from '@repo/database';
import { parseContentUrl } from './parse-content-url';

describe('parseContentUrl', () => {
  // --- YouTube -------------------------------------------------------------

  it('parses YouTube Shorts URL', () => {
    const result = parseContentUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(result).toEqual({
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    });
  });

  it('parses YouTube watch URL with only v param', () => {
    const result = parseContentUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result).toEqual({
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    });
  });

  it('parses YouTube watch URL ignoring extra query params', () => {
    const result = parseContentUrl(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmEvdaa1CUCI3Ixau4f9HX_YSdKuK',
    );
    expect(result).toEqual({
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    });
  });

  it('parses YouTube short link youtu.be', () => {
    const result = parseContentUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(result).toEqual({
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    });
  });

  it('parses YouTube short link youtu.be with query param', () => {
    const result = parseContentUrl('https://youtu.be/dQw4w9WgXcQ?t=42');
    expect(result).toEqual({
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    });
  });

  // --- Instagram -----------------------------------------------------------

  it('parses Instagram post URL', () => {
    const result = parseContentUrl(
      'https://www.instagram.com/p/C8q1xL9sK7a/',
    );
    expect(result).toEqual({
      platform: SocialPlatform.INSTAGRAM,
      contentId: 'C8q1xL9sK7a',
    });
  });

  it('parses Instagram reel URL', () => {
    const result = parseContentUrl(
      'https://www.instagram.com/reel/C8q1xL9sK7a/',
    );
    expect(result).toEqual({
      platform: SocialPlatform.INSTAGRAM,
      contentId: 'C8q1xL9sK7a',
    });
  });

  it('parses Instagram post URL with trailing slash stripped', () => {
    const result = parseContentUrl(
      'https://www.instagram.com/p/C8q1xL9sK7a',
    );
    expect(result).toEqual({
      platform: SocialPlatform.INSTAGRAM,
      contentId: 'C8q1xL9sK7a',
    });
  });

  it('parses Instagram shortcode with underscores and hyphens', () => {
    const result = parseContentUrl(
      'https://www.instagram.com/reel/abc_123-def/',
    );
    expect(result).toEqual({
      platform: SocialPlatform.INSTAGRAM,
      contentId: 'abc_123-def',
    });
  });

  // --- Invalid URLs --------------------------------------------------------

  it('returns null for a TikTok URL (unsupported platform)', () => {
    expect(
      parseContentUrl('https://www.tiktok.com/@user/video/1234567890'),
    ).toBeNull();
  });

  it('returns null for a malformed YouTube URL with 10-char ID', () => {
    // Exactly 10 chars — YouTube IDs must be 11.
    expect(parseContentUrl('https://www.youtube.com/watch?v=dQw4w9WgX')).toBeNull();
  });

  it('returns null for a YouTube URL with 12-char ID', () => {
    expect(
      parseContentUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ12'),
    ).toBeNull();
  });

  it('returns null for an Instagram shortcode that is too short (4 chars)', () => {
    expect(
      parseContentUrl('https://www.instagram.com/p/abcd/'),
    ).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseContentUrl('')).toBeNull();
  });

  it('returns null for a URL that is not a string-like match (random domain)', () => {
    expect(parseContentUrl('https://example.com/foo/bar')).toBeNull();
  });

  it('returns null for a YouTube shorts URL with invalid ID chars', () => {
    // Contains space inside ID — pattern is greedy capture of path chars,
    // but the ID regex will reject the non-alphanumeric-hyphen-underscore chars.
    expect(
      parseContentUrl('https://www.youtube.com/shorts/invalid id here'),
    ).toBeNull();
  });
});
