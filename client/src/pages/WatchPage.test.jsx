import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WatchPage from './WatchPage.jsx';

const mocks = vi.hoisted(() => ({
  library: {},
  playback: vi.fn(),
  subtitles: vi.fn(),
  stopPlayback: vi.fn(),
  streamUrl: vi.fn(() => '/api/movies/movie-id/stream'),
  detectCapabilities: vi.fn(),
  hlsInstances: [],
}));

vi.mock('../context/LibraryContext.jsx', () => ({ useLibrary: () => mocks.library }));
vi.mock('../services/api.js', () => ({
  movieApi: {
    playback: (...args) => mocks.playback(...args),
    stopPlayback: (...args) => mocks.stopPlayback(...args),
    subtitles: (...args) => mocks.subtitles(...args),
    subtitleUrl: (id, trackId) => `/api/movies/${id}/subtitles/${trackId}.vtt`,
    streamUrl: (...args) => mocks.streamUrl(...args),
  },
}));
vi.mock('../services/playback-capabilities.js', () => ({
  detectPlaybackCapabilities: (...args) => mocks.detectCapabilities(...args),
}));
vi.mock('hls.js/light', () => {
  class MockHls {
    static Events = {
      ERROR: 'error',
      MANIFEST_PARSED: 'manifestParsed',
      LEVEL_UPDATED: 'levelUpdated',
      FRAG_BUFFERED: 'fragBuffered',
    };
    static isSupported = vi.fn(() => true);
    constructor() {
      this.loadSource = vi.fn();
      this.attachMedia = vi.fn();
      this.on = vi.fn();
      this.destroy = vi.fn();
      mocks.hlsInstances.push(this);
    }
  }
  return { default: MockHls };
});

function response(strategy = 'direct', sessionId = undefined) {
  return {
    decision: { strategy },
    metadata: {
      duration: 90,
      audioStreams: [
        { index: 1, codec: 'aac', channels: 2, language: 'eng', isDefault: true },
        { index: 2, codec: 'ac3', channels: 6, language: 'spa', title: 'Spanish surround' },
      ],
    },
    url: strategy === 'direct'
      ? '/api/movies/movie-id/stream'
      : `/api/movies/movie-id/playback-sessions/${sessionId}/index.m3u8`,
    ...(sessionId ? { sessionId } : {}),
  };
}

function episode(id, seasonNumber, episodeNumber) {
  return {
    id,
    title: id,
    episodeNumber,
    seasonNumber,
    extension: '.mp4',
  };
}

function seriesFixture() {
  return {
    id: 'series-id',
    title: 'Sample series',
    seasons: [
      { number: 2, episodes: [episode('s2e2', 2, 2), episode('s2e1', 2, 1)] },
      { number: 1, episodes: [episode('s1e2', 1, 2), episode('s1e1', 1, 1)] },
    ],
  };
}

function watchTree(initialPath = '/watch/movie-id') {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes><Route path="/watch/:id" element={<WatchPage />} /></Routes>
    </MemoryRouter>
  );
}

