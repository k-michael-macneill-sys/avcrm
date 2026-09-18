import { h } from './dom.js';

/**
 * The signature pad.
 *
 * A canvas the customer signs on with a finger or a mouse. Pointer events
 * rather than mouse or touch events, so a stylus, a fingertip and a trackpad
 * are all the same code path, and the canvas is backed at device pixel ratio
 * so a signature on a phone is not a blurry approximation of one.
 */

export interface SignaturePad {
  node: HTMLElement;
  /** Null until something has actually been drawn. */
  toBlob: () => Promise<Blob | null>;
  isEmpty: () => boolean;
  clear: () => void;
}

const LINE_WIDTH = 2.2;
const HEIGHT = 180;

export function signaturePad(): SignaturePad {
  const canvas = h('canvas', { class: 'sig-canvas', 'aria-label': 'Signature pad' });
  const context = canvas.getContext('2d');
  let drawn = false;
  let drawing = false;

  const hint = h('p', { class: 'sig-hint' }, 'Sign above with a finger or the mouse');
  const clearButton = h(
    'button',
    {
      type: 'button',
      class: 'linkish',
      onclick: () => clear(),
    },
    'Clear',
  );

  function resize(): void {
    if (!context) return;
    // Preserve what is already drawn across a resize — an orientation change
    // mid-signature should not wipe it.
    const previous = drawn ? canvas.toDataURL('image/png') : null;

    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 480;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(HEIGHT * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    context.lineWidth = LINE_WIDTH;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    // Ink, not theme text: this image is printed and emailed, where the
    // reader's dark mode does not apply.
    context.strokeStyle = '#111111';

    if (previous) {
      const image = new Image();
      image.onload = () => context.drawImage(image, 0, 0, width, HEIGHT);
      image.src = previous;
    }
  }

  function positionOf(event: PointerEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!context) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    drawn = true;
    const [x, y] = positionOf(event);
    context.beginPath();
    context.moveTo(x, y);
    // A tap with no drag is still a mark.
    context.lineTo(x + 0.01, y);
    context.stroke();
    hint.textContent = '';
  });

  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (!drawing || !context) return;
    event.preventDefault();
    const [x, y] = positionOf(event);
    context.lineTo(x, y);
    context.stroke();
  });

  const stop = (event: PointerEvent) => {
    if (!drawing) return;
    drawing = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  function clear(): void {
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
    hint.textContent = 'Sign above with a finger or the mouse';
  }

  const node = h(
    'div',
    { class: 'sig-pad' },
    canvas,
    h('div', { class: 'sig-foot' }, hint, clearButton),
  );

  // The canvas has no size until it is in the document.
  requestAnimationFrame(resize);
  window.addEventListener('resize', resize);

  return {
    node,
    isEmpty: () => !drawn,
    clear,
    toBlob: () =>
      new Promise<Blob | null>((resolve) => {
        if (!drawn) {
          resolve(null);
          return;
        }
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      }),
  };
}
