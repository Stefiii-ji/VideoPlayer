import { ArrowRight, Film, FolderOpen, RefreshCw, Sparkles, Tv2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import MovieRow from '../components/MovieRow.jsx';
import CollectionCard from '../components/CollectionCard.jsx';
import FolderCard from '../components/FolderCard.jsx';
import SeriesCard from '../components/SeriesCard.jsx';
import EpisodeCard from '../components/EpisodeCard.jsx';
import { useLibrary } from '../context/LibraryContext.jsx';

function yearInTitle(title) {
  return title.match(/(?:19|20)\d{2}/)?.[0] ?? '';
}

export default function HomePage({ mode = 'discover' }) {
  const { movies = [], series = [], collections = [], folders = [], loading, error, progress = {}, reload, scannedAt, myList = [], metadata = {}, toggleMyList, loadMetadata } = useLibrary();
  const recent = useMemo(() => [...movies].sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt)), [movies]);
  const hero = recent[0];
  const continueWatching = recent.filter((movie) => progress[movie.id]?.duration
    && progress[movie.id].currentTime / progress[movie.id].duration < 0.9);
  const episodeProgress = series.flatMap((item) => item.seasons.flatMap((season) => season.episodes.map((episode) => ({
    ...episode,
    seriesTitle: item.title,
    position: progress[episode.id]?.currentTime ?? episode.progress?.positionSeconds ?? 0,
    duration: progress[episode.id]?.duration ?? episode.progress?.durationSeconds ?? 0,
    lastUpdated: progress[episode.id]?.updatedAt ?? new Date(episode.progress?.updatedAt ?? 0).getTime(),
  })))).filter((episode) => episode.position > 0 && episode.duration > 0 && episode.position / episode.duration < 0.9)
    .sort((a, b) => b.lastUpdated - a.lastUpdated).slice(0, 8);
  const savedMovies = myList.map((id) => movies.find((movie) => movie.id === id)).filter(Boolean);

  useEffect(() => {
    if (hero && !Object.hasOwn(metadata, hero.id)) {
      loadMetadata(hero.id).catch((error) => console.warn(`Optional featured metadata is unavailable: ${error.message}`));
    }
  }, [hero?.id, metadata, loadMetadata]);

  const genres = [...new Set(Object.values(metadata).flatMap((item) => item?.genres ?? []))].sort();
  const title = mode === 'recent' ? 'Recently added' : 'Your entire collection';

  if (loading) {
    return <main className="app-main"><div className="page-shell"><div className="hero-skeleton skeleton" /><div className="skeleton-row">{[1, 2, 3, 4].map((item) => <div className="skeleton poster-skeleton" key={item} />)}</div></div></main>;
  }
  if (error) {
    return <main className="app-main"><div className="page-shell error-state"><div className="state-icon"><Film /></div><p className="eyebrow">YOUR PRIVATE CINEMA</p><h1>We couldn't reach your library.</h1><p>{error} Check that the server is running and MOVIE_DIRECTORY points to an available folder.</p><button className="button button-primary" onClick={() => reload()}><RefreshCw size={17} /> Try again</button></div></main>;
  }
  if (!movies.length && !series.length && !collections.length) {
    return <main className="app-main"><div className="page-shell empty-state"><div className="empty-art"><Film size={34} /></div><p className="eyebrow">A LITTLE ROOM FOR MOVIE MAGIC</p><h1>Your library is ready for its first feature.</h1><p>Add videos to your configured movie folder, then refresh your library to see them here.</p><button className="button button-primary" onClick={() => reload(true)}><RefreshCw size={17} /> Scan movie folder</button></div></main>;
  }

  return (
    <main className="app-main">
      {mode === 'discover' && hero && <section className="showcase">
        <div className="showcase-backdrop" style={metadata[hero.id]?.backdropUrl ? { backgroundImage: `linear-gradient(90deg,rgba(8,9,13,.97) 4%,rgba(8,9,13,.81) 39%,rgba(8,9,13,.14) 100%),linear-gradient(0deg,#0b0c10 0%,transparent 34%),url("${metadata[hero.id].backdropUrl}")` } : undefined}>
          <div className="showcase-glow" /><div className="showcase-grain" />
        </div>
        <div className="showcase-copy">
          <span className="eyebrow"><Sparkles size={14} /> TONIGHT, IN YOUR CINEMA</span>
          <p className="showcase-kicker">A story worth staying in for</p>
          <h1>{hero.title}</h1>
          <div className="showcase-facts">
            {(metadata[hero.id]?.releaseYear || hero.releaseYear) && <span>{metadata[hero.id]?.releaseYear || hero.releaseYear}</span>}
            {metadata[hero.id]?.rating && <span className="rating"><span>★</span> {metadata[hero.id].rating.toFixed(1)}</span>}
            {metadata[hero.id]?.genres?.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
            {!metadata[hero.id]?.releaseYear && <span>{hero.extension.slice(1).toUpperCase()} · YOUR LIBRARY</span>}
          </div>
          <p className="showcase-description">{metadata[hero.id]?.description || 'Your collection, one good story away. Settle in and discover something worth watching.'}</p>
          <div className="hero-actions">
            <Link className="button button-primary" to={`/watch/${hero.id}`}><span className="button-play">▶</span> Play now</Link>
            <Link className="button button-glass" to={`/movie/${hero.id}`}><ArrowRight size={17} /> More details</Link>
            <button className={`button-icon${myList.includes(hero.id) ? ' selected' : ''}`} aria-label={myList.includes(hero.id) ? 'Remove featured movie from My List' : 'Add featured movie to My List'} onClick={() => toggleMyList(hero.id)}>{myList.includes(hero.id) ? '✓' : '+'}</button>
          </div>
        </div>
        <div className="showcase-side-note"><span>FEATURED FROM YOUR LIBRARY</span><i /></div>
      </section>}

      <div className="page-shell library-page">
        <div className="library-toolbar">
          <div><p className="eyebrow">{mode === 'recent' ? 'FRESH FROM YOUR FOLDERS' : 'CURATED BY YOU'}</p><h2>{title}</h2></div>
          <div className="library-meta"><span><span className="live-dot" /> {movies.length} films</span><button className="refresh-button" onClick={() => reload(true)} title="Scan for new movies"><RefreshCw size={15} /> Refresh library</button></div>
        </div>
        <div className="rows-wrap">
          {continueWatching.length > 0 && <MovieRow id="continue" title="Pick up where you left off" movies={continueWatching} progress={progress} metadata={metadata} myList={myList} onToggleSaved={toggleMyList} />}
          {episodeProgress.length > 0 && <section className="library-content-section home-entity-section continue-episodes"><div className="library-content-heading"><h2><Tv2 size={17} /> Continue watching series</h2><Link to="/series">View series <ArrowRight size={14} /></Link></div><div className="episode-list">{episodeProgress.map((episode) => <EpisodeCard key={episode.id} episode={{ ...episode, progress: { positionSeconds: episode.position, durationSeconds: episode.duration } }} />)}</div></section>}
          {savedMovies.length > 0 && <MovieRow title="Your watchlist" movies={savedMovies} progress={progress} metadata={metadata} myList={myList} onToggleSaved={toggleMyList} />}
          {mode === 'discover' && series.length > 0 && <section className="library-content-section home-entity-section"><div className="library-content-heading"><h2><Tv2 size={17} /> TV series</h2><Link to="/series">View all <ArrowRight size={14} /></Link></div><div className="library-tile-grid">{series.slice(0, 6).map((item) => <SeriesCard key={item.id} series={item} />)}</div></section>}
          {mode === 'discover' && collections.length > 0 && <section className="library-content-section home-entity-section"><div className="library-content-heading"><h2>Collections</h2><Link to="/collections">View all <ArrowRight size={14} /></Link></div><div className="library-tile-grid">{collections.slice(0, 6).map((item) => <CollectionCard key={item.id} collection={item} />)}</div></section>}
          {mode === 'discover' && folders.length > 0 && <section className="library-content-section home-entity-section"><div className="library-content-heading"><h2><FolderOpen size={17} /> Browse folders</h2><Link to="/folders">Open folder browser <ArrowRight size={14} /></Link></div><div className="library-tile-grid">{folders.slice(0, 6).map((folder) => <FolderCard key={folder.id} folder={folder} />)}</div></section>}
          {mode === 'discover' && <MovieRow title="Recently added to your collection" movies={recent.slice(0, 18)} progress={progress} metadata={metadata} myList={myList} onToggleSaved={toggleMyList} />}
          {movies.length > 0 && <MovieRow id="all-movies" title={mode === 'recent' ? 'Latest in your library' : 'All movies'} movies={mode === 'recent' ? recent : movies} progress={progress} metadata={metadata} myList={myList} onToggleSaved={toggleMyList} />}
          {genres.map((genre) => {
            const categorized = movies.filter((movie) => metadata[movie.id]?.genres?.includes(genre));
            return <MovieRow key={genre} title={genre} movies={categorized} progress={progress} metadata={metadata} myList={myList} onToggleSaved={toggleMyList} />;
          })}
          {mode === 'discover' && !series.length && !collections.length && folders.length > 0 && !movies.length && <Link className="button button-glass browse-folders-empty" to="/folders"><FolderOpen size={17} /> Browse your folders</Link>}
        </div>
        <footer className="app-footer"><span>MovieStream <span className="footer-dot">·</span> a little closer to cinema</span><span>{scannedAt ? `Library updated ${new Date(scannedAt).toLocaleString()}` : 'Private. Local. Yours.'}</span></footer>
      </div>
    </main>
  );
}
