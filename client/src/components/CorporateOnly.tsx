import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/auth/AuthContext';

/**
 * Wraps a corporate-only screen. An operator who lands here (a stale link, a
 * bookmark) sees why, in this section's own terms, rather than a blank 403.
 */
export function CorporateOnly({
  message,
  children,
}: {
  message: string;
  children: React.ReactNode;
}): JSX.Element {
  const { isCorporate } = useAuth();

  if (!isCorporate) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base normal-case tracking-normal text-foreground">
            Corporate only
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    );
  }

  return <>{children}</>;
}
