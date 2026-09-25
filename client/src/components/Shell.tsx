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
  MapPin,
  Menu,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/theme/ThemeToggle';
import type { UserRole } from '../../../src/types/models';
import logo from '@/assets/drift-logo.jpg';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Who sees it. Selling and clearing are different jobs. */
  roles: UserRole[];
  end?: boolean;
}

const ALL: UserRole[] = ['corporate', 'sales', 'operator'];
const SELLERS: UserRole[] = ['corporate', 'sales'];
const CREW: UserRole[] = ['corporate', 'operator'];
const CORPORATE: UserRole[] = ['corporate'];

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ALL, end: true },
  { to: '/leads', label: 'Leads', icon: MapPin, roles: SELLERS },
  { to: '/customers', label: 'Customers', icon: Users, roles: SELLERS },
  { to: '/quotes', label: 'Quotes', icon: FileText, roles: SELLERS },
  { to: '/contracts', label: 'Contracts', icon: ClipboardCheck, roles: SELLERS },
  { to: '/work-orders', label: 'Dispatch', icon: Truck, roles: CREW },
  { to: '/invoices', label: 'Invoices', icon: Receipt, roles: CORPORATE },
  { to: '/operators', label: 'Crew', icon: HardHat, roles: CREW },
  { to: '/reports', label: 'Reports', icon: BarChart3, roles: CORPORATE },
  { to: '/admin', label: 'Company', icon: Building2, roles: CORPORATE },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, roles: CORPORATE },
];

/**
 * On a phone the sidebar becomes a bar of tabs along the bottom, where a
 * thumb reaches while the other hand holds a clipboard or a shovel. These are
 * the sections that earn a tab, most-used first; each person gets the first
 * four they're allowed to see, and everything else lives behind "More".
 */
const PHONE_TABS = ['/', '/leads', '/work-orders', '/customers', '/quotes', '/contracts', '/operators'];
const PHONE_TAB_COUNT = 4;

const ROLE_LABEL: Record<UserRole, string> = {
  corporate: 'Corporate',
  sales: 'Sales rep',
  operator: 'Operator',
};

function initials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

/** The section a path belongs to, so /customers/abc still lights up Customers. */
function sectionFor(pathname: string, items: NavItem[]): NavItem | undefined {
  return items.find(({ to, end }) =>
    end || to === '/' ? pathname === to : pathname === to || pathname.startsWith(`${to}/`),
  );
}

function SectionLinks({ items }: { items: NavItem[] }): JSX.Element {
  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-[720px]:py-3 max-[720px]:text-sm',
              isActive && 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)] hover:bg-primary/15 hover:text-primary',
            )
          }
        >
          <Icon className="size-4 shrink-0" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function Account(): JSX.Element | null {
  const { user, signOut } = useAuth();
  if (!user) return null;

  return (
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
            <p className="text-xs text-muted-foreground">{ROLE_LABEL[user.role]}</p>
          </div>
        </div>
        <ThemeToggle />
      </div>
      <Button variant="secondary" size="sm" className="justify-start gap-2" onClick={signOut}>
        <LogOut className="size-3.5" /> Sign out
      </Button>
    </div>
  );
}

export function Shell(): JSX.Element {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Picking a section from the menu navigates; the menu shouldn't linger
  // over the page it just opened.
  useEffect(() => setMenuOpen(false), [pathname]);

  if (!user) return <Outlet />;

  const items = NAV.filter((item) => item.roles.includes(user.role));
  const current = sectionFor(pathname, items);
  const tabs = PHONE_TABS.map((to) => items.find((item) => item.to === to))
    .filter((item): item is NavItem => item !== undefined)
    .slice(0, PHONE_TAB_COUNT);
  const onTab = current !== undefined && tabs.includes(current);

  return (
    <div className="grid min-h-screen grid-cols-[224px_minmax(0,1fr)] max-[720px]:grid-cols-1 max-[720px]:content-start">
      <aside className="flex flex-col gap-6 border-r border-border bg-background/70 p-3.5 backdrop-blur-xl max-[720px]:hidden">
        <div className="px-2">
          <img src={logo} alt="Drift Property Services" className="h-9 w-auto rounded-md" />
        </div>
        <SectionLinks items={items} />
        <Account />
      </aside>

      {/* Phone: a slim bar on top saying where you are, tabs on the bottom. */}
      <header className="sticky top-0 z-40 hidden items-center gap-3 border-b border-border bg-background/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl max-[720px]:flex">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <Menu className="size-5" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {current?.label ?? 'Drift'}
        </p>
        <img src={logo} alt="Drift Property Services" className="mr-1 h-7 w-auto rounded" />
      </header>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent>
          <div className="px-2">
            <img src={logo} alt="" className="h-9 w-auto rounded-md" />
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription className="sr-only">Every section you can open</SheetDescription>
          </div>
          <div className="-mx-1 overflow-y-auto px-1">
            <SectionLinks items={items} />
          </div>
          <Account />
        </SheetContent>
      </Sheet>

      <main className="max-w-[1160px] px-8 py-7 pb-16 max-[720px]:px-4 max-[720px]:pb-[calc(5rem+env(safe-area-inset-bottom))] max-[720px]:pt-4">
        <Outlet />
      </main>

      <nav
        aria-label="Quick sections"
        className="fixed inset-x-0 bottom-0 z-40 hidden border-t border-border bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl max-[720px]:block"
      >
        <div className="flex">
          {tabs.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors',
                  isActive && 'text-primary',
                )
              }
            >
              <Icon className="size-5" />
              <span className="max-w-full truncate px-1">{label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className={cn(
              'flex h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors',
              current !== undefined && !onTab && 'text-primary',
            )}
          >
            <Menu className="size-5" />
            More
          </button>
        </div>
      </nav>
    </div>
  );
}
