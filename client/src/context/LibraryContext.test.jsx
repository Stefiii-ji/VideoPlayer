import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { LibraryProvider, useLibrary } from './LibraryContext.jsx';

const mockMovieApi = vi.hoisted(() => ({ list: vi.fn(), refresh: vi.fn(), metadata: vi.fn() }));
const mockLibraryApi = vi.hoisted(() => ({ overview: vi.fn(), saveProgress: vi.fn() }));
vi.mock('../services/api.js', () => ({ movieApi: mockMovieApi, libraryApi: mockLibraryApi }));

function ListControls() {
  const { myList, toggleMyList } = useLibrary();
  return (
    <div>
      <output>{myList.join(',')}</output>
      <button onClick={() => toggleMyList('film-1')}>toggle saved film</button>
    </div>
  );
}

function ProgressControls() {
  const { saveProgress } = useLibrary();
  return (
    <div>
      <button onClick={() => saveProgress('film-1', 22, 45)}>record playback time</button>
      <button onClick={() => saveProgress('film-1', 22, 45, true)}>force-save playback time</button>
    </div>
  );
}

function MetadataControls() {
  const { loadMetadata, metadata } = useLibrary();
  const initialLoadMetadata = useRef(loadMetadata);
  const [result, setResult] = useState('pending');
  return (
    <div>
      <output data-testid="stable-load-metadata">{String(initialLoadMetadata.current === loadMetadata)}</output>
      <output data-testid="metadata-result">{result}</output>
      <output data-testid="metadata-cache">{JSON.stringify(metadata)}</output>
      <button onClick={async () => setResult(JSON.stringify(await loadMetadata('film-1')))}>load metadata</button>
      <button onClick={async () => setResult(JSON.stringify(await loadMetadata('film-new')))}>load new metadata</button>
    </div>
  );
}

