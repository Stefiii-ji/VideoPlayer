import { Check, Play } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function EpisodeCard({ episode }) {
  const progress = episode.progress && !episode.progress.completed
    ? Math.min((episode.progress.positionSeconds / episode.progress.durationSeconds) * 100, 100)
    : 0;
  return (
    <Link className="episode-card" to={`/watch/${episode.id}`}>
      <span className="episode-number">{String(episode.episodeNumber).padStart(2, '0')}</span>
      <span className="episode-copy"><strong>{episode.metadataTitle || episode.title || `Episode ${episode.episodeNumber}`}</strong><small>{episode.seriesTitle ? `${episode.seriesTitle} · ` : ''}{episode.runtime ? `${episode.runtime} min` : episode.extension?.slice(1).toUpperCase() || 'Episode'}{episode.size ? ` · ${Math.round(episode.size / 1048576)} MB` : ''}</small></span>
      {episode.watched && <Check className="episode-watched" size={17} aria-label="Watched" />}
      <Play className="episode-play" size={18} />
      {progress > 0 && <span className="episode-progress"><i style={{ width: `${progress}%` }} /></span>}
    </Link>
  );
}
