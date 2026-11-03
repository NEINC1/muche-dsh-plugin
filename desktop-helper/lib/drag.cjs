// Drag owns screen-DIP position math only. The window size belongs to the helper's init
// geometry: feeding observed bounds back into setBounds re-rounds DIP at fractional display
// scales and ratchets the artwork's scale, so it is never carried here.
function beginDrag(position, cursor) {
  return { origin: { x: position.x, y: position.y }, cursor: { x: cursor.x, y: cursor.y }, moved: false }
}
function moveDrag(drag, cursor, threshold = 4) {
  const dx = cursor.x - drag.cursor.x, dy = cursor.y - drag.cursor.y
  const moved = drag.moved || Math.hypot(dx, dy) >= threshold
  return { moved, x: Math.round(drag.origin.x + (moved ? dx : 0)), y: Math.round(drag.origin.y + (moved ? dy : 0)) }
}
module.exports = { beginDrag, moveDrag }
