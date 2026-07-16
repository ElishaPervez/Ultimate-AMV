const FRAME_MS = 1000 / 60;

export const GRID_GRAB_MOMENTUM_DECAY_PER_FRAME = 0.9;
export const GRID_GRAB_MOMENTUM_STOP_PX_PER_MS = 0.015;
export const GRID_GRAB_MOMENTUM_MAX_PX_PER_MS = 3;
export const GRID_GRAB_MOMENTUM_MAX_STEP_MS = 32;
export const GRID_GRAB_MOMENTUM_RELEASE_WINDOW_MS = 80;

export function sampleGrabVelocity(
  currentVelocity: number,
  scrollDelta: number,
  elapsedMs: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return currentVelocity;
  const sample = Math.max(
    -GRID_GRAB_MOMENTUM_MAX_PX_PER_MS,
    Math.min(GRID_GRAB_MOMENTUM_MAX_PX_PER_MS, scrollDelta / elapsedMs),
  );
  return currentVelocity * 0.35 + sample * 0.65;
}

export function stepGrabMomentum(
  velocityPxPerMs: number,
  elapsedMs: number,
): { distance: number; velocity: number } {
  if (!Number.isFinite(velocityPxPerMs) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { distance: 0, velocity: 0 };
  }

  const stepMs = Math.min(elapsedMs, GRID_GRAB_MOMENTUM_MAX_STEP_MS);
  const decay = Math.pow(GRID_GRAB_MOMENTUM_DECAY_PER_FRAME, stepMs / FRAME_MS);
  const nextVelocity = velocityPxPerMs * decay;
  const decayRatePerMs = -Math.log(GRID_GRAB_MOMENTUM_DECAY_PER_FRAME) / FRAME_MS;
  const distance = velocityPxPerMs * (1 - decay) / decayRatePerMs;

  return {
    distance,
    velocity: Math.abs(nextVelocity) < GRID_GRAB_MOMENTUM_STOP_PX_PER_MS ? 0 : nextVelocity,
  };
}
