import { ChevronRight, House } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function BreadcrumbNavigation({ items = [] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link to="/folders" aria-label="Folder root"><House size={15} /></Link>
      {items.map((item, index) => (
        <span className="breadcrumb-item" key={item.id}>
          <ChevronRight size={14} />
          {index === items.length - 1
            ? <span aria-current="page">{item.name}</span>
            : <Link to={`/folders/${item.id}`}>{item.name}</Link>}
        </span>
      ))}
    </nav>
  );
}
