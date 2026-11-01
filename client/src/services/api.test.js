import { afterEach, describe, expect, it, vi } from 'vitest';
import { movieApi } from './api.js';

describe('movieApi playback cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps session cleanup requests alive when the page unloads', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetch);

    await movieApi.stopPlayback('movie-id', 'session-id');

    expect(fetch).toHaveBeenCalledWith('/api/movies/movie-id/playback-sessions/session-id', {
      method: 'DELETE',
      keepalive: true,
    });
  });
});
