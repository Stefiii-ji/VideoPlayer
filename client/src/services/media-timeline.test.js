import { describe, expect, it } from 'vitest';
import { getSeekableTimeline, resolveSeekTime } from './media-timeline.js';

function media({ duration = 100, ranges = [] } = {}) {
  return {
    duration,
    seekable: {
      length: ranges.length,
      start: (index) => ranges[index][0],
      end: (index) => ranges[index][1],
    },
  };
}

describe('media seek timeline', () => {
  it('uses the probed duration when an HLS playlist reports an infinite duration', () => {
    const timeline = getSeekableTimeline(media({ duration: Infinity, ranges: [[0, 25]] }), 90);
    expect(timeline.duration).toBe(90);
    expect(timeline.seekableEnd).toBe(25);
    expect(resolveSeekTime(20, timeline)).toBe(20);
  });

  it('keeps actual seekable ranges instead of clipping them to duration metadata', () => {
    const timeline = getSeekableTimeline(media({
      ranges: [[0, 20], [30, 125], [50, 50], [-5, -1]],
    }));
    expect(timeline.ranges).toEqual([
      { start: -5, end: -1 },
      { start: 0, end: 20 },
      { start: 30, end: 125 },
    ]);
    expect(timeline.seekableStart).toBe(-5);
    expect(timeline.seekableEnd).toBe(125);
  });

  it('preserves non-zero timeline offsets and exposes the actual slider bounds', () => {
    const timeline = getSeekableTimeline(media({
      duration: Infinity,
      ranges: [[120, 145]],
    }), 90);
    expect(timeline.duration).toBe(90);
    expect(timeline.seekableStart).toBe(120);
    expect(timeline.seekableEnd).toBe(145);
    expect(timeline.timelineEnd).toBe(145);
    expect(resolveSeekTime(132, timeline)).toBe(132);
    expect(resolveSeekTime(110, timeline)).toBe(120);
  });

  it('does not claim seeking works before the media exposes a seekable range', () => {
    const timeline = getSeekableTimeline(media({ ranges: [] }));
    expect(resolveSeekTime(10, timeline)).toBeNull();
  });

  it('clamps seeks across discontinuities to the nearest actual range', () => {
    const timeline = getSeekableTimeline(media({ ranges: [[0, 20], [30, 60]] }));
    expect(resolveSeekTime(24, timeline)).toBe(20);
    expect(resolveSeekTime(27, timeline)).toBe(30);
  });

  it('defers forward seeks until an HLS range grows to include the target', () => {
    const timeline = getSeekableTimeline(media({ ranges: [[0, 25]] }));
    expect(resolveSeekTime(45, timeline)).toBeNull();
    expect(resolveSeekTime(45, getSeekableTimeline(media({ ranges: [[0, 50]] })))).toBe(45);
  });
});
