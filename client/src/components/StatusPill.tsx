import { Badge } from '@/components/ui/badge';
import { humanize, toneOf } from '@/lib/format';

export function StatusPill({ status }: { status: string | null | undefined }): JSX.Element {
  if (!status) return <Badge variant="neutral">—</Badge>;
  return (
    <Badge variant={toneOf(status)} dot>
      {humanize(status)}
    </Badge>
  );
}
