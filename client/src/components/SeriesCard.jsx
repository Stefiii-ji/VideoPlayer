import { ArrowUpRight, Clapperboard, Tv2 } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function SeriesCard({ series }) {
  return (
    <Link className="library-tile series-tile" to={`/series/${series.id}`}>
      <div className="library-tile-art" style={series.posterUrl ? { backgroundImage: `linear-gradient(0deg,rgba(8,9,12,.72),transparent),url("${series.posterUrl}")` } : undefined}>
        {!series.posterUrl && <><div className="tile-orbit" /><Clapperboard size={43} strokeWidth={1.2} /></>}
        <span className="tile-open"><ArrowUpRight size={17} /></span>
      </div>
      <div className="library-tile-copy">
        <strong>{series.title}</strong>
        <span><Tv2 size={13} /> {series.seasonCount ?? series.seasons?.length ?? 0} seasons <i /> {series.episodeCount} episodes</span>
      </div>
    </Link>
  );
}
