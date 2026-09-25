import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/auth/AuthContext';
import type { UserRole } from '../../../src/types/models';

/**
 * Wraps a screen that belongs to some roles and not others. Somebody who
 * lands here anyway (a stale link, a bookmark) sees why, in this section's
 * own terms, rather than a blank 403. The server refuses the same people.
 */
export function RoleOnly({
  roles,
  title,
  message,
  children,
}: {
  roles: UserRole[];
  title: string;
  message: string;
  children: React.ReactNode;
}): JSX.Element {
  const { user } = useAuth();

  if (!user || !roles.includes(user.role)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base normal-case tracking-normal text-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    );
  }

  return <>{children}</>;
}

export function CorporateOnly({
  message,
  children,
}: {
  message: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <RoleOnly roles={['corporate']} title="Corporate only" message={message}>
      {children}
    </RoleOnly>
  );
}
