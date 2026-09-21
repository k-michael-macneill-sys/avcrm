import * as React from 'react';

/**
 * The signature pad. A canvas the customer signs on with a finger or a
 * mouse. Pointer events rather than mouse or touch events, so a stylus, a
 * fingertip and a trackpad are all the same code path, and the canvas is
 * backed at device pixel ratio so a signature on a phone is not a blurry
 * approximation of one.
 */

const LINE_WIDTH = 2.2;
const HEIGHT = 180;

export interface SignaturePadHandle {
  toBlob: () => Promise<Blob | null>;
  isEmpty: () => boolean;
  clear: () => void;
}

export const SignaturePad = React.forwardRef<SignaturePadHandle>(function SignaturePad(
  _props,
  ref,
) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawnRef = React.useRef(false);
  const drawingRef = React.useRef(false);
  const [hint, setHint] = React.useState('Sign above with a finger or the mouse');

  React.useImperativeHandle(ref, () => ({
    isEmpty: () => !drawnRef.current,
    clear: () => clear(),
    toBlob: () =>
      new Promise<Blob | null>((resolve) => {
        const canvas = canvasRef.current;
        if (!drawnRef.current || !canvas) {
          resolve(null);
          return;
        }
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      }),
  }));

  function clear(): void {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawnRef.current = false;
    setHint('Sign above with a finger or the mouse');
  }

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    function resize(): void {
      if (!canvas || !context) return;
      const previous = drawnRef.current ? canvas.toDataURL('image/png') : null;

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
      const rect = canvas!.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    }

    function onDown(event: PointerEvent): void {
      event.preventDefault();
      canvas!.setPointerCapture(event.pointerId);
      drawingRef.current = true;
      drawnRef.current = true;
      const [x, y] = positionOf(event);
      context!.beginPath();
      context!.moveTo(x, y);
      context!.lineTo(x + 0.01, y);
      context!.stroke();
      setHint('');
    }

    function onMove(event: PointerEvent): void {
      if (!drawingRef.current) return;
      event.preventDefault();
      const [x, y] = positionOf(event);
      context!.lineTo(x, y);
      context!.stroke();
    }

    function onStop(event: PointerEvent): void {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      if (canvas!.hasPointerCapture(event.pointerId)) canvas!.releasePointerCapture(event.pointerId);
    }

    requestAnimationFrame(resize);
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onStop);
    canvas.addEventListener('pointercancel', onStop);
    canvas.addEventListener('pointerleave', onStop);

    return () => {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onStop);
      canvas.removeEventListener('pointercancel', onStop);
      canvas.removeEventListener('pointerleave', onStop);
    };
  }, []);

  return (
    <div className="mb-4">
      <canvas
        ref={canvasRef}
        aria-label="Signature pad"
        className="block h-[180px] w-full touch-none rounded-xl border border-dashed border-input bg-white"
        style={{ cursor: 'crosshair' }}
      />
      <div className="mt-1.5 flex min-h-[20px] items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{hint}</p>
        <button type="button" className="text-xs text-primary hover:underline" onClick={clear}>
          Clear
        </button>
      </div>
    </div>
  );
});
