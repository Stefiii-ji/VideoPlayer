import { ArrowUpRight, Bookmark, Check } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function MovieCard({ movie, progress, metadata, saved, onToggleSaved }) {
  const percent = progress?.duration ? Math.min((progress.currentTime / progress.duration) * 100, 100) : 0;
  return (
    <article className="movie-card">
      <div className="poster-wrap">
        <Link to={`/movie/${movie.id}`} className="poster-link" aria-label={`View ${movie.title}`}>
          <div className="poster-art" style={metadata?.posterUrl ? { backgroundImage: `linear-gradient(0deg,rgba(8,9,12,.42),transparent 40%),url("${metadata.posterUrl}")` } : undefined}>
            {!metadata?.posterUrl && <><div className="poster-orb" /><div className="poster-lines" /><span className="poster-monogram">{movie.title.slice(0, 1).toUpperCase()}</span></>}
            <span className="poster-format">{movie.extension.replace('.', '')}</span>
            <span className="card-open"><ArrowUpRight size={17} /></span>
          </div>
        </Link>
        {onToggleSaved && <button className={`save-card${saved ? ' is-saved' : ''}`} type="button" aria-label={saved ? `Remove ${movie.title} from My List` : `Add ${movie.title} to My List`} onClick={() => onToggleSaved(movie.id)}>
          {saved ? <Check size={16} /> : <Bookmark size={16} />}
        </button>}
        {percent > 0 && <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>}
      </div>
      <Link to={`/movie/${movie.id}`} className="card-caption">
        <span className="card-title">{movie.title}</span>
        <span className="card-meta">{metadata?.releaseYear || movie.releaseYear || ' '}{metadata?.rating ? ` · ★ ${metadata.rating.toFixed(1)}` : ''}</span>
      </Link>
    </article>
  );
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** power)).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}