describe('WatchPage smart playback', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    mocks.library = {
      movies: [{ id: 'movie-id', title: 'Sample movie', extension: '.mkv' }],
      series: [],
      loading: false,
      progress: {},
      saveProgress: vi.fn(),
    };
    mocks.playback.mockReset();
    mocks.stopPlayback.mockReset().mockResolvedValue(null);
    mocks.subtitles.mockReset().mockResolvedValue({
      subtitles: [{ id: 'external-0', label: 'English', format: 'SRT', language: 'en' }],
      warning: null,
      unsupportedEmbeddedCount: 0,
    });
    mocks.streamUrl.mockClear();
    mocks.hlsInstances.length = 0;
    mocks.detectCapabilities.mockReset().mockResolvedValue({ videoCodecs: { h264: true } });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('detects capabilities, requests playback once, and preserves the player on rerenders', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    view.rerender(watchTree());
    expect(mocks.detectCapabilities).toHaveBeenCalledOnce();
    expect(mocks.playback).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Play Sample movie')).toBeInTheDocument();
  });

  it('resumes saved progress after metadata and resumes playback', async () => {
    mocks.library.progress = {
      'movie-id': { currentTime: 22, duration: 90, updatedAt: Date.now() },
    };
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
    });

    fireEvent.loadedMetadata(video);

    expect(video.currentTime).toBe(22);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('restores saved progress through an initial playback fallback at zero', async () => {
    mocks.library.progress = {
      'movie-id': { currentTime: 22, duration: 90, updatedAt: Date.now() },
    };
    mocks.playback
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response('full-transcode', '12121212-1212-4212-8212-121212121212'));
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
    });

    fireEvent.error(video);
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.hlsInstances).toHaveLength(1));
    fireEvent.loadedMetadata(video);

    expect(video.currentTime).toBe(22);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('requests one full-transcode fallback after a direct-play error and cleans up its session', async () => {
    mocks.playback
      .mockResolvedValueOnce(response('direct'))
      .mockResolvedValueOnce(response('full-transcode', '11111111-1111-4111-8111-111111111111'))
      .mockResolvedValueOnce({
        decision: { strategy: 'direct' },
        url: '/api/movies/movie-id/stream',
      });
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    fireEvent.error(view.container.querySelector('video'));
    fireEvent.error(view.container.querySelector('video'));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    expect(mocks.playback.mock.calls[1][1].fallback).toBe(true);

    fireEvent.error(view.container.querySelector('video'));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(3));
    expect(mocks.playback.mock.calls[2][1].fallback).toBe('original');
    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    expect(screen.getByRole('menuitemradio', { name: /Spanish surround/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    fireEvent.error(view.container.querySelector('video'));
    expect(mocks.playback).toHaveBeenCalledTimes(3);
    view.unmount();
    await waitFor(() => expect(mocks.stopPlayback).toHaveBeenCalledWith(
      'movie-id',
      '11111111-1111-4111-8111-111111111111',
    ));
  });

  it('offers the original stream when FFmpeg is unavailable', async () => {
    const unavailable = Object.assign(new Error('FFmpeg is unavailable.'), {
      details: { fallbackUrl: '/api/movies/movie-id/stream' },
    });
    mocks.playback
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(response('direct'));
    render(watchTree());
    await screen.findByRole('button', { name: 'Try original file' });
    fireEvent.click(screen.getByRole('button', { name: 'Try original file' }));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    expect(mocks.playback.mock.calls[1][1].fallback).toBe('original');
  });

  it('does not make duplicate playback requests under React StrictMode', async () => {
    mocks.playback.mockResolvedValue(response());
    render(<StrictMode>{watchTree()}</StrictMode>);
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    expect(mocks.playback).toHaveBeenCalledOnce();
  });

  it('only renders episode navigation for series and disables the first or last episode edge', async () => {
    mocks.playback.mockResolvedValue(response());
    const standalone = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    expect(screen.queryByRole('group', { name: 'Episode navigation' })).not.toBeInTheDocument();

    standalone.unmount();
    mocks.library = {
      ...mocks.library,
      movies: [],
      series: [seriesFixture()],
    };
    mocks.playback.mockClear().mockResolvedValue(response());
    const first = render(watchTree('/watch/s1e1'));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Previous episode' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next episode: s1e2' })).toBeEnabled();
    first.unmount();

    mocks.playback.mockClear().mockResolvedValue(response());
    render(watchTree('/watch/s2e2'));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Previous episode: s2e1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next episode' })).toBeDisabled();
  });

  it('navigates episodes in season order and crosses season boundaries both ways', async () => {
    mocks.library = {
      ...mocks.library,
      movies: [],
      series: [seriesFixture()],
    };
    mocks.playback.mockResolvedValue(response());
    render(watchTree('/watch/s1e1'));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Next episode: s1e2' }));
    await screen.findByLabelText('Play s1e2');
    expect(screen.getByRole('button', { name: 'Previous episode: s1e1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next episode: s2e1' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next episode: s2e1' }));
    await screen.findByLabelText('Play s2e1');
    expect(screen.getByRole('button', { name: 'Previous episode: s1e2' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next episode: s2e2' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Previous episode: s1e2' }));
    await screen.findByLabelText('Play s1e2');
    expect(screen.getByRole('button', { name: 'Next episode: s2e1' })).toBeEnabled();
  });

  it('starts a selected episode at zero and cleans up the previous playback session', async () => {
    mocks.library = {
      ...mocks.library,
      movies: [],
      series: [seriesFixture()],
      progress: { s1e2: { currentTime: 56, duration: 90 } },
    };
    mocks.playback
      .mockResolvedValueOnce(response('remux', 'old-episode-session'))
      .mockResolvedValueOnce(response('remux', 'new-episode-session'));
    const view = render(watchTree('/watch/s1e1'));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Next episode: s1e2' }));
    await screen.findByLabelText('Play s1e2');
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.stopPlayback).toHaveBeenCalledWith(
      's1e1',
      'old-episode-session',
    ));

    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
    expect(video.play).toHaveBeenCalled();
  });

  it('aborts stale playback requests when rapidly selecting episodes', async () => {
    mocks.library = {
      ...mocks.library,
      movies: [],
      series: [seriesFixture()],
    };
    const deferred = [];
    mocks.playback.mockImplementation(() => new Promise((resolve) => deferred.push(resolve)));
    render(watchTree('/watch/s1e1'));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Next episode: s1e2' }));
    await screen.findByLabelText('Play s1e2');
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Next episode: s2e1' }));
    await screen.findByLabelText('Play s2e1');
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(3));

    const signals = mocks.playback.mock.calls.map(([, options]) => options.signal);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(false);
    deferred[0](response('remux', 'stale-first-session'));
    deferred[1](response('remux', 'stale-second-session'));
    deferred[2](response('direct'));
    await waitFor(() => expect(mocks.stopPlayback).toHaveBeenCalledWith(
      's1e1',
      'stale-first-session',
    ));
    await waitFor(() => expect(mocks.stopPlayback).toHaveBeenCalledWith(
      's1e2',
      'stale-second-session',
    ));
  });

  it('opens compact track menus, selects tracks, and supports turning subtitles off', async () => {
    mocks.playback
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response('audio-transcode', '22222222-2222-4222-8222-222222222222'));
    render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
    expect(screen.getByRole('menu', { name: 'Subtitle tracks' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English · SRT' }));
    expect(document.querySelector('track')).toHaveAttribute(
      'src',
      '/api/movies/movie-id/subtitles/external-0.vtt',
    );
    expect(screen.queryByRole('menu', { name: 'Subtitle tracks' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Off' }));
    expect(document.querySelector('track')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    expect(screen.getByRole('menuitemradio', { name: /Spanish surround/ })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Spanish surround/ }));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    expect(mocks.playback.mock.calls[1][1].audioStreamIndex).toBe(2);
    expect(screen.queryByRole('menu', { name: 'Audio tracks' })).not.toBeInTheDocument();
  });

  it('keeps track buttons visible and opens empty menus without empty-state text', async () => {
    mocks.playback.mockResolvedValue({
      ...response(),
      metadata: { duration: 90, audioStreams: [] },
    });
    mocks.subtitles.mockResolvedValue({ subtitles: [], warning: null, unsupportedEmbeddedCount: 0 });
    render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
    expect(screen.getByRole('menu', { name: 'Subtitle tracks' })).toBeEmptyDOMElement();
    expect(screen.queryByRole('menuitemradio', { name: 'Off' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    expect(screen.getByRole('menu', { name: 'Audio tracks' })).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Subtitles' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Audio tracks' })).toBeVisible();
    expect(screen.queryByText(/no (audio|subtitle)/i)).not.toBeInTheDocument();
  });

  it('toggles playback from the video surface without toggling for track controls', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    video.play = play;
    video.pause = pause;

    fireEvent.click(video);
    expect(play).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();

    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.click(video);
    expect(pause).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Spanish surround/ }));
    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });

  it('hides controls after inactivity during playback and restores them on interaction', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const video = view.container.querySelector('video');
    const controls = view.container.querySelector('.player-controls');
    const player = view.container.querySelector('.player-shell');
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.play(video);

    act(() => vi.advanceTimersByTime(2999));
    expect(controls).not.toHaveClass('controls-hidden');
    act(() => vi.advanceTimersByTime(1));
    expect(controls).toHaveClass('controls-hidden');
    expect(player).toHaveClass('player-cursor-hidden');

    fireEvent.pointerMove(player);
    expect(controls).not.toHaveClass('controls-hidden');
    expect(player).not.toHaveClass('player-cursor-hidden');
    act(() => vi.advanceTimersByTime(3000));
    expect(controls).toHaveClass('controls-hidden');
    expect(player).toHaveClass('player-cursor-hidden');
  });

  it('auto-hides after pointer focus but preserves keyboard-focused controls', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const video = view.container.querySelector('video');
    const player = view.container.querySelector('.player-shell');
    const controls = view.container.querySelector('.player-controls');
    const playButton = screen.getByRole('button', { name: 'Play' });

    fireEvent.pointerDown(playButton);
    fireEvent.focus(playButton);
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.play(video);
    act(() => vi.advanceTimersByTime(3000));
    expect(controls).toHaveClass('controls-hidden');
    fireEvent.blur(playButton);
    expect(controls).toHaveClass('controls-hidden');

    fireEvent.pointerMove(player);
    fireEvent.keyDown(playButton, { key: 'Tab' });
    fireEvent.focus(playButton);
    act(() => vi.advanceTimersByTime(5000));
    expect(controls).not.toHaveClass('controls-hidden');

    fireEvent.pointerMove(player);
    act(() => vi.advanceTimersByTime(3000));
    expect(controls).toHaveClass('controls-hidden');
    fireEvent.blur(playButton);
    expect(controls).toHaveClass('controls-hidden');
  });

  it('keeps controls visible and playback unchanged while dragging beyond a partial range', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 20 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 25 } },
      paused: { configurable: true, value: false },
    });
    fireEvent.loadedMetadata(video);

    vi.useFakeTimers();
    const controls = view.container.querySelector('.player-controls');
    const seek = screen.getByRole('slider', { name: 'Seek' });
    const play = vi.fn();
    const pause = vi.fn();
    video.play = play;
    video.pause = pause;
    fireEvent.play(video);
    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '63' } });

    expect(video.currentTime).toBe(63);
    expect(seek).toHaveValue('63');
    act(() => vi.advanceTimersByTime(3200));
    expect(controls).not.toHaveClass('controls-hidden');
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(video.paused).toBe(false);

    fireEvent.change(seek, { target: { value: '27' } });
    expect(video.currentTime).toBe(27);
    expect(seek).toHaveValue('27');
    fireEvent.pointerUp(seek);
    act(() => vi.advanceTimersByTime(3000));
    expect(controls).toHaveClass('controls-hidden');
  });

  it('keeps controls visible while paused or a track menu is open', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const video = view.container.querySelector('video');
    const controls = view.container.querySelector('.player-controls');
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.play(video);
    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    act(() => vi.advanceTimersByTime(5000));
    expect(controls).not.toHaveClass('controls-hidden');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Audio tracks' }), { key: 'Escape' });
    fireEvent.pause(video);
    act(() => vi.advanceTimersByTime(5000));
    expect(controls).not.toHaveClass('controls-hidden');
    expect(view.container.querySelector('.player-shell')).not.toHaveClass('player-cursor-hidden');
  });

  it('cleans up the inactivity timer and keyboard listener on unmount', async () => {
    mocks.playback.mockResolvedValue(response());
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const video = view.container.querySelector('video');
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.play(video);
    expect(vi.getTimerCount()).toBe(1);
    const keydownListener = addListener.mock.calls.find(([type]) => type === 'keydown');

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(keydownListener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith('keydown', keydownListener[1]);
  });

  it('shows an actionable playback error without blaming FFmpeg or asking for another browser', async () => {
    mocks.playback.mockRejectedValue(new Error('The playback request was rejected.'));
    render(watchTree());
    expect(await screen.findByRole('button', { name: 'Retry playback' })).toBeInTheDocument();
    expect(screen.queryByText(/Check the FFmpeg configuration or choose another browser/)).not.toBeInTheDocument();
  });

  it('wires the timeline, skip, volume, play, and fullscreen controls to the video element', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 100 },
      currentTime: { configurable: true, writable: true, value: 20 },
      paused: { configurable: true, writable: true, value: true },
      volume: { configurable: true, writable: true, value: 1 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 100 } },
    });
    video.play = vi.fn().mockResolvedValue(undefined);
    const player = view.container.querySelector('.player-shell');
    player.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    fireEvent.loadedMetadata(video);

    expect(screen.getByLabelText('Duration')).toHaveTextContent('1:40');
    expect(video).not.toHaveAttribute('controls');
    expect(screen.getAllByRole('button', { name: 'Fullscreen' })).toHaveLength(1);
    expect(view.container.querySelectorAll('audio')).toHaveLength(0);
    video.play.mockClear();
    fireEvent.change(screen.getByRole('slider', { name: 'Seek' }), { target: { value: '34' } });
    expect(video.currentTime).toBe(34);
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(video.currentTime).toBe(44);
    fireEvent.click(screen.getByRole('button', { name: 'Seek backward 10 seconds' }));
    expect(video.currentTime).toBe(34);
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '0.4' } });
    expect(video.volume).toBe(0.4);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(video.play).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(player.requestFullscreen).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    expect(mocks.playback).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: player });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getAllByRole('button', { name: 'Exit fullscreen' })).toHaveLength(1);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getAllByRole('button', { name: 'Fullscreen' })).toHaveLength(1);
    delete document.fullscreenElement;
  });

  it('uses the probed duration for seeking and progress when an event HLS playlist reports infinity', async () => {
    mocks.playback.mockResolvedValue(response('remux', '33333333-3333-4333-8333-333333333333'));
    render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = document.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: Infinity },
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
    });

    fireEvent.loadedMetadata(video);

    expect(screen.getByLabelText('Duration')).toHaveTextContent('1:30');
    const seek = screen.getByRole('slider', { name: 'Seek' });
    expect(seek).toBeEnabled();
    fireEvent.change(seek, { target: { value: '25' } });
    expect(video.currentTime).toBe(25);
    fireEvent.timeUpdate(video);
    expect(mocks.library.saveProgress).toHaveBeenCalledWith('movie-id', 25, 90);
  });

  it('seeks finite-duration media beyond the currently exposed seekable range', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 20 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 25 } },
    });
    fireEvent.loadedMetadata(video);

    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(video.currentTime).toBe(30);
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('max', '90');
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveValue('30');
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(video.currentTime).toBe(40);
    fireEvent.click(screen.getByRole('button', { name: 'Seek backward 10 seconds' }));
    expect(video.currentTime).toBe(30);
    const seek = screen.getByRole('slider', { name: 'Seek' });
    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '35' } });
    expect(video.currentTime).toBe(35);
    fireEvent.pointerUp(seek);
    expect(mocks.playback).toHaveBeenCalledOnce();
  });

  it('queues a keyboard seek until metadata and a seekable range are available', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: 0 },
      seekable: { configurable: true, value: { length: 0 } },
    });

    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(0);
    video.focus();
    fireEvent.keyDown(video, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(0);
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    Object.defineProperty(video, 'seekable', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 30 },
    });
    fireEvent.progress(video);
    expect(video.currentTime).toBe(10);
  });

  it('queues a progress-bar seek before metadata and applies it when ranges become available', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: Infinity },
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: 0 },
      seekable: { configurable: true, value: { length: 0 } },
    });

    const seek = screen.getByRole('slider', { name: 'Seek' });
    expect(seek).toBeEnabled();
    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '35' } });
    fireEvent.pointerUp(seek);
    expect(video.currentTime).toBe(0);

    Object.defineProperties(video, {
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } },
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(35);
  });

  it('applies a queued seek beyond the partial range after metadata becomes ready', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: 0 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 20 } },
    });

    fireEvent.change(screen.getByRole('slider', { name: 'Seek' }), { target: { value: '35' } });
    expect(video.currentTime).toBe(0);

    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(35);
  });

  it('queues a seek until metadata is ready even when the browser already reports ranges', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 10 },
      readyState: { configurable: true, value: 0 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } },
    });
    fireEvent.progress(video);
    const seek = screen.getByRole('slider', { name: 'Seek' });
    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '40' } });
    fireEvent.pointerUp(seek);
    expect(video.currentTime).toBe(10);

    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(40);
  });

  it('uses the non-zero seekable start and end for forward and backward dragging', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: Infinity },
      currentTime: { configurable: true, writable: true, value: 120 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 120, end: () => 145 } },
    });
    fireEvent.loadedMetadata(video);

    const seek = screen.getByRole('slider', { name: 'Seek' });
    expect(seek).toHaveAttribute('min', '120');
    expect(seek).toHaveAttribute('max', '145');
    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '140' } });
    expect(video.currentTime).toBe(140);
    fireEvent.change(seek, { target: { value: '128' } });
    expect(video.currentTime).toBe(128);
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(video.currentTime).toBe(138);
    fireEvent.click(screen.getByRole('button', { name: 'Seek backward 10 seconds' }));
    expect(video.currentTime).toBe(128);
    fireEvent.pointerUp(seek);
  });

  it('queues a seek when metadata exists but seekable ranges are initially empty', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 5 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 0 } },
    });
    fireEvent.durationChange(video);
    const seek = screen.getByRole('slider', { name: 'Seek' });
    expect(seek).toBeEnabled();
    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '45' } });
    fireEvent.pointerUp(seek);
    expect(video.currentTime).toBe(5);

    Object.defineProperty(video, 'seekable', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 60 },
    });
    fireEvent.progress(video);
    expect(video.currentTime).toBe(45);
  });

  it('keeps the newest rapid seek when earlier timeupdate events arrive late', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    let actualTime = 20;
    const assignedTimes = [];
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: {
        configurable: true,
        get: () => actualTime,
        set: (value) => assignedTimes.push(value),
      },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
      seeking: { configurable: true, value: true },
    });
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(assignedTimes).toEqual([30, 40]);
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveValue('40');

    fireEvent.timeUpdate(video);
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveValue('40');
    actualTime = 40;
    Object.defineProperty(video, 'seeking', { configurable: true, value: false });
    fireEvent.seeked(video);
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveValue('40');
    expect(mocks.playback).toHaveBeenCalledOnce();
  });

  it('does not seek beyond the final valid time range or recreate playback', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 85 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
    });
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(video.currentTime).toBe(85);
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveValue('85');
    expect(mocks.playback).toHaveBeenCalledOnce();
  });

  it('uses the HLS.js media timeline for forward seeks beyond the currently buffered range', async () => {
    mocks.playback.mockResolvedValue(response('remux', '44444444-4444-4444-8444-444444444444'));
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.hlsInstances).toHaveLength(1));
    const video = view.container.querySelector('video');
    let rangeEnd = 25;
    Object.defineProperties(video, {
      duration: { configurable: true, value: Infinity },
      currentTime: { configurable: true, writable: true, value: 20 },
      readyState: { configurable: true, value: 1 },
      seekable: {
        configurable: true,
        value: { get length() { return 1; }, start: () => 0, end: () => rangeEnd },
      },
    });
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(video.currentTime).toBe(30);

    rangeEnd = 40;
    fireEvent.progress(video);
    expect(video.currentTime).toBe(30);
    expect(mocks.hlsInstances[0].destroy).not.toHaveBeenCalled();
    expect(mocks.hlsInstances[0].attachMedia).toHaveBeenCalledOnce();
  });

  it('seeks on the HLS.js media clock without rebuilding the playback session', async () => {
    mocks.playback.mockResolvedValue(response('remux', 'abababab-abab-4bab-8bab-abababababab'));
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.hlsInstances).toHaveLength(1));
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: Infinity },
      currentTime: { configurable: true, writable: true, value: 120 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 120, end: () => 145 } },
    });
    fireEvent.loadedMetadata(video);

    const seek = screen.getByRole('slider', { name: 'Seek' });
    expect(seek).toHaveAttribute('min', '120');
    expect(seek).toHaveAttribute('max', '145');
    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '132' } });
    fireEvent.pointerUp(seek);
    expect(video.currentTime).toBe(132);
    expect(mocks.playback).toHaveBeenCalledOnce();
    expect(mocks.hlsInstances[0].destroy).not.toHaveBeenCalled();
  });

  it('waits for native HLS seekable ranges before applying a forward seek', async () => {
    mocks.playback.mockResolvedValue(response('remux', '55555555-5555-4555-8555-555555555555'));
    const view = render(watchTree());
    const video = view.container.querySelector('video');
    let rangeEnd = 25;
    video.canPlayType = vi.fn(() => 'maybe');
    Object.defineProperties(video, {
      duration: { configurable: true, value: Infinity },
      currentTime: { configurable: true, writable: true, value: 20 },
      readyState: { configurable: true, value: 1 },
      seekable: {
        configurable: true,
        value: { get length() { return 1; }, start: () => 0, end: () => rangeEnd },
      },
    });
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole('button', { name: 'Seek forward 10 seconds' }));
    expect(video.currentTime).toBe(20);

    rangeEnd = 35;
    fireEvent.progress(video);
    expect(video.currentTime).toBe(30);
    expect(mocks.hlsInstances).toHaveLength(0);
  });

  it('preserves the single media position when changing audio tracks', async () => {
    mocks.playback
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response('audio-transcode', '66666666-6666-4666-8666-666666666666'));
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 37 },
      paused: { configurable: true, writable: true, value: false },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
    });
    video.play = vi.fn().mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Spanish surround/ }));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(37);
    expect(video.play).toHaveBeenCalled();
  });

  it('aborts stale audio-track requests and cleans up a late session response', async () => {
    let resolveFirst;
    let resolveSecond;
    mocks.playback
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Spanish surround/ }));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(2));
    const firstSignal = mocks.playback.mock.calls[1][1].signal;
    fireEvent.click(screen.getByRole('button', { name: 'Audio tracks' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Default · Track 1/ }));
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledTimes(3));
    expect(firstSignal.aborted).toBe(true);

    resolveSecond(response('audio-transcode', '88888888-8888-4888-8888-888888888888'));
    await waitFor(() => expect(mocks.hlsInstances).toHaveLength(1));
    resolveFirst(response('audio-transcode', '99999999-9999-4999-8999-999999999999'));
    await waitFor(() => expect(mocks.stopPlayback).toHaveBeenCalledWith(
      'movie-id',
      '99999999-9999-4999-8999-999999999999',
    ));
    expect(screen.getByRole('button', { name: 'Audio tracks' })).toBeVisible();
  });

  it('supports browsers whose play method does not return a promise', async () => {
    mocks.playback.mockResolvedValue(response());
    const view = render(watchTree());
    await waitFor(() => expect(mocks.playback).toHaveBeenCalledOnce());
    const video = view.container.querySelector('video');
    video.play = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(video.play).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: /Playback was blocked/ })).not.toBeInTheDocument();
  });

  it('does not reinitialize HLS when playback state rerenders', async () => {
    mocks.playback.mockResolvedValue(response('remux', '77777777-7777-4777-8777-777777777777'));
    const view = render(watchTree());
    await waitFor(() => expect(mocks.hlsInstances).toHaveLength(1));
    const video = view.container.querySelector('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, writable: true, value: 10 },
      readyState: { configurable: true, value: 1 },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } },
    });
    fireEvent.timeUpdate(video);
    expect(mocks.hlsInstances).toHaveLength(1);
    expect(mocks.hlsInstances[0].loadSource).toHaveBeenCalledOnce();
    expect(mocks.hlsInstances[0].attachMedia).toHaveBeenCalledOnce();
    expect(mocks.hlsInstances[0].destroy).not.toHaveBeenCalled();
  });
});
