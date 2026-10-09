import * as React from 'react';
import type { SignatureBox } from '../../../src/types/serviceAgreement';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import { trimToInk } from '@/components/SignDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Drawing the customer's signature once, for a service agreement: it goes in
 * the box that was tapped, and each other box is signed with a tap.
 */
export function DrawSignatureDialog({
  box,
  onClose,
  onDrawn,
}: {
  box: SignatureBox | null;
  onClose: () => void;
  onDrawn: (signature: { blob: Blob; url: string }) => void;
}): JSX.Element {
  const pad = React.useRef<SignaturePadHandle>(null);
  const [empty, setEmpty] = React.useState(false);
  return (
    <Dialog open={!!box} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Customer signature</DialogTitle>
          <DialogDescription>
            Draw your signature once. It is placed in this box, and you tap each other box on the agreement to sign it
            too.
          </DialogDescription>
        </DialogHeader>
        <SignaturePad ref={pad} />
        {empty ? <p className="text-sm text-critical">Sign in the box first.</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => pad.current?.clear()}>
            Clear
          </Button>
          <Button
            type="button"
            onClick={async () => {
              const drawn = pad.current?.isEmpty() ? null : await pad.current?.toBlob();
              if (!drawn) return setEmpty(true);
              setEmpty(false);
              const blob = await trimToInk(drawn);
              onDrawn({ blob, url: URL.createObjectURL(blob) });
            }}
          >
            Sign
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