describe('LibraryProvider watchlist', () => {
  beforeEach(() => {
    localStorage.clear();
    mockLibraryApi.saveProgress.mockReset().mockResolvedValue(null);
    mockMovieApi.metadata.mockReset();
    mockLibraryApi.overview.mockResolvedValue({
      movies: [], folders: [], series: [], collections: [], watchProgress: {}, scannedAt: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('adds and removes titles and persists My List locally', async () => {
    render(<LibraryProvider><ListControls /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'toggle saved film' }));
    await waitFor(() => expect(screen.getByText('film-1')).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem('moviestream-my-list'))).toEqual(['film-1']);

    fireEvent.click(screen.getByRole('button', { name: 'toggle saved film' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement());
    expect(JSON.parse(localStorage.getItem('moviestream-my-list'))).toEqual([]);
  });

  it('persists a forced pause position after a recent local progress update', async () => {
    render(<LibraryProvider><ProgressControls /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'record playback time' }));
    expect(mockLibraryApi.saveProgress).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'force-save playback time' }));
    await waitFor(() => expect(mockLibraryApi.saveProgress).toHaveBeenCalledOnce());
    expect(mockLibraryApi.saveProgress).toHaveBeenCalledWith('film-1', 22, 45);
  });

  it('continues rendering when localStorage reads or writes throw', async () => {
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function getItem(key) {
      if (key === 'moviestream-my-list') throw new Error('Storage unavailable');
      return originalGetItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(key, value) {
      if (key === 'moviestream-my-list') throw new Error('Storage unavailable');
      return originalSetItem.call(this, key, value);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<LibraryProvider><ListControls /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'toggle saved film' }));
    expect(await screen.findByText('film-1')).toBeInTheDocument();
  });

  it('keeps loadMetadata stable after metadata state changes', async () => {
    mockMovieApi.metadata.mockResolvedValue({ metadata: { description: 'A cached film' } });
    render(<LibraryProvider><MetadataControls /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'load metadata' }));
    await waitFor(() => expect(screen.getByTestId('metadata-cache')).toHaveTextContent('A cached film'));
    expect(screen.getByTestId('stable-load-metadata')).toHaveTextContent('true');
  });

  it('returns null after metadata failures and retries after the cooldown', async () => {
    const originalNow = Date.now;
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockMovieApi.metadata
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ metadata: { description: 'Recovered' } });
    render(<LibraryProvider><MetadataControls /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'load metadata' }));
    await waitFor(() => expect(screen.getByTestId('metadata-result')).toHaveTextContent('null'));
    fireEvent.click(screen.getByRole('button', { name: 'load metadata' }));
    await act(async () => {});
    expect(mockMovieApi.metadata).toHaveBeenCalledOnce();

    now = originalNow() + 60_001;
    fireEvent.click(screen.getByRole('button', { name: 'load metadata' }));
    await waitFor(() => expect(screen.getByTestId('metadata-cache')).toHaveTextContent('Recovered'));
    expect(mockMovieApi.metadata).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest metadata entries when the cache exceeds 500 entries', async () => {
    const now = Date.now();
    const stored = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
      `film-${index}`,
      { value: { description: `Film ${index}` }, updatedAt: now - 500 + index },
    ]));
    localStorage.setItem('moviestream-metadata', JSON.stringify(stored));
    mockMovieApi.metadata.mockResolvedValue({ metadata: { description: 'Newest film' } });
    render(<LibraryProvider><MetadataControls /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'load new metadata' }));
    await waitFor(() => {
      const cache = JSON.parse(localStorage.getItem('moviestream-metadata'));
      expect(Object.keys(cache)).toHaveLength(500);
      expect(cache['film-0']).toBeUndefined();
      expect(cache['film-1']).toBeDefined();
      expect(cache['film-1'].value.description).toBe('Film 1');
      expect(cache['film-1'].updatedAt).toEqual(expect.any(Number));
    });
    expect(JSON.parse(localStorage.getItem('moviestream-metadata'))['film-1'].value.description).toBe('Film 1');
  });

  it('drops cached metadata after a quota error while continuing to render', async () => {
    localStorage.setItem('moviestream-metadata', JSON.stringify({
      'cached-film': { value: { description: 'Cached' }, updatedAt: Date.now() },
    }));
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(key, value) {
      if (key === 'moviestream-metadata') {
        throw Object.assign(new Error('Storage quota exceeded'), { name: 'QuotaExceededError' });
      }
      return originalSetItem.call(this, key, value);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<LibraryProvider><MetadataControls /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('metadata-cache')).toHaveTextContent('{}'));
    expect(localStorage.getItem('moviestream-metadata')).toBeNull();
  });

  it('keeps the newer local progress and only applies newer server progress', async () => {
    localStorage.setItem('moviestream-watch-progress', JSON.stringify({
      'local-newer': { currentTime: 70, duration: 100, updatedAt: 2_000 },
      'completed-local-newer': { currentTime: 50, duration: 100, updatedAt: 2_000 },
      'server-newer': { currentTime: 20, duration: 100, updatedAt: 1_000 },
    }));
    mockLibraryApi.overview.mockResolvedValue({
      movies: [], folders: [], series: [], collections: [], scannedAt: null,
      watchProgress: {
        'local-newer': { positionSeconds: 30, durationSeconds: 100, completed: false, updatedAt: new Date(1_000).toISOString() },
        'completed-local-newer': { positionSeconds: 100, durationSeconds: 100, completed: true, updatedAt: new Date(1_500).toISOString() },
        'server-newer': { positionSeconds: 40, durationSeconds: 100, completed: false, updatedAt: new Date(3_000).toISOString() },
        'server-completed-newer': { positionSeconds: 100, durationSeconds: 100, completed: true, updatedAt: new Date(4_000).toISOString() },
      },
    });
    function ProgressOutput() {
      const { progress } = useLibrary();
      return <output data-testid="merged-progress">{JSON.stringify(progress)}</output>;
    }

    render(<LibraryProvider><ProgressOutput /></LibraryProvider>);
    await waitFor(() => expect(mockLibraryApi.overview).toHaveBeenCalledOnce());
    await waitFor(() => {
      const merged = JSON.parse(screen.getByTestId('merged-progress').textContent);
      expect(merged['local-newer'].currentTime).toBe(70);
      expect(merged['completed-local-newer'].currentTime).toBe(50);
      expect(merged['server-newer'].currentTime).toBe(40);
      expect(merged['server-completed-newer']).toBeNull();
    });
  });
});
