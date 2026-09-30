import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/PageHeader';

/**
 * The Business Console's slot for Meta (Facebook and Instagram) ads
 * performance. The console restructure moved this section here from the
 * main menu; when the ads performance page itself is added, it mounts at
 * /business/meta-ads in App.tsx in place of this card, unchanged.
 */
export function MetaAds(): JSX.Element {
  return (
    <>
      <PageHeader title="Meta Ads" subtitle="Facebook and Instagram ads performance" />
      <Card>
        <CardHeader>
          <CardTitle className="text-base normal-case tracking-normal text-foreground">
            Not connected yet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="max-w-[60ch] text-sm text-muted-foreground">
            The Meta ads performance page lives in the Business Console. It has not been added to this installation
            yet; once it is, it appears here.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
