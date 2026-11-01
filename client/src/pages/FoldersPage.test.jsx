import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FoldersPage from './FoldersPage.jsx';

const mockLibrary = vi.hoisted(() => ({ value: {} }));
const mockLibraryApi = vi.hoisted(() => ({
  rootFolders: vi.fn(),
  folder: vi.fn(),
  classifyFolder: vi.fn(),
}));
vi.mock('../context/LibraryContext.jsx', () => ({ useLibrary: () => mockLibrary.value }));
vi.mock('../services/api.js', () => ({ libraryApi: mockLibraryApi }));

const rootFolder = {
  id: 'root-id',
  name: 'Movies',
  breadcrumbs: [{ id: 'root-id', name: 'Movies' }],
  children: [{ id: 'folder-id', name: 'My Show', classification: 'folder', folderCount: 0, movieCount: 2 }],
  movies: [],
  folderCount: 1,
  movieCount: 0,
};
const detailFolder = {
  id: 'folder-id',
  name: 'My Show',
  classification: 'folder',
  breadcrumbs: [{ id: 'root-id', name: 'Movies' }, { id: 'folder-id', name: 'My Show' }],
  children: [],
  movies: [],
  folderCount: 0,
  movieCount: 0,
};

function renderFolders(initialEntry = '/folders') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route path="/folders" element={<FoldersPage />} />
    <Route path="/folders/:id" element={<FoldersPage />} />
  </Routes></MemoryRouter>);
}

describe('folder browser', () => {
  beforeEach(() => {
    mockLibrary.value = { progress: {}, myList: [], toggleMyList: vi.fn(), reload: vi.fn().mockResolvedValue(undefined) };
    mockLibraryApi.rootFolders.mockResolvedValue({ folder: rootFolder });
    mockLibraryApi.folder.mockResolvedValue({ folder: detailFolder });
    mockLibraryApi.classifyFolder.mockResolvedValue({ classification: 'series' });
    window.prompt = vi.fn().mockReturnValue('https://images.example/show.jpg');
  });

  it('opens nested folders and allows manual series classification and artwork', async () => {
    renderFolders();
    fireEvent.click(await screen.findByRole('link', { name: /My Show/ }));
    expect(await screen.findByRole('heading', { name: 'My Show' })).toBeInTheDocument();

    mockLibraryApi.folder.mockResolvedValueOnce({ folder: { ...detailFolder, classification: 'series', seriesId: 'folder-id' } });
    fireEvent.change(screen.getByLabelText('Organize as'), { target: { value: 'series' } });
    await waitFor(() => expect(mockLibraryApi.classifyFolder).toHaveBeenCalledWith('folder-id', 'series'));
    expect(await screen.findByText(/Open series seasons and episodes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set artwork' }));
    await waitFor(() => expect(mockLibraryApi.classifyFolder).toHaveBeenCalledWith('folder-id', 'series', 'https://images.example/show.jpg'));
  });
});
