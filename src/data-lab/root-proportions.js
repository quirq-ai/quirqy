export const ROOT_REFERENCE_WIDTH = 160;
export const ROOT_TIER_HEIGHT = 16;
export const ROOT_LENGTH_PER_TOUCH = 6;

/**
 * Match vertical root reach and each touch's growth to the repository's width.
 * The established compact composition is the minimum. Callers can pin a head
 * width while replaying history so a file's growth unit never changes per frame.
 * Horizontal packing is independent: these proportions never rescale X or Z.
 */
export function createRootProportions(repositoryWidth = ROOT_REFERENCE_WIDTH) {
  const width = Number.isFinite(repositoryWidth) && repositoryWidth >= 0 ? repositoryWidth : ROOT_REFERENCE_WIDTH;
  const scale = Math.max(1, width / ROOT_REFERENCE_WIDTH);
  return {
    repositoryWidth: width,
    referenceWidth: ROOT_REFERENCE_WIDTH,
    scale,
    tierHeight: ROOT_TIER_HEIGHT * scale,
    lengthPerTouch: ROOT_LENGTH_PER_TOUCH * scale,
  };
}
