import * as React from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadDocument, fetchFile, formatBytes } from '@/lib/upload';

/** An <img> that fills itself in, and says so plainly when it cannot. */
export function FileImage({
  fileKey,
  alt,
  className,
}: {
  fileKey: string;
  alt: string;
  className?: string;
}): JSX.Element {
  const [src, setSrc] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    fetchFile(fileKey)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'That file did not load');
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileKey]);

  if (error) return <p className="text-xs text-muted-foreground">{error}</p>;
  if (!src) return <div className={className} />;
  // eslint-disable-next-line jsx-a11y/alt-text
  return <img src={src} alt={alt} className={className} />;
}

/**
 * A file picker that hands back the chosen File. `capture` asks a phone for
 * the camera rather than the gallery, which is what an operator standing in
 * a driveway wants.
 */
export function useFilePicker(): {
  file: File | null;
  input: (props: { accept: string; capture?: boolean }) => JSX.Element;
} {
  const [file, setFile] = React.useState<File | null>(null);

  const input = React.useCallback(
    ({ accept, capture }: { accept: string; capture?: boolean }): JSX.Element => (
      <div className="flex flex-col gap-1">
        <input
          type="file"
          accept={accept}
          capture={capture ? 'environment' : undefined}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
        />
        <p className="text-xs text-muted-foreground">
          {file ? `${file.name} — ${formatBytes(file.size)}` : ''}
        </p>
      </div>
    ),
    [file],
  );

  return { file, input };
}

/**
 * A button that fetches a generated document and saves it — download rather
 * than a new tab, because opening a blob URL in a tab is what popup blockers
 * exist to stop, and a document is something people print or attach anyway.
 */
export function DownloadButton({
  path,
  fileName,
  label,
}: {
  path: string;
  fileName: string;
  label: string;
}): JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onClick = (): void => {
    setPending(true);
    setError(null);
    downloadDocument(path, fileName)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPending(false));
  };

  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={onClick}>
        <Download className="size-3.5" /> {pending ? 'Preparing…' : label}
      </Button>
      {error ? <p className="text-xs text-critical">{error}</p> : null}
    </div>
  );
}
