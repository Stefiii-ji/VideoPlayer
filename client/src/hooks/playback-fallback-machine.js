export const FALLBACK_STAGES = Object.freeze({
  DIRECT: 'direct',
  REMUX_OR_TRANSCODE: 'remux-or-transcode',
  COMPATIBLE_TRANSCODE: 'compatible-transcode',
  ORIGINAL: 'original',
});

export function createFallbackMachine() {
  return { stage: FALLBACK_STAGES.DIRECT, inFlight: null };
}

// Fallback requests move direct -> remux/transcode; a full transcode marks the
// compatible-transcode stage, and the original file is terminal until retry.
export function transitionFallbackMachine(machine, action) {
  switch (action.type) {
    case 'reset':
      return createFallbackMachine();
    case 'fallback-requested':
      return machine.stage === FALLBACK_STAGES.ORIGINAL
        ? machine
        : { ...machine, stage: FALLBACK_STAGES.REMUX_OR_TRANSCODE };
    case 'playback-selected':
      if (machine.stage === FALLBACK_STAGES.ORIGINAL) return machine;
      if (action.strategy === 'full-transcode') {
        return { ...machine, stage: FALLBACK_STAGES.COMPATIBLE_TRANSCODE };
      }
      if (action.strategy === 'direct') {
        return { ...machine, stage: FALLBACK_STAGES.DIRECT };
      }
      return { ...machine, stage: FALLBACK_STAGES.REMUX_OR_TRANSCODE };
    case 'original-requested':
      return { ...machine, stage: FALLBACK_STAGES.ORIGINAL };
    case 'request-settled':
      return { ...machine, inFlight: null };
    default:
      throw new Error(`Unknown playback fallback transition: ${action.type}`);
  }
}
