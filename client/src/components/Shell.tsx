import {
  LayoutDashboard,
  Users,
  FileText,
  ClipboardCheck,
  Truck,
  Receipt,
  HardHat,
  BarChart3,
  Building2,
  Settings as SettingsIcon,
  LogOut,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/theme/ThemeToggle';
import logo from '@/assets/drift-logo.jpg';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  corporateOnly?: boolean;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/quotes', label: 'Quotes', icon: FileText },
  { to: '/contracts', label: 'Contracts', icon: ClipboardCheck },
  { to: '/work-orders', label: 'Dispatch', icon: Truck },
  { to: '/invoices', label: 'Invoices', icon: Receipt, corporateOnly: true },
  { to: '/operators', label: 'Crew', icon: HardHat },
  { to: '/reports', label: 'Reports', icon: BarChart3, corporateOnly: true },
  { to: '/admin', label: 'Company', icon: Building2, corporateOnly: true },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, corporateOnly: true },
];

function initials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

export function Shell(): JSX.Element {
  const { user, isCorporate, signOut } = useAuth();
  if (!user) return <Outlet />;

  const items = NAV.filter((item) => !item.corporateOnly || isCorporate);

  return (
    <div className="grid min-h-screen grid-cols-[224px_minmax(0,1fr)] max-[720px]:grid-cols-1">
      <aside className="flex flex-col gap-6 border-r border-border bg-background/70 p-3.5 backdrop-blur-xl">
        <div className="px-2">
          <img src={logo} alt="Drift Property Services" className="h-9 w-auto rounded-md" />
        </div>

        <nav aria-label="Sections" className="flex flex-col gap-0.5">
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  isActive && 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)] hover:bg-primary/15 hover:text-primary',
                )
              }
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Avatar>
                <AvatarFallback>{initials(user.first_name, user.last_name)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium leading-tight text-foreground">
                  {user.first_name} {user.last_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {user.role === 'corporate' ? 'Corporate' : 'Operator'}
                </p>
              </div>
            </div>
            <ThemeToggle />
          </div>
          <Button variant="secondary" size="sm" className="justify-start gap-2" onClick={signOut}>
            <LogOut className="size-3.5" /> Sign out
          </Button>
        </div>
      </aside>

      <main className="max-w-[1160px] px-8 py-7 pb-16 max-[720px]:px-4">
        <Outlet />
      </main>
    </div>
  );
}
