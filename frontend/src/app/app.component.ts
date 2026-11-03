import { Component, OnInit, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthService } from './core/auth.service';
import { ShellComponent, TopbarComponent, CitySwitcherComponent, NavSection, NavItem } from './layout';
import { ToastComponent } from './ui';

/**
 * App shell. Builds the sidebar nav config from the user's permissions and
 * delegates rendering to <tm-shell> + <tm-topbar>. Auth-free routes (signin)
 * bypass the shell.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, ShellComponent, TopbarComponent, CitySwitcherComponent, ToastComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  @ViewChild(ShellComponent) shell?: ShellComponent;

  // Route → page title mapping. Keep in sync with app.routes.ts.
  private static readonly TITLES: Array<[RegExp, string]> = [
    [/^\/dashboard/,                'Dashboard'],
    [/^\/profile/,                  'Profile Settings'],
    [/^\/maps/,                     'Live Operations'],
    [/^\/customers\/[^/]+$/,        'Customer Details'],
    [/^\/customers/,                'Customers'],
    [/^\/drivers\/active/,          'Active Drivers'],
    [/^\/drivers\/deactivated/,     'Deactivated Drivers'],
    [/^\/drivers\/leaderboard/,     'Driver Leaderboard'],
    [/^\/drivers\/performance/,     'Driver Performance'],
    [/^\/drivers\/approvals\/[^/]+/,'Approval Details'],
    [/^\/drivers\/approvals/,       'Driver Approvals'],
    [/^\/drivers\/documents/,       'Document Catalog'],
    [/^\/contact-drivers/,          'Contact Drivers'],
    [/^\/pricing/,                  'Pricing'],
    [/^\/vehicles/,                 ''],
    [/^\/promotions\/coupons/,      'Coupons'],
    [/^\/promotions\/banners/,      'App Banners'],
    [/^\/subscriptions/,            ''],
    [/^\/rides\/all/,               'All Rides'],
    [/^\/rides\/map/,               'Rides Map'],
    [/^\/rides\/manual-dispatch/,   'Manual Dispatch'],
    [/^\/settings\/operator/,       'Operator Settings'],
    [/^\/settings\/app-assets/,     'App Assets'],
    [/^\/settings\/cities/,         'Cities'],
    [/^\/settings\/city/,           'City Settings'],
    [/^\/settings\/fleets/,         'Fleets'],
    [/^\/settings\/vehicle-types/,  'Vehicle Type'],
    [/^\/managers/,                 'Managers'],
    [/^\/roles-permissions/,        'Roles & Permissions'],
    [/^\/finance\/overview/,        'Financial Overview'],
    [/^\/finance\/money-in/,        'Payment In'],
    [/^\/finance\/ledger/,          'Money Ledger'],
    [/^\/analytics\/real-time/,     'Real Time Analytics'],
    [/^\/analytics\/graphs/,        'Analytics Graphs'],
    [/^\/analytics\/reports/,       'Reports'],
    [/^\/safety/,                   'Safety'],
  ];

  /**
   * Routes whose page actually re-scopes to the city chosen in the topbar
   * switcher (they observe CityContextService). The switcher is hidden
   * everywhere else — Vehicles/Ride types, RBAC, Managers, Maps, Operator
   * Settings, etc. are global or carry their own
   * city picker, so showing the global switcher there wrongly implies the
   * page's data is per-city. Keep in sync with app.routes.ts.
   */
  private static readonly CITY_SCOPED: RegExp[] = [
    /^\/pricing\b/,
    /^\/vehicles\b/,
    /^\/operations\b/,
    /^\/vehicle-seat-layouts\b/,
    /^\/promotions\/coupons\b/,
    /^\/subscriptions\b/,
    /^\/fixed-departures\b/,
    /^\/fixed-routes\b/,
    /^\/shuttle-bookings\b/,
    /^\/rides\b/,
    /^\/settings\/(cities|city|fleets|vehicle-types|operator)\b/,
  ];

  private url = signal(this.router.url);
  /** Bumped whenever the auth profile is (re)loaded so pageTitle recomputes. */
  private profileTick = signal(0);

  pageTitle = computed(() => '');

  /** True only on pages that genuinely re-scope to the switched city. */
  showCitySwitcher = computed(() =>
    AppComponent.CITY_SCOPED.some((re) => re.test(this.url())),
  );

  constructor(public router: Router, public auth: AuthService) {}

  ngOnInit(): void {
    if (typeof window !== 'undefined') {
      const theme = localStorage.getItem('dreamcabs_theme');
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    }
    if (this.isAuthorized) {
      this.auth.ensureLoaded().subscribe(() =>
        this.profileTick.update((n) => n + 1),
      );
    }
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.url.set((e as NavigationEnd).urlAfterRedirects);
        if (this.isAuthorized && !this.auth.profile) {
          this.auth.ensureLoaded().subscribe(() =>
            this.profileTick.update((n) => n + 1),
          );
        }
      });
  }

  /** Sidebar nav, filtered by the manager's permissions. */
  get navSections(): NavSection[] {
    const can = (slug: string) => this.auth.hasPermission(slug);
    const canAny = (slugs: string[]) => this.auth.hasAnyPermission(slugs);
    const filterTruthy = (xs: (NavItem | false | 0 | null | undefined)[]): NavItem[] =>
      xs.filter((x): x is NavItem => !!x);

    // Sidebar groups follow the city onboarding workflow:
    //   Home        → Dashboard, pinned above everything else
    //   City Setup  → configure a city (dependency-ordered)
    //   Operations  → run the city day-to-day
    //   Insights    → analytics & reports
    //   Platform    → global, not city-scoped
    const home: NavItem[] = [];
    const citySetup: NavItem[] = [];
    const operations: NavItem[] = [];
    const finance: NavItem[] = [];
    const insights: NavItem[] = [];
    const platform: NavItem[] = [];

    // --- Home (top of nav, no section header) ---
    if (can('dashboard')) home.push({ label: 'Dashboard', icon: 'home', route: '/dashboard' });

    // --- City Setup (dependency order) ---
    // Vehicles is the single workspace for vehicle types, city vehicles, fares,
    // fixed routes, route groups, drivers and seat layouts — the concerns that
    // used to sprawl across several pages. Everything is edited in place.
    if (can('city_settings'))          citySetup.push({ label: 'Cities',        icon: 'map-marker', route: '/settings/cities' });
    if (can('vehicles')) citySetup.push({
      label: 'Master', icon: 'grid',
      children: [
        { label: 'Routes', icon: 'road', route: '/operations/routes' },
        { label: 'Vehicle Configuration', icon: 'car', route: '/operations/vehicle-configuration' },
      ],
    });
    if (can('pricing'))
                                       citySetup.push({ label: 'Pricing',       icon: 'tag', route: '/pricing' });
    if (can('city_settings'))          citySetup.push({ label: 'City Settings', icon: 'cog', route: '/settings/city' });

    if (can('coupons')) {
      citySetup.push({
        label: 'Promotions',
        icon: 'gift',
        initiallyOpen: true,
        children: filterTruthy([
          can('coupons') && { label: 'Coupons', icon: 'gift', route: '/promotions/coupons' },
          can('coupons') && { label: 'Banners', icon: 'image', route: '/promotions/banners' },
        ]),
      });
    }

    if (can('subscriptions'))
                                       citySetup.push({ label: 'Subscriptions', icon: 'star', route: '/subscriptions' });

    if (can('fleets')) citySetup.push({ label: 'Fleets', icon: 'car', route: '/settings/fleets' });

    // --- Operations ---
    if (can('customers')) operations.push({ label: 'Customers', icon: 'user-plus', route: '/customers' });

    if (can('rides')) {
      operations.push({
        label: 'Rides',
        icon: 'road',
        children: filterTruthy([
          can('rides') && { label: 'History', icon: 'calendar', route: '/rides' },
          can('rides') && { label: 'Live', icon: 'map-marker', route: '/fixed-departures' },
        ]),
      });
    }

    if (can('manual_dispatch')) operations.push({ label: 'Manual Dispatch', icon: 'send', route: '/rides/manual-dispatch' });

    if (canAny(['drivers', 'contact_drivers'])) {
      operations.push({
        label: 'Drivers', icon: 'id-card',
        children: filterTruthy([
          can('drivers') && { label: 'All Drivers',           icon: 'user',  route: '/drivers' },
          can('drivers') && { label: 'Approvals & Documents',  icon: 'check', route: '/drivers', queryParams: { tab: 'approvals' } },
          can('drivers') && { label: 'Documents Catalog',      icon: 'edit',  route: '/drivers', queryParams: { tab: 'documents' } },
          // Contact Drivers moved in under Drivers, after Documents Catalog.
          can('contact_drivers') && { label: 'Contact Drivers', icon: 'envelope', route: '/contact-drivers' },
        ]),
      });
    }

    if (can('safety'))          operations.push({ label: 'Safety',          icon: 'shield',     route: '/safety' });

    // --- Finance (Unified Money Ledger + Refunds) ---
    if (can('finance')) {
      finance.push({ label: 'Money Ledger', icon: 'chart-line', route: '/finance/ledger' });
      finance.push({ label: 'Refunds',      icon: 'send',       route: '/refunds' });
    }

    // --- Insights ---
    if (canAny(['analytics','reports'])) {
      insights.push({
        label: 'Analytics', icon: 'chart-bar',
        children: filterTruthy([
          can('analytics') && { label: 'Real Time', icon: 'chart-line', route: '/analytics/real-time' },
          can('analytics') && { label: 'Graphs',    icon: 'chart-bar',  route: '/analytics/graphs' },
          can('reports') && { label: 'Reports',   icon: 'chart-line', route: '/analytics/reports' },
        ]),
      });
    }

    // --- Platform (global, not city-scoped) ---
    if (can('app_assets')) platform.push({ label: 'App Assets', icon: 'upload', route: '/settings/app-assets' });
    if (can('operator_settings')) platform.push({ label: 'Operator Settings',  icon: 'cog',    route: '/settings/operator' });
    if (can('managers')) platform.push({ label: 'Managers',           icon: 'users',  route: '/managers' });
    if (can('roles_permissions'))    platform.push({ label: 'Roles & Permissions', icon: 'shield', route: '/roles-permissions' });

    return [
      { items: home },                            // unlabeled — sits at the very top
      { label: 'City Setup', items: citySetup },
      { label: 'Operations', items: operations },
      { label: 'Finance',    items: finance },
      { label: 'Insights',   items: insights },
      { label: 'Platform',   items: platform },
    ].filter((s) => s.items.length > 0);
  }

  /** Topbar user card — name + initials from auth profile. */
  get topbarUser(): { name: string; role?: string; initials: string; photo?: string | null } | undefined {
    const p = this.auth.profile;
    if (!p) return undefined;
    return {
      name: p.name,
      role: p.manager_role?.name,
      initials: this.initials(p.name),
      photo: p.avatar_url ?? null,
    };
  }

  private initials(name: string): string {
    return name
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }

  logout(): void {
    localStorage.removeItem('dreamcabs_token');
    localStorage.removeItem('dreamcabs_api_base');
    this.auth.clear();
    this.router.navigateByUrl('/signin');
  }

  goProfile(): void {
    this.router.navigateByUrl('/profile');
  }

  goLiveOperations(): void {
    this.router.navigateByUrl('/maps');
  }

  goNotifications(): void {
    this.router.navigateByUrl('/notifications');
  }

  openMobileNav(): void {
    this.shell?.openMobile();
  }

  get isAuthorized(): boolean {
    return !!localStorage.getItem('dreamcabs_token');
  }

  get isSigninRoute(): boolean {
    return this.router.url.startsWith('/signin');
  }

  get showLiveOperations(): boolean {
    return this.auth.hasPermission('live_operations');
  }

  get isFullScreenRoute(): boolean {
    return this.router.url.startsWith('/maps');
  }

  get showShell(): boolean {
    return this.isAuthorized && !this.isSigninRoute && !this.isFullScreenRoute;
  }

  get scopedCityName(): string | null {
    const p = this.auth.profile;
    if (!p || p.is_super_admin) return null;
    return p.manager_city_name;
  }
}
