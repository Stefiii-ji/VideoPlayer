import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import Navigation from './components/Navigation.jsx';
import RemoteNavigation from './components/RemoteNavigation.jsx';
import { LibraryProvider } from './context/LibraryContext.jsx';
import HomePage from './pages/HomePage.jsx';
import MoviePage from './pages/MoviePage.jsx';
import MyListPage from './pages/MyListPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import WatchPage from './pages/WatchPage.jsx';
import FoldersPage from './pages/FoldersPage.jsx';
import { SeriesDetailsPage, SeriesIndexPage } from './pages/SeriesPage.jsx';
import { CollectionDetailsPage, CollectionsIndexPage } from './pages/CollectionsPage.jsx';
import OrganizerPage from './pages/OrganizerPage.jsx';
import './styles.css';
import './library.css';

function AppLayout() {
  const location = useLocation();
  return <LibraryProvider>
    <RemoteNavigation />
    <Navigation hidden={location.pathname.startsWith('/watch/')} />
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/movies" element={<HomePage mode="movies" />} />
      <Route path="/recent" element={<HomePage mode="recent" />} />
      <Route path="/my-list" element={<MyListPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/organizer" element={<OrganizerPage />} />
      <Route path="/folders" element={<FoldersPage />} />
      <Route path="/folders/:id" element={<FoldersPage />} />
      <Route path="/series" element={<SeriesIndexPage />} />
      <Route path="/series/:id" element={<SeriesDetailsPage />} />
      <Route path="/collections" element={<CollectionsIndexPage />} />
      <Route path="/collections/:id" element={<CollectionDetailsPage />} />
      <Route path="/movie/:id" element={<MoviePage />} />
      <Route path="/watch/:id" element={<WatchPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  </LibraryProvider>;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter><AppLayout /></BrowserRouter></React.StrictMode>,
);
