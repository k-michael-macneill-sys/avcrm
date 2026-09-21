import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Every screen's grouping unit — a titled glass card. */
export function Section({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
