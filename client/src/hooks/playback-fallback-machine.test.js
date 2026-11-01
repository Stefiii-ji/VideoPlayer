import { describe, expect, it } from 'vitest';
import {
  createFallbackMachine,
  FALLBACK_STAGES,
  transitionFallbackMachine,
} from './playback-fallback-machine.js';

describe('playback fallback state machine', () => {
  it('moves from direct playback through a compatible transcode to the original file', () => {
    let machine = createFallbackMachine();
    expect(machine.stage).toBe(FALLBACK_STAGES.DIRECT);

    machine = transitionFallbackMachine(machine, { type: 'fallback-requested' });
    expect(machine.stage).toBe(FALLBACK_STAGES.REMUX_OR_TRANSCODE);

    machine = transitionFallbackMachine(machine, {
      type: 'playback-selected',
      strategy: 'full-transcode',
    });
    expect(machine.stage).toBe(FALLBACK_STAGES.COMPATIBLE_TRANSCODE);

    machine = transitionFallbackMachine(machine, { type: 'original-requested' });
    expect(machine.stage).toBe(FALLBACK_STAGES.ORIGINAL);
  });

  it('keeps the original-file stage terminal until a retry resets the machine', () => {
    let machine = transitionFallbackMachine(createFallbackMachine(), { type: 'original-requested' });

    machine = transitionFallbackMachine(machine, { type: 'fallback-requested' });
    expect(machine.stage).toBe(FALLBACK_STAGES.ORIGINAL);

    machine = transitionFallbackMachine(machine, { type: 'reset' });
    expect(machine).toEqual({ stage: FALLBACK_STAGES.DIRECT, inFlight: null });
  });

  it('preserves the in-flight request across transitions until it settles', () => {
    const request = Promise.resolve();
    let machine = { ...createFallbackMachine(), inFlight: request };

    machine = transitionFallbackMachine(machine, { type: 'fallback-requested' });
    expect(machine.inFlight).toBe(request);

    machine = transitionFallbackMachine(machine, { type: 'request-settled' });
    expect(machine.inFlight).toBeNull();
  });
});
