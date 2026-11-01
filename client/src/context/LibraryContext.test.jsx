import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('LibraryProvider watchlist', () => {
  beforeEach(() => {
    localStorage.clear();
    mockLibraryApi.saveProgress.mockReset().mockResolvedValue(null);
    mockLibraryApi.overview.mockResolvedValue({
      movies: [], folders: [], series: [], collections: [], watchProgress: {}, scannedAt: null,
    });
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
});
