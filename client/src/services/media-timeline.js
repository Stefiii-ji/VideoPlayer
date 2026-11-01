function positiveFinite(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function getSeekableTimeline(video, fallbackDuration = 0) {
  const ranges = [];
  const mediaDuration = positiveFinite(video.duration);
  const metadataDuration = positiveFinite(fallbackDuration);
  const knownDuration = mediaDuration || metadataDuration;
  const seekable = video.seekable;

  for (let index = 0; index < (seekable?.length ?? 0); index += 1) {
    let start;
    let rawEnd;
    try {
      start = seekable.start(index);
      rawEnd = seekable.end(index);
    } catch {
      continue;
    }
    if (!Number.isFinite(start) || !Number.isFinite(rawEnd)) continue;
    if (rawEnd > start) ranges.push({ start, end: rawEnd });
  }
  ranges.sort((left, right) => left.start - right.start);

  const firstRange = ranges[0];
  const lastRange = ranges[ranges.length - 1];
  return {
    duration: knownDuration || lastRange?.end || 0,
    ranges,
    seekableStart: firstRange?.start ?? 0,
    seekableEnd: lastRange?.end || 0,
    timelineEnd: mediaDuration
      || (firstRange && firstRange.start <= 0 ? metadataDuration : 0)
      || lastRange?.end
      || metadataDuration,
  };
}

export function resolveSeekTime(requestedTime, timeline) {
  if (!Number.isFinite(requestedTime) || timeline.ranges.length === 0) return null;
  const target = requestedTime;
  const lastRange = timeline.ranges[timeline.ranges.length - 1];
  if (target < timeline.ranges[0].start) return timeline.ranges[0].start;
  if (target > lastRange.end) return null;

  for (const range of timeline.ranges) {
    if (target >= range.start && target <= range.end) return target;
  }

  let closestTime = timeline.ranges[0].start;
  let closestDistance = Math.abs(target - closestTime);
  for (const range of timeline.ranges) {
    const distanceToStart = Math.abs(target - range.start);
    const distanceToEnd = Math.abs(target - range.end);
    if (distanceToStart < closestDistance) {
      closestTime = range.start;
      closestDistance = distanceToStart;
    }
    if (distanceToEnd < closestDistance) {
      closestTime = range.end;
      closestDistance = distanceToEnd;
    }
  }
  return closestTime;
}
