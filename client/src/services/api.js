const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

function playbackUrl(url) {
  if (!url || /^https?:\/\//i.test(url)) return url;
  const base = API_BASE.replace(/\/$/, '');
  if (url.startsWith('/api/')) return `${base}${url.slice(4)}`;
  return `${base}${url.startsWith('/') ? url : `/${url}`}`;
}

async function request(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const details = body && typeof body === 'object' ? body : {};
    throw Object.assign(new Error(details.error || `Request failed (${response.status}).`), {
      code: details.code,
      status: response.status,
      details,
    });
  }
  if (response.status === 204) return null;
  return response.json();
}

export const movieApi = {
  list: () => request('/movies'),
  refresh: () => request('/movies/refresh', { method: 'POST' }),
  detail: (id) => request(`/movies/${encodeURIComponent(id)}`),
  metadata: (id) => request(`/movies/${encodeURIComponent(id)}/metadata`),
  playback: async (id, { capabilities, fallback = false, requestKey, audioStreamIndex, signal } = {}) => {
    const result = await request(`/movies/${encodeURIComponent(id)}/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities, fallback, requestKey, audioStreamIndex }),
      signal,
    });
    return { ...result, url: playbackUrl(result.url), fallbackUrl: playbackUrl(result.fallbackUrl) };
  },
  subtitles: (id) => request(`/movies/${encodeURIComponent(id)}/subtitles`),
  subtitleUrl: (id, subtitleId) =>
    `${API_BASE}/movies/${encodeURIComponent(id)}/subtitles/${encodeURIComponent(subtitleId)}.vtt`,
  stopPlayback: (id, sessionId) =>
    request(`/movies/${encodeURIComponent(id)}/playback-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      keepalive: true,
    }),
  touchPlayback: (id, sessionId) =>
    request(`/movies/${encodeURIComponent(id)}/playback-sessions/${encodeURIComponent(sessionId)}`),
  streamUrl: (id, { transcode = false, start = 0 } = {}) =>
    transcode
      ? `${API_BASE}/movies/${encodeURIComponent(id)}/transcode?start=${Math.floor(start)}`
      : `${API_BASE}/movies/${encodeURIComponent(id)}/stream`,
};

export const libraryApi = {
  overview: () => request('/library'),
  rootFolders: () => request('/library/folders'),
  folder: (id) => request(`/library/folders/${encodeURIComponent(id)}`),
  classifyFolder: (id, type, artworkUrl) => request(`/library/folders/${encodeURIComponent(id)}/classification`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, artworkUrl }),
  }),
  series: () => request('/library/series'),
  seriesDetail: (id) => request(`/library/series/${encodeURIComponent(id)}`),
  season: (id, season) => request(`/library/series/${encodeURIComponent(id)}/seasons/${season}`),
  collections: () => request('/library/collections'),
  createCollection: (collection) => request('/library/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collection),
  }),
  updateCollection: (id, collection) => request(`/library/collections/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collection),
  }),
  deleteCollection: (id) => request(`/library/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  saveProgress: (id, positionSeconds, durationSeconds) => request(`/library/progress/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positionSeconds, durationSeconds }),
  }),
};

export const organizerApi = {
  overview: () => request('/organizer/overview'),
  scan: () => request('/organizer/scan', { method: 'POST' }),
  scanDetail: (scanId, { offset = 0, limit = 100, classification, search } = {}) => {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (classification && classification !== 'all') query.set('classification', classification);
    if (search?.trim()) query.set('search', search.trim());
    return request(`/organizer/scan/${encodeURIComponent(scanId)}?${query}`);
  },
  proposals: (scanId, { offset = 0, limit = 100 } = {}) =>
    request(`/organizer/proposals?scanId=${encodeURIComponent(scanId)}&offset=${offset}&limit=${limit}`),
  updateItem: (scanId, itemId, correction) => request(
    `/organizer/scan/${encodeURIComponent(scanId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(correction),
    },
  ),
  importInventory: async (scanId, file) => {
    const query = new URLSearchParams({ scanId, filename: file.name });
    const response = await fetch(`${API_BASE}/organizer/import?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || `Request failed (${response.status}).`), {
        code: body.code,
        status: response.status,
        details: body,
      });
    }
    return response.json();
  },
  updateProposal: (id, update) => request(`/organizer/proposals/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }),
};
