// apps/web/src/lib/oauth/connect-start-failure.test.ts
//
// Unit tests for the configuration-failure response used by both connect start
// routes. They pin the relative Location, the fixed query shape, the absence
// of cookies and any environment access.

import { describe, expect, it } from 'vitest';

import { connectStartFailureResponse } from './connect-start-failure';

describe('connectStartFailureResponse', () => {
  it('youtube: 303 to the accounts page with youtube=error&reason=unexpected', () => {
    const response = connectStartFailureResponse({
      platform: 'youtube',
      returnPath: '/creator/accounts',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/creator/accounts?youtube=error&reason=unexpected',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.body).toBeNull();
  });

  it('instagram: 303 to the accounts page with instagram=error&reason=unexpected', () => {
    const response = connectStartFailureResponse({
      platform: 'instagram',
      returnPath: '/creator/accounts',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/creator/accounts?instagram=error&reason=unexpected',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.body).toBeNull();
  });

  it.each([
    '//evil.example',
    'https://evil.example/x',
    '/a b',
    '/a\\b',
    '',
    'creator/accounts',
  ])('unsafe returnPath %j falls back to the site root', (returnPath) => {
    const response = connectStartFailureResponse({
      platform: 'youtube',
      returnPath,
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/?youtube=error&reason=unexpected',
    );
  });

  it('reads no environment: works with both redirect URIs deleted', () => {
    const youtubeRedirect = process.env.YOUTUBE_REDIRECT_URI;
    const instagramRedirect = process.env.INSTAGRAM_REDIRECT_URI;
    delete process.env.YOUTUBE_REDIRECT_URI;
    delete process.env.INSTAGRAM_REDIRECT_URI;

    try {
      const response = connectStartFailureResponse({
        platform: 'youtube',
        returnPath: '/creator/accounts',
      });
      expect(response.headers.get('location')).toBe(
        '/creator/accounts?youtube=error&reason=unexpected',
      );
    } finally {
      if (youtubeRedirect !== undefined) {
        process.env.YOUTUBE_REDIRECT_URI = youtubeRedirect;
      }
      if (instagramRedirect !== undefined) {
        process.env.INSTAGRAM_REDIRECT_URI = instagramRedirect;
      }
    }
  });
});
