import { AlertTriangle, Check, FileUp, FolderSearch, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { organizerApi } from '../services/api.js';

const CLASSIFICATIONS = [
  ['movie', 'Movie'],
  ['tv_series', 'TV show'],
  ['season', 'Season'],
  ['episode', 'Episode'],
  ['subtitle', 'Subtitle'],
  ['artwork', 'Artwork'],
  ['metadata', 'Metadata'],
  ['other', 'Other'],
  ['unknown', 'Unknown'],
];

const FILTERS = [
  ['all', 'All items'],
  ...CLASSIFICATIONS.map(([value, label]) => [value, label]),
];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Stat({ label, value }) {
  return <div className="organizer-stat"><span>{label}</span><strong>{value ?? 0}</strong></div>;
}

export default function OrganizerPage() {
  const [overview, setOverview] = useState(null);
  const [scanId, setScanId] = useState(null);
  const [items, setItems] = useState([]);
  const [nextItemOffset, setNextItemOffset] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [nextProposalOffset, setNextProposalOffset] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('scan');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingItemId, setSavingItemId] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function loadScan(scan) {
    if (!scan) return;
    const [itemPage, proposalPage] = await Promise.all([
      organizerApi.scanDetail(scan, { classification: filter, search }),
      organizerApi.proposals(scan),
    ]);
    setScanId(scan);
    setItems(itemPage.items);
    setNextItemOffset(itemPage.nextOffset);
    setProposals(proposalPage.proposals);
    setNextProposalOffset(proposalPage.nextOffset);
  }

  async function loadMoreItems() {
    try {
      const page = await organizerApi.scanDetail(scanId, {
        offset: nextItemOffset,
        classification: filter,
        search,
      });
      setItems((previous) => [...previous, ...page.items]);
      setNextItemOffset(page.nextOffset);
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function loadMoreProposals() {
    try {
      const page = await organizerApi.proposals(scanId, { offset: nextProposalOffset });
      setProposals((previous) => [...previous, ...page.proposals]);
      setNextProposalOffset(page.nextOffset);
    } catch (cause) {
      setError(cause.message);
    }
  }

  useEffect(() => {
    let active = true;
    organizerApi.overview()
      .then(async (result) => {
        if (!active) return;
        setOverview(result);
        const latestScanId = result.latestScan?.scanId;
        if (latestScanId) {
          const [itemPage, proposalPage] = await Promise.all([
            organizerApi.scanDetail(latestScanId),
            organizerApi.proposals(latestScanId),
          ]);
          if (!active) return;
          setScanId(latestScanId);
          setItems(itemPage.items);
          setNextItemOffset(itemPage.nextOffset);
          setProposals(proposalPage.proposals);
          setNextProposalOffset(proposalPage.nextOffset);
        }
      })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!scanId) return undefined;
    let active = true;
    organizerApi.scanDetail(scanId, { classification: filter, search })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextItemOffset(page.nextOffset);
      })
      .catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [scanId, filter, search]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items.filter((item) => (filter === 'all' || item.classification === filter)
      && (!query || `${item.title ?? ''} ${item.name} ${item.relativePath}`.toLocaleLowerCase().includes(query)));
  }, [items, filter, search]);

  async function refreshOverview() {
    const result = await organizerApi.overview();
    setOverview(result);
    if (result.latestScan?.scanId) await loadScan(result.latestScan.scanId);
  }

  async function startScan() {
    setScanning(true);
    setError('');
    setMessage('');
    try {
      const summary = await organizerApi.scan();
      setOverview({ status: summary.status, latestScan: summary });
      await loadScan(summary.scanId);
      setView('scan');
      setMessage(summary.truncated
        ? 'Scan reached a safety limit. Partial results are available with warnings.'
        : 'Read-only scan completed.');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setScanning(false);
      refreshOverview().catch((cause) => setError(cause.message));
    }
  }

  async function importInventory(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !scanId) return;
    setImporting(true);
    setError('');
    setMessage('');
    try {
      const result = await organizerApi.importInventory(scanId, file);
      setOverview((previous) => previous ? {
        ...previous,
        latestScan: {
          ...previous.latestScan,
          inventory: result.inventory,
        },
      } : previous);
      setMessage(`Imported ${result.inventory?.recordCount ?? 0} reference records. No files were changed.`);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setImporting(false);
    }
  }

  async function correctClassification(item, classification) {
    setSavingItemId(item.id);
    setError('');
    try {
      const corrected = await organizerApi.updateItem(scanId, item.id, { classification });
      setItems((previous) => previous.map((entry) => entry.id === item.id ? corrected : entry));
      const page = await organizerApi.proposals(scanId);
      setProposals(page.proposals);
      setNextProposalOffset(page.nextOffset);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSavingItemId(null);
    }
  }

  async function updateReview(proposal, reviewStatus) {
    setError('');
    try {
      const updated = await organizerApi.updateProposal(proposal.id, { reviewStatus });
      setProposals((previous) => previous.map((entry) => entry.id === proposal.id ? updated : entry));
    } catch (cause) {
      setError(cause.message);
    }
  }

  const summary = overview?.latestScan;
  const confidence = summary?.confidence ?? {};
  const classifications = summary?.classifications ?? {};
  const inventory = summary?.inventory;

  if (loading) {
    return <main className="app-main"><div className="page-shell organizer-page"><div className="library-empty">Loading organizer overview…</div></div></main>;
  }

  return (
    <main className="app-main">
      <div className="page-shell organizer-page">
        <div className="organizer-heading">
          <div>
            <p className="eyebrow"><Sparkles size={14} /> LIBRARY ORGANIZER · FOUNDATION</p>
            <h1 className="page-title">Review your library</h1>
            <p className="page-subtitle">Deterministic local classification and read-only proposals. Nothing is moved or renamed.</p>
          </div>
          <button className="button button-primary" type="button" onClick={startScan} disabled={scanning}>
            <FolderSearch size={16} className={scanning ? 'spin-icon' : ''} />
            {scanning ? 'Scanning…' : 'Scan library'}
          </button>
        </div>

        <div className="organizer-safety-note"><ShieldCheck size={17} /><span>Scan and review only. Inventory reports are reference data; no file operation is available here.</span></div>
        {(error || message) && <div className={`organizer-feedback${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || message}</div>}

        <section className="organizer-summary" aria-label="Scan summary">
          <Stat label="Scanned items" value={summary?.itemCount} />
          <Stat label="Movies" value={classifications.movie} />
          <Stat label="TV episodes" value={classifications.episode} />
          <Stat label="Proposals" value={summary?.proposalCount} />
          <Stat label="High confidence" value={confidence.high} />
          <Stat label="Medium confidence" value={confidence.medium} />
          <Stat label="Low confidence" value={confidence.low} />
        </section>

        <section className="organizer-import-card">
          <div><h2><FileUp size={17} /> Compare an inventory report</h2><p>CSV or XLSX, up to 5 MB. Imported paths are validated and never authorize file changes.</p></div>
          <label className="button button-quiet organizer-upload">
            {importing ? 'Validating…' : 'Choose inventory'}
            <input type="file" accept=".csv,.xlsx" onChange={importInventory} disabled={importing || !scanId} />
          </label>
          {!scanId && <small>Run a scan before importing a comparison report.</small>}
          {inventory && <>
            <div className="organizer-import-result"><strong>{inventory.filename}</strong><span>{inventory.recordCount} records</span><span>{inventory.matchedCount} matched</span><span>{inventory.unmatchedCount} unmatched</span><span>{inventory.conflictCount} conflicts</span></div>
            {inventory.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
            {inventory.records?.filter((record) => record.match !== 'matched').slice(0, 25).map((record, index) => (
              <div className={`organizer-import-record is-${record.match}`} key={`${record.relativePath ?? record.name ?? 'record'}-${index}`}>
                <code>{record.relativePath ?? record.name ?? 'Record without a path'}</code>
                <span>{record.match}</span>
                {record.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
              </div>
            ))}
          </>}
        </section>

        <div className="organizer-tabs" role="tablist" aria-label="Organizer views">
          <button type="button" role="tab" aria-selected={view === 'scan'} className={view === 'scan' ? 'active' : ''} onClick={() => setView('scan')}>Scan results</button>
          <button type="button" role="tab" aria-selected={view === 'proposals'} className={view === 'proposals' ? 'active' : ''} onClick={() => setView('proposals')}>Proposed plan <span>{summary?.proposalCount ?? 0}</span></button>
        </div>

        {view === 'scan' ? (
          <section className="organizer-panel">
            <div className="organizer-toolbar">
              <label className="organizer-search">Search title or relative path
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search scanned items…" />
              </label>
              <label className="organizer-filter">Classification
                <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                  {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}{value !== 'all' ? ` (${classifications[value] ?? 0})` : ''}</option>)}
                </select>
              </label>
            </div>
            {!scanId && <div className="library-empty"><FolderSearch size={24} /><h2>No scan yet</h2><p>Start a read-only scan to classify media and build review proposals.</p></div>}
            {scanId && <div className="organizer-list">
              {visibleItems.map((item) => (
                <article className="organizer-item" key={item.id}>
                  <div className="organizer-item-main">
                    <div className="organizer-item-title"><strong>{item.title || item.name}</strong><span className={`confidence-badge confidence-${item.confidence}`}>{item.confidence}</span>{item.manualOverride && <span className="manual-badge">manual</span>}</div>
                    <code>{item.relativePath}</code>
                    <small>{item.evidence}{item.size !== null ? ` · ${formatBytes(item.size)}` : ''}{item.extension ? ` · ${item.extension}` : ''}</small>
                    {item.warnings.length > 0 && <span className="organizer-warning"><AlertTriangle size={13} /> {item.warnings.join(' ')}</span>}
                  </div>
                  <label className="organizer-classification">Classification
                    <select value={item.classification} disabled={savingItemId === item.id} onChange={(event) => correctClassification(item, event.target.value)}>
                      {CLASSIFICATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                </article>
              ))}
              {visibleItems.length === 0 && <div className="organizer-empty">No items match these filters on the loaded page.</div>}
            </div>}
            {nextItemOffset !== null && <button className="button button-quiet organizer-load-more" type="button" onClick={loadMoreItems}>Load more scanned items</button>}
          </section>
        ) : (
          <section className="organizer-panel">
            <p className="organizer-proposal-intro">Proposals use deterministic title/year and episode-number patterns. Check each source, destination, evidence, and warning before making any separate decision.</p>
            {!scanId && <div className="organizer-empty">Run a scan to generate proposals.</div>}
            {proposals.length === 0 && scanId && <div className="organizer-empty">No proposals are available.</div>}
            <div className="organizer-proposals">
              {proposals.map((proposal) => (
                <article className="organizer-proposal" key={proposal.id}>
                  <div className="proposal-path"><span>Source</span><code>{proposal.sourceRelativePath}</code></div>
                  <div className="proposal-arrow" aria-hidden="true">→</div>
                  <div className="proposal-path"><span>Proposed destination</span><code>{proposal.proposedDestinationRelativePath || 'No safe automatic proposal'}</code></div>
                  <div className="proposal-details"><span className={`proposal-status status-${proposal.status}`}>{proposal.status}</span><span>{proposal.confidence} confidence</span><span>{proposal.evidence}</span>{proposal.warnings.map((warning) => <small key={warning}><AlertTriangle size={12} /> {warning}</small>)}</div>
                  <label className="proposal-review">Review status
                    <select value={proposal.reviewStatus} onChange={(event) => updateReview(proposal, event.target.value)}>
                      <option value="pending">Pending</option><option value="reviewed">Reviewed</option><option value="deferred">Deferred</option>
                    </select>
                  </label>
                </article>
              ))}
            </div>
            {nextProposalOffset !== null && <button className="button button-quiet organizer-load-more" type="button" onClick={loadMoreProposals}>Load more proposals</button>}
          </section>
        )}
        {summary && <p className="organizer-scan-meta"><Check size={14} /> Last scan {new Date(summary.scannedAt).toLocaleString()} · {summary.status}{summary.truncated ? ' · partial results' : ''}</p>}
      </div>
    </main>
  );
}
