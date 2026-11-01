import { ArrowLeft, Bookmark, CalendarDays, Check, Clock3, Film, HardDrive, Play, Star } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatBytes } from '../components/MovieCard.jsx';
import MovieRow from '../components/MovieRow.jsx';
import { useLibrary } from '../context/LibraryContext.jsx';

export default function MoviePage() {
  const { id } = useParams();
  const { movies, loading, progress, metadata: metadataById, loadMetadata, myList, toggleMyList } = useLibrary();
  const movie = movies.find((item) => item.id === id);
  const metadata = metadataById[id];

  useEffect(() => {
    if (movie && !Object.hasOwn(metadataById, id)) {
      loadMetadata(id).catch((error) => console.warn(`Optional movie metadata is unavailable: ${error.message}`));
    }
  }, [id, movie, metadataById, loadMetadata]);

  if (!movie && loading) return <main className="page-shell"><div className="hero-skeleton skeleton" /></main>;
  if (!movie) return <main className="page-shell error-state"><div className="state-icon"><Film /></div><h1>Movie not found</h1><p>It may have been moved or removed. Refresh the library and try again.</p><Link className="button button-quiet" to="/"><ArrowLeft size={17} /> Back to library</Link></main>;

  const related = movies
    .filter((item) => item.id !== movie.id)
    .sort((a, b) => Number(b.extension === movie.extension) - Number(a.extension === movie.extension))
    .slice(0, 12);

  return (
    <main className="movie-detail">
      <div className="detail-backdrop" style={metadata?.backdropUrl ? { backgroundImage: `linear-gradient(90deg, #090a0d 5%, rgba(9,10,13,.83) 45%, rgba(9,10,13,.18)), linear-gradient(0deg,#090a0d 0%,transparent 80%), url("${metadata.backdropUrl}")` } : undefined} />
      <div className="detail-content">
        <Link to="/" className="back-link"><ArrowLeft size={17} /> Your library</Link>
        <div className="detail-layout">
          <div className="detail-poster">
            {metadata?.posterUrl ? <img src={metadata.posterUrl} alt={`${movie.title} poster`} /> : <div className="detail-poster-fallback"><Film size={42} /><span>{movie.title.slice(0, 1).toUpperCase()}</span></div>}
          </div>
          <div className="detail-copy">
            <p className="eyebrow">FROM YOUR PERSONAL COLLECTION</p>
            <h1>{movie.title}</h1>
            <div className="detail-facts">
              {(metadata?.releaseYear || movie.releaseYear) && <span><CalendarDays size={15} /> {metadata?.releaseYear || movie.releaseYear}</span>}
              {metadata?.runtime && <span><Clock3 size={15} /> {metadata.runtime} min</span>}
              {metadata?.rating && <span><Star size={15} /> {metadata.rating.toFixed(1)}</span>}
              <span><HardDrive size={15} /> {formatBytes(movie.size)}</span>
              <span className="format-pill">{movie.extension.slice(1).toUpperCase()}</span>
            </div>
            {metadata?.genres?.length > 0 && <p className="genre-list">{metadata.genres.join(' · ')}</p>}
            <p className="detail-description">{metadata?.description || 'Ready when you are. Movie details are optional and playback works without online metadata.'}</p>
            <div className="detail-actions"><Link className="button button-primary button-large" to={`/watch/${movie.id}`}><Play size={19} fill="currentColor" /> Play movie</Link><button className="button button-glass button-large" onClick={() => toggleMyList(movie.id)}>{myList.includes(movie.id) ? <Check size={18} /> : <Bookmark size={18} />}{myList.includes(movie.id) ? 'In My List' : 'Add to My List'}</button><span className="local-note"><span className="live-dot" /> Streams from your computer</span></div>
            <div className="file-info"><span>FILE FORMAT</span><strong>{movie.extension.toUpperCase()}</strong><span>FILE SIZE</span><strong>{formatBytes(movie.size)}</strong></div>
          </div>
        </div>
        {related.length > 0 && <div className="detail-related"><MovieRow title="More from your collection" movies={related} progress={progress} metadata={metadataById} myList={myList} onToggleSaved={toggleMyList} /></div>}
      </div>
    </main>
  );
}
