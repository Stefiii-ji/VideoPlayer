import { ArrowDownUp, ChevronLeft, FolderOpen, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import BreadcrumbNavigation from '../components/BreadcrumbNavigation.jsx';
import FolderCard from '../components/FolderCard.jsx';
import MovieCard from '../components/MovieCard.jsx';
import { useLibrary } from '../context/LibraryContext.jsx';
import { libraryApi } from '../services/api.js';

export default function FoldersPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { progress, myList, toggleMyList, reload } = useLibrary();
  const [folder, setFolder] = useState(null);
  const [sort, setSort] = useState('name');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    (id ? libraryApi.folder(id) : libraryApi.rootFolders())
      .then(({ folder: result }) => { if (active) setFolder(result); })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, refreshKey]);

  const children = useMemo(() => [...(folder?.children ?? [])].sort((a, b) => {
    if (sort === 'recent') return new Date(b.modifiedAt ?? 0) - new Date(a.modifiedAt ?? 0);
    if (sort === 'year') return (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  }), [folder, sort]);
  const movies = useMemo(() => [...(folder?.movies ?? [])].sort((a, b) => {
    if (sort === 'recent') return new Date(b.modifiedAt) - new Date(a.modifiedAt);
    if (sort === 'year') return (b.releaseYear ?? 0) - (a.releaseYear ?? 0) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  }), [folder, sort]);

  async function setClassification(event) {
    const type = event.target.value;
    setSaving(true);
    try {
      await libraryApi.classifyFolder(folder.id, type);
      await reload();
      if (type === 'excluded') {
        navigate('/folders');
      } else {
        const { folder: updated } = await libraryApi.folder(folder.id);
        setFolder(updated);
      }
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  async function editArtwork() {
    const artworkUrl = window.prompt('Enter an HTTPS artwork image URL. Leave empty to clear it.', folder.artworkUrl ?? '');
    if (artworkUrl === null) return;
    setSaving(true);
    setError('');
    try {
      await libraryApi.classifyFolder(folder.id, folder.classification ?? 'folder', artworkUrl.trim());
      setFolder((previous) => ({ ...previous, artworkUrl: artworkUrl.trim() || null }));
      await reload();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className="app-main"><div className="page-shell library-detail-page"><div className="skeleton poster-skeleton" /></div></main>;
  if (error || !folder) return <main className="app-main"><div className="page-shell library-detail-page error-state"><FolderOpen size={36} /><h1>Folder unavailable</h1><p>{error || 'This folder is no longer in the scanned library.'}</p><Link className="button button-glass" to="/folders">Browse folders</Link></div></main>;

  return (
    <main className="app-main">
      <div className="page-shell library-detail-page">
        <div className="detail-topline">
          <button className="text-back" onClick={() => navigate(-1)}><ChevronLeft size={17} /> Back</button>
          <span className="eyebrow"><FolderOpen size={14} /> YOUR ORIGINAL FOLDER STRUCTURE</span>
        </div>
        <BreadcrumbNavigation items={folder.breadcrumbs?.slice(1) ?? []} />
        <section className="library-page-heading">
          <div><p className="eyebrow">BROWSE YOUR LIBRARY</p><h1>{folder.name}</h1><p>{folder.movieCount} movies <span>·</span> {folder.folderCount} folders {folder.episodeCount > 0 && <><span>·</span> {folder.episodeCount} episodes</>}</p></div>
          <div className="folder-actions">
            {id && <label className="classification-control"><span>Organize as</span><select value={folder.classification ?? 'folder'} onChange={setClassification} disabled={saving}>
              <option value="folder">Folder</option><option value="series">TV series</option><option value="collection">Movie collection</option><option value="excluded">Exclude from library</option>
            </select></label>}
            {id && <button className="button button-glass artwork-button" onClick={editArtwork} disabled={saving}>Set artwork</button>}
            <label className="sort-control"><ArrowDownUp size={15} /><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort folder contents">
              <option value="name">Name</option><option value="recent">Recently added</option><option value="year">Year</option>
            </select></label>
            <button className="icon-button" title="Reload folder contents" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={16} /></button>
          </div>
        </section>

        {folder.classification === 'series' && folder.seriesId && <Link className="series-folder-banner" to={`/series/${folder.seriesId}`}>Open series seasons and episodes <span>→</span></Link>}
        {children.length > 0 && <section className="library-content-section"><div className="library-content-heading"><h2>Folders</h2><span>{children.length}</span></div><div className="library-tile-grid">{children.map((child) => <FolderCard key={child.id} folder={child} />)}</div></section>}
        {movies.length > 0 && <section className="library-content-section"><div className="library-content-heading"><h2>Films in this folder</h2><span>{movies.length}</span></div><div className="library-movie-grid">{movies.map((movie) => <MovieCard key={movie.id} movie={movie} progress={progress[movie.id]} saved={myList.includes(movie.id)} onToggleSaved={toggleMyList} />)}</div></section>}
        {!children.length && !movies.length && <div className="library-empty"><FolderOpen size={25} /><h2>This folder is empty</h2><p>Nested folders and supported video files will appear here after a library refresh.</p></div>}
      </div>
    </main>
  );
}
