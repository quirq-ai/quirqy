const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Place a measured commit bubble beside its projected author portrait. Bounds
 * reserve room for surrounding controls; the caller constrains the bubble size
 * to that rectangle before measuring. `side` describes the bubble's position
 * relative to the portrait, and `tail` is an offset along the facing edge.
 * Set allowSide=false when a tall reading panel needs a clear author row above it.
 */
export function placeCommitBubble({ x, y, width, height, bubbleWidth, bubbleHeight, bounds = {}, allowSide = true }) {
  const { left: minX = 12, top: minY = 12, right = width - 12, bottom = height - 12 } = bounds;
  let left, top, side;
  const rightX = x + 34;
  const leftX = x - 34 - bubbleWidth;

  if (allowSide && width > 600 && rightX >= minX && rightX + bubbleWidth <= right) {
    left = rightX;
    top = y + 18 - bubbleHeight;
    side = 'right';
  } else if (allowSide && width > 600 && leftX >= minX && leftX + bubbleWidth <= right) {
    left = leftX;
    top = y + 18 - bubbleHeight;
    side = 'left';
  } else {
    left = x - bubbleWidth / 2;
    const aboveY = y - 34 - bubbleHeight;
    if (aboveY >= minY && aboveY + bubbleHeight <= bottom) {
      top = aboveY;
      side = 'above';
    } else {
      top = y + 64;
      side = 'below';
    }
  }

  left = clamp(left, minX, right - bubbleWidth);
  top = clamp(top, minY, bottom - bubbleHeight);
  const lateral = side === 'right' || side === 'left';
  const edge = lateral ? bubbleHeight : bubbleWidth;
  const inset = Math.min(16, edge / 2);
  const tail = clamp(lateral ? y - top : x - left, inset, edge - inset);
  return { left, top, side, tail };
}
