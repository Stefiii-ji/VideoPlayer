import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from './HomePage.jsx';

const mockLibrary = vi.hoisted(() => ({ value: {} }));
vi.mock('../context/LibraryContext.jsx', () => ({ useLibrary: () => mockLibrary.value }));

describe('HomePage library states', () => {
  beforeEach(() => {
    mockLibrary.value = {
      movies: [], loading: true, error: '', progress: {}, reload: vi.fn(), scannedAt: null,
    };
  });

  it('shows loading placeholders while the library is being fetched', () => {
    const { container } = render(<HomePage query="" />);
    expect(container.querySelector('.hero-skeleton')).toBeInTheDocument();
    expect(container.querySelectorAll('.poster-skeleton')).toHaveLength(4);
  });

  it('shows a useful error and retry action when the server is unavailable', () => {
    const retry = vi.fn();
    mockLibrary.value = { ...mockLibrary.value, loading: false, error: 'Server unavailable', reload: retry };
    render(<HomePage query="" />);
    expect(screen.getByText("We couldn't reach your library.")).toBeInTheDocument();
    expect(screen.getByText(/Server unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('offers to scan the folder when the collection is empty', () => {
    const reload = vi.fn();
    mockLibrary.value = { ...mockLibrary.value, loading: false, reload };
    render(<HomePage query="" />);
    expect(screen.queryByText(/F:\\Movies/)).not.toBeInTheDocument();
    expect(screen.getByText(/configured movie folder/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /scan movie folder/i }));
    expect(reload).toHaveBeenCalledWith(true);
  });
});
