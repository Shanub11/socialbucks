// apps/web/src/lib/youtube/video-ownership.test.ts
//
// Unit tests for fetchVideoChannel — mocks the HTTP layer (requestJsonWithHeaders)
// to verify request shape, response parsing, and error handling without network calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OAuthHttpError } from '@/lib/oauth/request';

// Must mock BEFORE importing the module under test
vi.mock('@/lib/oauth/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/oauth/request')>();
  return {
    ...actual,
    requestJsonWithHeaders: vi.fn(),
  };
});

vi.mock('@/lib/youtube/constants', () => ({
  YOUTUBE_DATA_API_BASE: 'https://www.googleapis.com/youtube/v3',
}));

import { requestJsonWithHeaders } from '@/lib/oauth/request';
import { fetchVideoChannel } from './video-ownership';

const mockRequest = vi.mocked(requestJsonWithHeaders);

describe('fetchVideoChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // --------------------------------------------------------------------------
  // Input validation
  // --------------------------------------------------------------------------

  it('rejects invalid videoId format (too short) before any HTTP call', async () => {
    await expect(fetchVideoChannel('short', 'access-token')).rejects.toThrow(OAuthHttpError);
    await expect(fetchVideoChannel('short', 'access-token')).rejects.toMatchObject({ status: 400 });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid videoId format (bad characters) before any HTTP call', async () => {
    await expect(fetchVideoChannel('invalid/chars!', 'access-token')).rejects.toThrow(OAuthHttpError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid videoId format (empty string) before any HTTP call', async () => {
    await expect(fetchVideoChannel('', 'access-token')).rejects.toThrow(OAuthHttpError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid videoId format (12 chars) before any HTTP call', async () => {
    await expect(fetchVideoChannel('dQw4w9WgXcQQ', 'access-token')).rejects.toThrow(OAuthHttpError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Happy path: valid response with matching channel
  // --------------------------------------------------------------------------

  it('returns { found: true, channelId } for a well-formed matching response', async () => {
    const videoId = 'dQw4w9WgXcQ';
    const channelId = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

    mockRequest.mockResolvedValueOnce({
      body: {
        items: [
          {
            id: videoId,
            snippet: { channelId },
          },
        ],
      },
      headers: new Headers(),
      status: 200,
    });

    const result = await fetchVideoChannel(videoId, 'valid-access-token');

    expect(result).toEqual({ found: true, channelId });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('requests the correct URL with part=snippet and id=videoId', async () => {
    const videoId = 'dQw4w9WgXcQ';
    const channelId = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

    mockRequest.mockResolvedValueOnce({
      body: { items: [{ id: videoId, snippet: { channelId } }] },
      headers: new Headers(),
      status: 200,
    });

    await fetchVideoChannel(videoId, 'valid-access-token');

    const callArgs = mockRequest.mock.calls[0];
    const url = callArgs[0] as string;
    expect(url).toBe('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=dQw4w9WgXcQ');

    const init = callArgs[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: 'Bearer valid-access-token' });
    // Token must NOT appear in URL
    expect(url).not.toContain('valid-access-token');
  });

  it('token appears ONLY in Authorization header, never in URL', async () => {
    const videoId = 'dQw4w9WgXcQ';
    const token = 'secret-access-token-123';

    mockRequest.mockResolvedValueOnce({
      body: { items: [{ id: videoId, snippet: { channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' } }] },
      headers: new Headers(),
      status: 200,
    });

    await fetchVideoChannel(videoId, token);

    const init = mockRequest.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-access-token-123');
    // Ensure the URL doesn't contain the token
    expect(mockRequest.mock.calls[0][0]).not.toContain(token);
  });

  // --------------------------------------------------------------------------
  // Video not found / mismatched ID
  // --------------------------------------------------------------------------

  it('returns { found: false } when items array is empty', async () => {
    mockRequest.mockResolvedValueOnce({
      body: { items: [] },
      headers: new Headers(),
      status: 200,
    });

    const result = await fetchVideoChannel('dQw4w9WgXcQ', 'access-token');

    expect(result).toEqual({ found: false });
  });

  it('returns { found: false } when returned item.id differs from requested videoId', async () => {
    mockRequest.mockResolvedValueOnce({
      body: {
        items: [
          {
            id: 'differentVideoId123',
            snippet: { channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' },
          },
        ],
      },
      headers: new Headers(),
      status: 200,
    });

    const result = await fetchVideoChannel('dQw4w9WgXcQ', 'access-token');

    expect(result).toEqual({ found: false });
  });

  // --------------------------------------------------------------------------
  // Malformed response body
  // --------------------------------------------------------------------------

  it('rejects when snippet is missing from response', async () => {
    mockRequest.mockResolvedValueOnce({
      body: { items: [{ id: 'dQw4w9WgXcQ' }] }, // missing snippet
      headers: new Headers(),
      status: 200,
    });

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow(OAuthHttpError);
  });

  it('rejects when channelId has invalid format', async () => {
    mockRequest.mockResolvedValueOnce({
      body: { items: [{ id: 'dQw4w9WgXcQ', snippet: { channelId: 'not-a-valid-channel-id' } }] },
      headers: new Headers(),
      status: 200,
    });

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow(OAuthHttpError);
  });

  it('rejects when channelId is missing', async () => {
    mockRequest.mockResolvedValueOnce({
      body: { items: [{ id: 'dQw4w9WgXcQ', snippet: {} }] },
      headers: new Headers(),
      status: 200,
    });

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow(OAuthHttpError);
  });

  // --------------------------------------------------------------------------
  // API error responses (Google error envelope)
  // --------------------------------------------------------------------------

  it('rejects with OAuthHttpError on 403 with error envelope', async () => {
    mockRequest.mockResolvedValueOnce({
      body: {
        error: {
          errors: [{ reason: 'quotaExceeded' }],
          code: 403,
          message: 'Quota exceeded',
        },
      },
      headers: new Headers(),
      status: 403,
    });

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow(OAuthHttpError);
  });

  it('rejects with OAuthHttpError on 400 with invalid parameter error', async () => {
    mockRequest.mockResolvedValueOnce({
      body: {
        error: {
          errors: [{ reason: 'invalidParameter', message: 'Invalid parameter' }],
          code: 400,
          message: 'Invalid parameter',
        },
      },
      headers: new Headers(),
      status: 400,
    });

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow(OAuthHttpError);
  });

  // --------------------------------------------------------------------------
  // Network / timeout errors
  // --------------------------------------------------------------------------

  it('rejects with OAuthHttpError on network failure (thrown by requestJsonWithHeaders)', async () => {
    mockRequest.mockRejectedValueOnce(new OAuthHttpError('Provider request failed to connect'));

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow(OAuthHttpError);
  });

  it('rejects with OAuthHttpError on timeout (thrown by requestJsonWithHeaders)', async () => {
    mockRequest.mockRejectedValueOnce(new OAuthHttpError('Provider request timed out'));

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow(OAuthHttpError);
  });

  // --------------------------------------------------------------------------
  // Single attempt — no internal retry
  // --------------------------------------------------------------------------

  it('makes exactly one HTTP call (no internal retry on error)', async () => {
    mockRequest.mockRejectedValueOnce(new OAuthHttpError('Network error'));

    await expect(fetchVideoChannel('dQw4w9WgXcQ', 'access-token')).rejects.toThrow();

    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});