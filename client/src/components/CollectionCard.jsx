import { ArrowUpRight, Layers3 } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function CollectionCard({ collection }) {
  return (
    <Link className="library-tile collection-tile" to={`/collections/${collection.id}`}>
      <div className="library-tile-art" style={collection.artworkUrl ? { backgroundImage: `linear-gradient(0deg,rgba(8,9,12,.72),transparent),url("${collection.artworkUrl}")` } : undefined}>
        {!collection.artworkUrl && <><div className="tile-orbit" /><Layers3 size={43} strokeWidth={1.2} /></>}
        <span className="tile-open"><ArrowUpRight size={17} /></span>
      </div>
      <div className="library-tile-copy">
        <strong>{collection.name}</strong>
        <span><Layers3 size={13} /> {collection.movieCount ?? collection.movies?.length ?? 0} movies {collection.type === 'custom' ? '· Personal' : '· Folder collection'}</span>
      </div>
    </Link>
  );
}
