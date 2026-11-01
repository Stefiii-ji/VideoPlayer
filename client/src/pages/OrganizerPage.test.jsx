import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizerPage from './OrganizerPage.jsx';
import { organizerApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  organizerApi: {
    overview: vi.fn(),
    scan: vi.fn(),
    scanDetail: vi.fn(),
    proposals: vi.fn(),
    updateItem: vi.fn(),
    importInventory: vi.fn(),
    updateProposal: vi.fn(),
  },
}));

const scannedItem = {
  id: 'item-1',
  name: 'Arrival.2016.mkv',
  title: 'Arrival',
  relativePath: 'Arrival.2016.mkv',
  extension: '.mkv',
  size: 12,
  classification: 'movie',
  detectedClassification: 'movie',
  confidence: 'high',
  evidence: 'Video filename contains a title and release year.',
  warnings: [],
  manualOverride: null,
};

const proposal = {
  id: 'proposal-1',
  sourceId: 'item-1',
  sourceRelativePath: 'Arrival.2016.mkv',
  proposedDestinationRelativePath: 'Movies/Arrival (2016)/Arrival (2016).mkv',
  classification: 'movie',
  confidence: 'high',
  evidence: 'Video filename contains a title and release year.',
  warnings: [],
  status: 'ready',
  reviewStatus: 'pending',
};

describe('OrganizerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    organizerApi.overview.mockResolvedValue({ status: 'not_scanned', latestScan: null });
    organizerApi.scan.mockResolvedValue({
      scanId: 'scan-1',
      status: 'completed',
      scannedAt: '2025-01-01T00:00:00.000Z',
      itemCount: 1,
      proposalCount: 1,
      confidence: { high: 1, medium: 0, low: 0 },
      classifications: { movie: 1 },
      truncated: false,
    });
    organizerApi.scanDetail.mockResolvedValue({ items: [scannedItem], nextOffset: null });
    organizerApi.proposals.mockResolvedValue({ proposals: [proposal], nextOffset: null });
    organizerApi.updateItem.mockResolvedValue({
      ...scannedItem,
      classification: 'unknown',
      detectedClassification: 'movie',
      manualOverride: { classification: 'unknown' },
    });
    organizerApi.importInventory.mockResolvedValue({
      inventory: { filename: 'MovieInventory.csv', recordCount: 1, matchedCount: 1, unmatchedCount: 0, conflictCount: 0 },
    });
  });

  it('starts a read-only scan and displays detected records and proposal destinations', async () => {
    render(<OrganizerPage />);
    fireEvent.click(await screen.findByRole('button', { name: /scan library/i }));
    expect(await screen.findByText('Read-only scan completed.')).toBeInTheDocument();
    expect(screen.getByText('Arrival.2016.mkv')).toBeInTheDocument();
    expect(screen.getByText(/Video filename contains a title and release year/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /proposed plan/i }));
    expect(await screen.findByText('Movies/Arrival (2016)/Arrival (2016).mkv')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is moved or renamed/i)).toBeInTheDocument();
  });

  it('sends manual classification corrections and displays import feedback', async () => {
    render(<OrganizerPage />);
    fireEvent.click(await screen.findByRole('button', { name: /scan library/i }));
    await screen.findByText('Arrival.2016.mkv');
    const classification = screen.getAllByLabelText('Classification').find((select) => select.value === 'movie');
    fireEvent.change(classification, { target: { value: 'unknown' } });
    await waitFor(() => expect(organizerApi.updateItem).toHaveBeenCalledWith('scan-1', 'item-1', { classification: 'unknown' }));

    const file = new File(['Name,RelativePath'], 'MovieInventory.csv', { type: 'text/csv' });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
    expect(await screen.findByText('Imported 1 reference records. No files were changed.')).toBeInTheDocument();
  });

  it('renders API errors without hiding the organizer status', async () => {
    organizerApi.overview.mockRejectedValueOnce(new Error('Organizer unavailable.'));
    render(<OrganizerPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Organizer unavailable.');
  });
});
