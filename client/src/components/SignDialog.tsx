import * as React from 'react';
import type { SignatureField } from '@/components/AgreementPdf';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface Signature {
  url: string;
  blob: Blob;
}

/** The signing pad, full width, for whichever line was tapped. */
export function SignDialog({
  field,
  onClose,
  onSigned,
  onClear,
  hasSignature,
}: {
  field: SignatureField | null;
  onClose: () => void;
  onSigned: (field: SignatureField, signature: Signature) => void;
  onClear?: (field: SignatureField) => void;
  hasSignature: boolean;
}): JSX.Element {
  const pad = React.useRef<SignaturePadHandle>(null);
  const [empty, setEmpty] = React.useState(false);
  const title = field === 'provider_signature' ? 'Service provider signature' : 'Customer signature';

  const accept = async (): Promise<void> => {
    if (!field) return;
    const drawn = pad.current?.isEmpty() ? null : await pad.current?.toBlob();
    if (!drawn) {
      setEmpty(true);
      return;
    }
    const blob = await trimToInk(drawn);
    onSigned(field, { blob, url: URL.createObjectURL(blob) });
  };

  return (
    <Dialog open={!!field} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {field === 'provider_signature'
              ? 'Sign for Drift Property Services.'
              : 'By signing, the customer agrees to the agreement above, including the Terms & Conditions on page 2.'}
          </DialogDescription>
        </DialogHeader>
        <SignaturePad ref={pad} />
        {empty ? <p className="mt-2 text-sm text-critical">Sign in the box first.</p> : null}
        <div className="mt-4 flex justify-between gap-2">
          {hasSignature && field && onClear ? (
            <Button type="button" variant="destructive" onClick={() => onClear(field)}>
              Remove signature
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            onClick={() => {
              setEmpty(false);
              void accept();
            }}
          >
            Put signature on agreement
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


/**
 * The pad is the width of the screen and most of it is blank. Cut the image
 * down to the ink, so on the agreement's signature line it is the signature
 * that fills the space rather than the empty pad around it.
 */
export async function trimToInk(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) return blob;
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);

  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 16) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return blob;

  const pad = Math.round(Math.max(right - left, bottom - top) * 0.04) + 4;
  const x = Math.max(0, left - pad);
  const y = Math.max(0, top - pad);
  const w = Math.min(width, right + pad + 1) - x;
  const h = Math.min(height, bottom + pad + 1) - y;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')?.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return new Promise((resolve) => out.toBlob((b) => resolve(b ?? blob), 'image/png'));
}
