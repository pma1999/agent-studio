import type { PanInfo } from 'framer-motion';

/** Drag distance (px) past which a swipe counts as a dismiss. */
export const SWIPE_DISMISS_OFFSET = 80;
/** Drag velocity (px/s) past which a swipe counts as a dismiss regardless of distance. */
export const SWIPE_DISMISS_VELOCITY = 500;

/**
 * Shared threshold logic for framer-motion swipe-to-dismiss gestures
 * (bottom sheets, drawer-close, swipe-to-delete). `direction` is the sign of
 * the dismiss direction on the given axis (e.g. drawer closes leftward → -1).
 */
export function shouldDismiss(
  info: PanInfo,
  axis: 'x' | 'y' = 'y',
  direction: 1 | -1 = 1
): boolean {
  const offset = info.offset[axis] * direction;
  const velocity = info.velocity[axis] * direction;
  return offset > SWIPE_DISMISS_OFFSET || velocity > SWIPE_DISMISS_VELOCITY;
}
