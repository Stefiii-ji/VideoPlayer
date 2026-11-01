import { Film, Search } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import MovieRow from '../components/MovieRow.jsx';
import { useLibrary } from '../context/LibraryContext.jsx';

export default function SearchPage() {
  const [params] = useSearchParams();
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const { movies, loading, metadata, progress, myList, toggleMyList } = useLibrary();
  const results = useMemo(() => query ? movies.filter((movie) => {
    const extra = metadata[movie.id];
    return [
      movie.title,
      extra?.releaseYear ?? movie.releaseYear,
      ...extra?.genres ?? [],
    ].some((value) => String(value ?? '').toLowerCase().includes(query));
  }) : [], [movies, metadata, query]);

  return (
    <main className="app-main">
      <div className="page-shell collection-page">
        <p className="eyebrow"><Search size={14} /> SEARCH YOUR PERSONAL LIBRARY</p>
        <h1 className="page-title">{query ? <>Results for <span>“{params.get('q')}”</span></> : 'Find a film for tonight'}</h1>
        <p className="page-subtitle">Search movie titles, release years, and genres available in your library metadata.</p>
        {loading ? <div className="loading-inline"><span className="loading-spinner" /> Looking through your films…</div>
          : results.length ? <MovieRow title={`${results.length} ${results.length === 1 ? 'match' : 'matches'}`} movies={results} progress={progress} metadata={metadata} myList={myList} onToggleSaved={toggleMyList} />
            : <div className="empty-results"><div className="empty-art"><Film size={30} /></div><h2>{query ? 'No matches just yet' : 'Enter a search to get started'}</h2><p>{query ? 'Try a different title, year, or genre from your local collection.' : 'Enter a movie title, year, or available genre in the search bar above.'}</p></div>}
      </div>
    </main>
  );
}
