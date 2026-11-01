import { Bookmark, Film } from 'lucide-react';
import MovieRow from '../components/MovieRow.jsx';
import { useLibrary } from '../context/LibraryContext.jsx';
import { Link } from 'react-router-dom';

export default function MyListPage() {
  const { movies, loading, metadata, progress, myList, toggleMyList } = useLibrary();
  const savedMovies = myList.map((id) => movies.find((movie) => movie.id === id)).filter(Boolean);

  return (
    <main className="app-main">
      <div className="page-shell collection-page">
        <p className="eyebrow"><Bookmark size={14} /> YOUR PERSONAL WATCHLIST</p>
        <h1 className="page-title">My List<span className="title-count">{savedMovies.length}</span></h1>
        <p className="page-subtitle">A little shortlist of things you’re looking forward to.</p>
        {loading ? <div className="loading-inline"><span className="loading-spinner" /> Loading your library…</div>
          : savedMovies.length ? <MovieRow title="Saved for later" movies={savedMovies} progress={progress} metadata={metadata} myList={myList} onToggleSaved={toggleMyList} />
            : <div className="empty-results"><div className="empty-art"><Film size={30} /></div><h2>Your list is waiting for a story</h2><p>Tap the bookmark on any movie card to save it here.</p><Link className="button button-glass" to="/movies">Browse all movies</Link></div>}
      </div>
    </main>
  );
}
