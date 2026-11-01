import { Bookmark, Clapperboard, Compass, Film, Search, Settings, Sparkles, Clock3, FolderOpen, Layers3, Tv2 } from 'lucide-react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';

const links = [
  { to: '/', label: 'Discover', icon: Compass, end: true },
  { to: '/movies', label: 'All movies', icon: Film },
  { to: '/recent', label: 'Recently added', icon: Clock3 },
  { to: '/series', label: 'Series', icon: Tv2 },
  { to: '/collections', label: 'Collections', icon: Layers3 },
  { to: '/folders', label: 'Folders', icon: FolderOpen },
  { to: '/organizer', label: 'Organizer', icon: Sparkles },
];
const mobileLinks = [
  ...links,
  { to: '/my-list', label: 'My List', icon: Bookmark },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Navigation({ hidden = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  useEffect(() => { setQuery(searchParams.get('q') ?? ''); }, [searchParams]);
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        event.preventDefault();
        document.querySelector('[aria-label="Search your movies"]')?.focus();
      }
      if (event.key === 'Escape') {
        setQuery('');
        if (location.pathname === '/search') navigate('/movies');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [location.pathname, navigate]);
  if (hidden) return null;

  function submitSearch(event) {
    event.preventDefault();
    const value = query.trim();
    navigate(value ? `/search?q=${encodeURIComponent(value)}` : '/search');
  }

  return (
    <>
      <aside className="side-rail">
        <NavLink to="/" className="brand" aria-label="MovieStream home">
          <span className="brand-mark"><Clapperboard size={20} /></span>
          <span className="brand-name">movie<span className="brand-light">stream</span></span>
        </NavLink>
        <div className="rail-label">YOUR SPACE</div>
        <nav className="rail-nav" aria-label="Main navigation">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}>
              <Icon size={19} /><span>{label}</span>
            </NavLink>
          ))}
          <NavLink to="/my-list" className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}>
            <Bookmark size={19} /><span>My List</span>
          </NavLink>
        </nav>
        <div className="rail-bottom">
          <div className="rail-note"><Sparkles size={16} /><span>Your films, your own little cinema.</span></div>
          <NavLink to="/settings" className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}>
            <Settings size={19} /><span>Settings</span>
          </NavLink>
        </div>
        <span className="rail-version">MOVIESTREAM · LOCAL LIBRARY</span>
      </aside>
      <header className="topbar">
        <div className="topbar-context"><span className="status-pip" /> YOUR PRIVATE CINEMA</div>
        <form className="search-box" role="search" onSubmit={submitSearch}>
          <Search size={17} />
          <input
            aria-label="Search your movies"
            placeholder="Search titles, years, genres..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <button className="search-clear" type="button" aria-label="Clear search" onClick={() => { setQuery(''); navigate('/movies'); }}>×</button>}
          <kbd>↵</kbd>
        </form>
        <span className="profile-chip" aria-hidden="true">M</span>
      </header>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {mobileLinks.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `mobile-nav-link${isActive ? ' active' : ''}`}>
            <Icon size={19} /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
