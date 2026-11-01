import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchPage from './SearchPage.jsx';

const mockLibrary = vi.hoisted(() => ({ value: {} }));
vi.mock('../context/LibraryContext.jsx', () => ({ useLibrary: () => mockLibrary.value }));

describe('SearchPage', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockLibrary.value = {
      movies: [
        { id: 'one', title: 'Moonlit Road', extension: '.mp4', size: 10, releaseYear: 2024 },
        { id: 'two', title: 'Quiet Harbor', extension: '.mkv', size: 20 },
      ],
      loading: false,
      metadata: { two: { genres: ['Drama'] } },
      progress: {},
      myList: [],
      toggleMyList: vi.fn(),
    };
  });

  function renderSearch(query) {
    return render(<MemoryRouter initialEntries={[`/search?q=${encodeURIComponent(query)}`]}>
      <Routes><Route path="/search" element={<SearchPage />} /></Routes>
    </MemoryRouter>);
  }

  it('searches local titles and release years', () => {
    renderSearch('2024');
    expect(screen.getByRole('link', { name: 'View Moonlit Road' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View Quiet Harbor' })).not.toBeInTheDocument();
  });

  it('searches genres in cached available metadata', () => {
    renderSearch('drama');
    expect(screen.getByRole('link', { name: 'View Quiet Harbor' })).toBeInTheDocument();
  });

  it('shows a prompt instead of listing every movie for an empty query', () => {
    renderSearch('');
    expect(screen.getByRole('heading', { name: 'Enter a search to get started' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View Moonlit Road' })).not.toBeInTheDocument();
  });
});
