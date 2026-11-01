import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlaybackCapabilities } from './playback-capabilities.js';

let originalMediaCapabilities;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMediaCapabilities) {
    Object.defineProperty(navigator, 'mediaCapabilities', originalMediaCapabilities);
    originalMediaCapabilities = undefined;
  } else {
    delete navigator.mediaCapabilities;
  }
});

describe('browser playback capability detection', () => {
  it('reports codec profiles, levels, AAC profile and decoding information', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((contentType) => (
      /avc1|hvc1|vp09|av01|mp4a\.40\.2/.test(contentType) ? 'probably' : ''
    ));
    originalMediaCapabilities = Object.getOwnPropertyDescriptor(navigator, 'mediaCapabilities');
    Object.defineProperty(navigator, 'mediaCapabilities', {
      configurable: true,
      value: {
        decodingInfo: vi.fn(async () => ({ supported: true, smooth: true, powerEfficient: false })),
      },
    });

    const report = await detectPlaybackCapabilities();
    expect(report.videoCodecs.h264).toBe(true);
    expect(report.videoCodecs.hevc).toBe(true);
    expect(report.videoProfiles.h264.high).toBe(true);
    expect(report.videoLevels.h264.high).toContain(40);
    expect(report.videoLevels.h264.high).toContain(62);
    expect(report.videoProfiles.vp9.profile0).toBe(true);
    expect(report.audioProfiles.aac.lc).toBe(true);
    expect(report.mediaCapabilities.h2644k).toEqual({
      supported: true,
      smooth: true,
      powerEfficient: false,
    });
  });

  it('completes with conservative codec-only results when MediaCapabilities is unavailable', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    originalMediaCapabilities = Object.getOwnPropertyDescriptor(navigator, 'mediaCapabilities');
    Object.defineProperty(navigator, 'mediaCapabilities', { configurable: true, value: undefined });
    const report = await detectPlaybackCapabilities();
    expect(report.videoCodecs.h264).toBe(false);
    expect(report.mediaCapabilities).toEqual({});
  });
});
