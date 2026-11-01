import { Check, FolderOpen, HardDrive, RefreshCw, ShieldCheck } from 'lucide-react';
import { useLibrary } from '../context/LibraryContext.jsx';

export default function SettingsPage() {
  const { movies, loading, scannedAt, reload } = useLibrary();
  return (
    <main className="app-main">
      <div className="page-shell collection-page settings-page">
        <p className="eyebrow"><span className="settings-dot" /> YOUR SPACE, YOUR RULES</p>
        <h1 className="page-title">A few details</h1>
        <p className="page-subtitle">MovieStream is a private window into your local collection.</p>
        <section className="settings-card">
          <div className="settings-icon"><FolderOpen /></div>
          <div className="settings-copy"><h2>Movie library</h2><p>Your movie files stay in their original folders. MovieStream only reads the configured library.</p><div className="setting-status"><span><span className="live-dot" /> {movies.length} supported films</span><span>Last scanned {scannedAt ? new Date(scannedAt).toLocaleString() : 'when opened'}</span></div></div>
          <button className="button button-glass" onClick={() => reload(true)} disabled={loading}><RefreshCw size={16} className={loading ? 'spin-icon' : ''} /> {loading ? 'Scanning…' : 'Scan for changes'}</button>
        </section>
        <section className="settings-card">
          <div className="settings-icon"><ShieldCheck /></div>
          <div className="settings-copy"><h2>Private by design</h2><p>Only movies in your configured folder are indexed and streamed. Movie files aren’t uploaded to MovieStream or a cloud service.</p><div className="setting-status"><span><Check size={14} /> Local playback</span><span><Check size={14} /> No account required</span></div></div>
        </section>
        <section className="settings-card">
          <div className="settings-icon"><HardDrive /></div>
          <div className="settings-copy"><h2>Watching on another screen?</h2><p>Keep this computer awake and the MovieStream server running. On your trusted home Wi-Fi, open the PC’s IPv4 address with port 5000.</p><div className="network-hint"><code>http://&lt;your-pc-ip&gt;:5000</code><span>Smart TV playback depends on its browser and video codec support.</span></div></div>
        </section>
      </div>
    </main>
  );
}
