import { BookmarkPlus, Layers3, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import CollectionCard from '../components/CollectionCard.jsx';
import MovieCard from '../components/MovieCard.jsx';
import { useLibrary } from '../context/LibraryContext.jsx';
import { libraryApi } from '../services/api.js';

export function CollectionsIndexPage() {
  const { collections = [], reload, loading } = useLibrary();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function createCollection(event) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const { collection } = await libraryApi.createCollection({ name: name.trim(), movieIds: [] });
      setName('');
      await reload();
      navigate(`/collections/${collection.id}`);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  return <main className="app-main"><div className="page-shell library-detail-page">
    <p className="eyebrow"><Layers3 size={14} /> COLLECTIONS, YOUR WAY</p><h1 className="page-title">Collections</h1><p className="page-subtitle">Franchises from your folder library alongside custom collections you curate yourself.</p>
    <form className="create-collection-form" onSubmit={createCollection}><label htmlFor="new-collection">Create a collection</label><div><input id="new-collection" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Weekend favorites" maxLength={100} /><button className="button button-primary" disabled={saving}><Plus size={16} /> {saving ? 'Creating…' : 'Create'}</button></div>{error && <p className="form-error">{error}</p>}</form>
    {loading ? <div className="loading-inline"><span className="loading-spinner" /> Loading collections…</div>
      : collections.length ? <div className="library-tile-grid">{collections.map((collection) => <CollectionCard key={collection.id} collection={collection} />)}</div>
        : <div className="library-empty"><BookmarkPlus size={25} /><h2>Make your first collection</h2><p>Group movies without moving or changing any original files.</p></div>}
  </div></main>;
}

export function CollectionDetailsPage() {
  const { id } = useParams();
  const { movies, progress, myList, toggleMyList, reload } = useLibrary();
  const navigate = useNavigate();
  const [collection, setCollection] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [artworkUrl, setArtworkUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedMovieId, setSelectedMovieId] = useState('');

  useEffect(() => {
    let active = true;
    libraryApi.collections().then(({ collections }) => {
      const result = collections.find((item) => item.id === id);
      if (!result) throw new Error('Collection not found.');
      if (active) {
        setCollection(result);
        setName(result.name);
        setDescription(result.description ?? '');
        setArtworkUrl(result.artworkUrl ?? '');
      }
    }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [id]);

  async function save(updated) {
    setSaving(true);
    setError('');
    try {
      const { collection: result } = await libraryApi.updateCollection(id, updated);
      setCollection(result);
      await reload();
      setName(result.name);
      setDescription(result.description ?? '');
      setArtworkUrl(result.artworkUrl ?? '');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteCollection() {
    if (!window.confirm('Delete this custom collection? Your movie files will not be changed.')) return;
    setSaving(true);
    try {
      await libraryApi.deleteCollection(id);
      await reload();
      navigate('/collections');
    } catch (cause) {
      setError(cause.message);
      setSaving(false);
    }
  }

  if (error && !collection) return <main className="app-main"><div className="page-shell library-detail-page error-state"><h1>Collection unavailable</h1><p>{error}</p><Link to="/collections">Back to collections</Link></div></main>;
  if (!collection) return <main className="app-main"><div className="page-shell library-detail-page"><div className="skeleton poster-skeleton" /></div></main>;

  const custom = collection.type === 'custom';
  const availableMovies = movies.filter((movie) => !collection.movies.some((item) => item.id === movie.id));
  const collectionMovieIds = collection.movies.map((movie) => movie.id);

  function updateMembership(movieId, shouldAdd) {
    const movieIds = shouldAdd
      ? [...collectionMovieIds, movieId]
      : collectionMovieIds.filter((current) => current !== movieId);
    return save({ name, description, artworkUrl, movieIds });
  }

  return <main className="app-main"><div className="page-shell library-detail-page">
    <section className="series-hero collection-hero" style={collection.artworkUrl ? { backgroundImage: `linear-gradient(90deg,rgba(8,9,13,.97),rgba(8,9,13,.58)),url("${collection.artworkUrl}")` } : undefined}>
      <div><p className="eyebrow"><Layers3 size={14} /> {custom ? 'YOUR PERSONAL COLLECTION' : 'FOLDER COLLECTION'}</p><h1>{collection.name}</h1>
        <div className="showcase-facts"><span>{collection.movies.length} movies</span>{collection.type === 'folder' && <span>Original files stay in place</span>}</div>
        <p className="showcase-description">{collection.description || 'A hand-picked collection from your local library.'}</p>
        {!custom && collection.relativePath && <Link className="button button-glass" to={`/folders/${collection.id}`}>Open original folder</Link>}
      </div>
    </section>
    {custom && <section className="collection-editor">
      <h2>Edit collection</h2>
      <div className="collection-editor-fields"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} /></label>
        <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></label>
        <label>Artwork URL (HTTPS)<input value={artworkUrl} onChange={(event) => setArtworkUrl(event.target.value)} placeholder="https://…" /></label>
      </div>
      <div className="collection-editor-actions"><button className="button button-primary" disabled={saving} onClick={() => save({ name, description, artworkUrl, movieIds: collectionMovieIds })}>Save details</button><button className="button button-danger" disabled={saving} onClick={deleteCollection}><Trash2 size={15} /> Delete collection</button></div>
      <div className="add-movie-row"><select value={selectedMovieId} onChange={(event) => setSelectedMovieId(event.target.value)} aria-label="Choose a movie to add"><option value="">Add a movie…</option>{availableMovies.map((movie) => <option value={movie.id} key={movie.id}>{movie.title}</option>)}</select><button className="button button-glass" disabled={!selectedMovieId || saving} onClick={() => { updateMembership(selectedMovieId, true); setSelectedMovieId(''); }}><Plus size={15} /> Add movie</button></div>
      {error && <p className="form-error">{error}</p>}
    </section>}
    {collection.movies.length > 0 ? <section className="library-content-section"><div className="library-content-heading"><h2>Movies</h2><span>{collection.movies.length}</span></div><div className="library-movie-grid">{collection.movies.map((movie) => <div className="collection-movie-item" key={movie.id}><MovieCard movie={movie} progress={progress[movie.id]} saved={myList.includes(movie.id)} onToggleSaved={toggleMyList} />{custom && <button className="remove-collection-movie" disabled={saving} aria-label={`Remove ${movie.title} from collection`} onClick={() => updateMembership(movie.id, false)}><Trash2 size={14} /> Remove</button>}</div>)}</div></section> : <div className="library-empty"><Layers3 size={25} /><h2>This collection is empty</h2><p>Add movies from your library above. Original media files are never moved.</p></div>}
  </div></main>;
}
