import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef } from 'react';
import MovieCard from './MovieCard.jsx';

export default function MovieRow({ title, movies, progress = {}, metadata = {}, myList = [], onToggleSaved, id }) {
  const row = useRef(null);
  if (!movies.length) return null;
  return (
    <section className="movie-section" id={id}>
      <div className="section-heading">
        <div><h2>{title}</h2><span>{movies.length} title{movies.length === 1 ? '' : 's'}</span></div>
        <div className="row-controls">
          <button aria-label={`Scroll ${title} left`} onClick={() => row.current?.scrollBy({ left: -640, behavior: 'smooth' })}><ChevronLeft /></button>
          <button aria-label={`Scroll ${title} right`} onClick={() => row.current?.scrollBy({ left: 640, behavior: 'smooth' })}><ChevronRight /></button>
        </div>
      </div>
      <div className="movie-row" ref={row}>
        {movies.map((movie) => <MovieCard
          key={movie.id}
          movie={movie}
          progress={progress[movie.id]}
          metadata={metadata[movie.id]}
          saved={myList.includes(movie.id)}
          onToggleSaved={onToggleSaved}
        />)}
      </div>
    </section>
  );
}
