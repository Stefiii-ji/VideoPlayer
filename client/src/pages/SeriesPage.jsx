import { Tv2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import EpisodeCard from '../components/EpisodeCard.jsx';
import SeasonSelector from '../components/SeasonSelector.jsx';
import SeriesCard from '../components/SeriesCard.jsx';
import { useLibrary } from '../context/LibraryContext.jsx';
import { libraryApi } from '../services/api.js';

export function SeriesIndexPage() {
  const { series, loading } = useLibrary();
  if (loading) return <main className="app-main"><div className="page-shell library-detail-page"><div className="skeleton-row">{[1, 2, 3].map((id) => <div className="skeleton poster-skeleton" key={id} />)}</div></div></main>;
  return <main className="app-main"><div className="page-shell library-detail-page">
    <p className="eyebrow"><Tv2 size={14} /> SEASONS, EPISODES, ALL YOURS</p><h1 className="page-title">Series</h1><p className="page-subtitle">Shows detected from your original folders. Classify any folder as a series to correct the grouping.</p>
    {series.length ? <div className="library-tile-grid">{series.map((item) => <SeriesCard key={item.id} series={item} />)}</div> : <div className="library-empty"><Tv2 size={25} /><h2>No series detected yet</h2><p>Folders with episode naming such as S01E01 appear here automatically. You can also mark any folder as a series while browsing.</p><Link className="button button-glass" to="/folders">Browse folders</Link></div>}
  </div></main>;
}

export function SeriesDetailsPage() {
  const { id } = useParams();
  const { series: indexedSeries, progress } = useLibrary();
  const [series, setSeries] = useState(null);
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [loadedSeason, setLoadedSeason] = useState(null);
  const [seasonMetadataError, setSeasonMetadataError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    libraryApi.seriesDetail(id)
      .then(({ series: result }) => {
        if (!active) return;
        setSeries(result);
        setSelectedSeason(result.seasons[0]?.number ?? null);
      })
      .catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!series || selectedSeason === null) return undefined;
    let active = true;
    setLoadedSeason(null);
    setSeasonMetadataError('');
    libraryApi.season(id, selectedSeason)
      .then(({ season, metadataError }) => {
        if (!active) return;
        setLoadedSeason(season);
        setSeasonMetadataError(metadataError ?? '');
      })
      .catch((cause) => {
        if (active) setSeasonMetadataError(`Episode details could not be refreshed: ${cause.message}`);
      });
    return () => { active = false; };
  }, [id, series, selectedSeason]);

  if (error) return <main className="app-main"><div className="page-shell library-detail-page error-state"><h1>Series unavailable</h1><p>{error}</p><Link to="/series">Back to series</Link></div></main>;
  if (!series) return <main className="app-main"><div className="page-shell library-detail-page"><div className="skeleton poster-skeleton" /></div></main>;
  const season = loadedSeason?.number === selectedSeason
    ? loadedSeason
    : series.seasons.find((item) => item.number === selectedSeason);
  const metadata = series.metadata;
  const episodes = season?.episodes ?? [];
  const currentIndex = episodes.findIndex((episode) => progress[episode.id]?.currentTime > 0);

  return <main className="app-main">
    <div className="page-shell library-detail-page">
      <section className="series-hero" style={metadata?.backdropUrl ? { backgroundImage: `linear-gradient(90deg,rgba(8,9,13,.97),rgba(8,9,13,.58)),url("${metadata.backdropUrl}")` } : undefined}>
        <div><p className="eyebrow"><Tv2 size={14} /> YOUR SERIES LIBRARY</p><h1>{metadata?.title || series.title}</h1>
          <div className="showcase-facts"><span>{series.seasons.length} seasons</span><span>{series.episodeCount} episodes</span>{metadata?.rating && <span>★ {metadata.rating.toFixed(1)}</span>}{metadata?.genres?.slice(0, 2).map((genre) => <span key={genre}>{genre}</span>)}</div>
          <p className="showcase-description">{metadata?.description || 'A complete series from your personal library. Your original folder and episode files remain exactly where they are.'}</p>
          {series.metadataError && <p className="metadata-note">{series.metadataError}</p>}
          {episodes[0] && <Link className="button button-primary" to={`/watch/${episodes[currentIndex >= 0 ? currentIndex : 0].id}`}>▶ {currentIndex >= 0 ? 'Continue watching' : 'Play first episode'}</Link>}
        </div>
      </section>
      <div className="season-toolbar"><div><p className="eyebrow">EPISODES</p><h2>{season?.number === 0 ? 'Specials' : `Season ${String(season?.number ?? 0).padStart(2, '0')}`}</h2></div>
        <SeasonSelector seasons={series.seasons} selected={selectedSeason ?? ''} onChange={setSelectedSeason} />
      </div>
      <div className="episode-list">{episodes.map((episode) => <EpisodeCard key={episode.id} episode={{ ...episode, progress: progress[episode.id] ? { positionSeconds: progress[episode.id].currentTime, durationSeconds: progress[episode.id].duration } : episode.progress }} />)}</div>
      {seasonMetadataError && <p className="metadata-note">{seasonMetadataError}</p>}
      <section className="library-content-section related-series"><div className="library-content-heading"><h2>More series</h2></div><div className="library-tile-grid">{indexedSeries.filter((item) => item.id !== series.id).slice(0, 4).map((item) => <SeriesCard key={item.id} series={item} />)}</div></section>
    </div>
  </main>;
}
