// apps/web/src/lib/youtube/data-api-urls.test.ts
//
// Unit tests for the Data API v3 URL builders in oauth.ts. They pin the
// requested URL shape, because a leading '/' in the path replaces the base's
// '/youtube/v3' segment and sends the request to an HTML 404.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must mock BEFORE importing the module under test
vi.mock('@/lib/oauth/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/oauth/request')>();
  return {
    ...actual,
    requestJson: vi.fn(),
  };
});

import { requestJson } from '@/lib/oauth/request';
import { fetchChannel, fetchVideoContentDetails } from './oauth';

const mockRequest = vi.mocked(requestJson);

const ACCESS_TOKEN = 'test-access-token';

function capturedRequest(): { url: URL; init: RequestInit } {
  const [rawUrl, init] = mockRequest.mock.calls[0];
  return { url: new URL(rawUrl), init: init ?? {} };
}

describe('YouTube Data API v3 URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetchChannel requests the channels endpoint under /youtube/v3', async () => {
    mockRequest.mockResolvedValueOnce({ items: [] });

    await fetchChannel(ACCESS_TOKEN);

    const { url, init } = capturedRequest();
    expect(url.host).toBe('www.googleapis.com');
    expect(url.pathname).toBe('/youtube/v3/channels');
    expect(url.searchParams.get('part')).toBe('snippet,contentDetails,statistics');
    expect(url.searchParams.get('mine')).toBe('true');
    expect(init.headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    expect(url.toString()).not.toContain(ACCESS_TOKEN);
  });

  it('fetchChannel returns null when the payload has no items', async () => {
    mockRequest.mockResolvedValueOnce({ items: [] });

    await expect(fetchChannel(ACCESS_TOKEN)).resolves.toBeNull();
  });

  it('fetchVideoContentDetails requests the videos endpoint under /youtube/v3', async () => {
    mockRequest.mockResolvedValueOnce({ items: [] });

    await fetchVideoContentDetails('dQw4w9WgXcQ', ACCESS_TOKEN);

    const { url, init } = capturedRequest();
    expect(url.host).toBe('www.googleapis.com');
    expect(url.pathname).toBe('/youtube/v3/videos');
    expect(init.headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}` });
  });

  it('fetchChannel parses statistics counters returned as strings', async () => {
    // The Data API v3 serializes these counters as decimal strings.
    mockRequest.mockResolvedValueOnce({
      items: [
        {
          id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
          snippet: { title: 'Example Channel' },
          statistics: {
            subscriberCount: '1234',
            videoCount: '56',
            viewCount: '789012',
          },
        },
      ],
    });

    await expect(fetchChannel(ACCESS_TOKEN)).resolves.toMatchObject({
      subscriberCount: 1234,
      videoCount: 56,
    });
  });

  it('fetchChannel maps a minimal channel item', async () => {
    mockRequest.mockResolvedValueOnce({
      items: [
        {
          id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
          snippet: { title: 'Example Channel' },
        },
      ],
    });

    await expect(fetchChannel(ACCESS_TOKEN)).resolves.toEqual({
      id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
      title: 'Example Channel',
      customUrl: null,
      duration: null,
      subscriberCount: null,
      videoCount: null,
    });
  });
});
