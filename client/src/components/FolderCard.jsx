import { ArrowUpRight, Folder, Film } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function FolderCard({ folder }) {
  const isSeries = folder.classification === 'series' && folder.seriesId;
  const destination = isSeries ? `/series/${folder.seriesId}` : `/folders/${folder.id}`;
  const updated = folder.modifiedAt
    ? new Date(folder.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  return (
    <Link className="library-tile folder-tile" to={destination}>
      <div className="library-tile-art" style={folder.artworkUrl ? { backgroundImage: `linear-gradient(0deg,rgba(8,9,12,.72),transparent),url("${folder.artworkUrl}")` } : undefined}>
        {!folder.artworkUrl && <><div className="tile-orbit" /><Folder size={43} strokeWidth={1.2} /></>}
        <span className="tile-open"><ArrowUpRight size={17} /></span>
      </div>
      <div className="library-tile-copy">
        <strong>{folder.name}</strong>
        <span><Film size={13} /> {folder.movieCount} movies <i /> {folder.folderCount} folders</span>
        {updated && <small>Updated {updated}</small>}
      </div>
    </Link>
  );
}
