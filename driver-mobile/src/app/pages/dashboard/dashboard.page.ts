import { DriverMapCamera, DRIVER_MAP_STYLE, fitDriverMap } from '../../core/driver-map';
import { HomeSessionService } from '../../core/home-session.service';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { DocumentRequirement, DocumentRequirementsModalComponent } from '../../shared/document-requirements-modal.component';
import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ModalController } from '@ionic/angular';
import { firstValueFrom, interval, Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { DriverServiceAccess } from '../../core/driver-service-access';
import { AuthService, AuthUser } from '../../core/auth.service';
import { LocationConsentService } from '../../core/location-consent.service';
import { DriverPresenceService, PresenceFix } from '../../core/driver-presence.service';
import { GeolocationService } from '../../core/geolocation.service';
import { MapsLoaderService } from '../../core/maps-loader.service';
import { PushService } from '../../core/push.service';
import { RealtimeService } from '../../core/realtime.service';
import { ApprovedDriverGuard } from '../../core/approved-driver.guard';
import { ModeSelectModalComponent, DriverMode } from '../../shared/mode-select-modal/mode-select-modal.component';
import { SubscriptionPromptModalComponent } from '../../shared/subscription-prompt-modal/subscription-prompt-modal.component';
import {
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
  buildPassengerMarkerElement,
  buildStopMarkerElement,
} from '../../core/car-marker.helper';

import { environment } from '../../../environments/environment';

declare const google: any;


/** Operator-configured subscription prompt (Operator Settings → Subscription). */
interface SubscriptionPrompt {
  enabled: boolean;
  title: string | null;
  desc: string | null;
  button1: string | null;
  button2: string | null;
}

/** Per-(city, vehicle type) wallet warning config served on /drivers/me. */
interface CityVehicleTypeConfig {
  show_low_wallet_alert: boolean;
}

export interface AppBanner {
  id: number;
  title: string;
  image_url: string;
  url_link: string | null;
  target_app: 'customer' | 'driver' | 'both';
  position: 'full_screen' | 'half';
  is_active: boolean;
}

interface FixedRouteOption {
  id: number;
  name: string;
  origin_name: string;
  dest_name: string;
  scope: string;
  stops?: Array<{ id: number; seq: number; name: string }>;
}

interface FixedVehicleSummary {
  id: number;
  status: string;
  route_id?: number;
  route_name?: string;
  origin_name?: string;
  dest_name?: string;
}

interface FixedStop {
  id: number;
  seq: number;
  name: string;
  lat: number | null;
  lng: number | null;
  is_active?: boolean;
  is_temporarily_unavailable?: boolean;
}

interface FixedPassenger {
  id: number;
  customer_name?: string;
  seats?: number;
  status?: string;
  board_stop_id?: number;
  drop_stop_id?: number;
  board?: string;
  board_lat?: number | null;
  board_lng?: number | null;
  drop?: string;
  drop_lat?: number | null;
  drop_lng?: number | null;
  customer_lat?: number | null;
  customer_lng?: number | null;
  customer_avatar_url?: string | null;
}

interface FixedManifestResponse {
  departure: any;
  stops?: FixedStop[];
  passengers?: FixedPassenger[];
  city_settings?: any;
}

/**
 * Driver Dashboard — full-map home
 * --------------------------------
 * The bottom tab bar is gone; this screen is now the app's home. It is an
 * edge-to-edge Google Map that:
 *   - shows the device's current location with a live "driver puck" marker,
 *   - tracks the driver walking/driving in real time (continuous watchPosition),
 *   - hosts a floating top bar (menu + status), a recenter FAB, a Go Online /
 *     Go Offline bottom sheet, and a slide-in navigation drawer that replaces
 *     every destination the old tab bar used to reach.
 *
 * GPS ownership rule (so we never run two watchers at once):
 *   - OFFLINE  → this page owns a "visual" watch purely to move the marker.
 *   - ONLINE   → DriverPresenceService owns the watch (it also streams to the
 *                dispatcher); its onLocated() feeds the same marker.
 */
@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
  standalone: false,
})
export class DashboardPage implements AfterViewInit, OnDestroy {
  @ViewChild('mapDiv', { static: false }) mapDiv!: ElementRef<HTMLDivElement>;

  loading = false;
  toggling = false;
  isGoingOnline = false;
  isGoingOffline = false;
  error: string | null = null;
  driver: Record<string, unknown> | null = null;
  homeEarnings: number | null = null;
  earningsCurrency = 'INR';
  earningsLoading = false;
  earningsUnavailable = false;
  homeDate = new Date();
  homeWalletBalance: number | null = null;

  /**
   * The driver's (city, vehicle type) wallet-gate config from /drivers/me.
   * Null when the server doesn't send one — treated as "no gate".
   */
  cityVehicleTypeConfig: CityVehicleTypeConfig | null = null;
  /** Current wallet balance, used by the go-online gate (₹). */
  walletBalance = 0;
  /** Minimum wallet balance limit from operator settings (0 = unlimited). */
  minWalletLimit = 0;

  /**
   * Full-screen cold-start skeleton — covers the whole dashboard (map + top
   * bar + sheet) until BOTH the driver profile and the map are ready, then it
   * fades out to reveal the live screen.
   */
  homeLoading = true;
  serviceAccess: DriverServiceAccess | null = null;
  serviceAccessFailed = false;
  private serviceAccessRequest?: Subscription;
  private homeLoadStart = Date.now();
  private profileReady = false;
  private mapReady = false;

  /** Left navigation drawer (replaces the removed bottom tab bar). */
  /** Recenter FAB busy spinner while we fetch a one-shot fix. */
  locating = false;
  /** True once we've plotted at least one real GPS fix. */
  hasFix = false;
  /** Keep the camera glued to the driver until they pan the map themselves. */
  private followMe = true;

  /** "Online for" session timer shown in the online sheet. */
  onlineElapsed = '00:00';
  private onlineSince: number | null = null;
  private onlineTimer: ReturnType<typeof setInterval> | null = null;
  driveMode: 'private' | 'fixed' | 'shuttle' | null = null;
  driveScope: 'local' | 'outstation' | 'both' | null = null;
  routePickerOpen = false;
  routePickerRoutes: FixedRouteOption[] = [];
  openingRouteId: number | null = null;
  routePickerError: string | null = null;
  activeFixedVehicle: FixedVehicleSummary | null = null;
  activeDepartureManifest: any | null = null;
  fixedStops: FixedStop[] = [];
  fixedPassengers: FixedPassenger[] = [];

  get activeFixedVehicleOpen(): boolean {
    return !!this.activeFixedVehicle && !['COMPLETED', 'CANCELLED'].includes(this.activeFixedVehicle.status);
  }

  // ── App Banners ─────────────────────────────────────────────────────────
  fullScreenBanner: AppBanner | null = null;
  halfBanner: AppBanner | null = null;
  isFullScreenDismissed = false;
  isHalfBannerCollapsed = false;
  private bannerRealtimeUnsub: (() => void) | null = null;
  private bannerPollSub?: Subscription;

  private gpsCamera = new DriverMapCamera();
  private map: any | null = null;
  private selfMarker: any | null = null;
  private accuracyCircle: any | null = null;
  private markerHeading: HTMLElement | null = null;
  private visualWatchId: string | null = null;
  private lastPos: { lat: number; lng: number } | null = null;
  private fixedRouteLine: any = null;
  private fixedStopMarkers: any[] = [];
  private fixedPassengerMarkers: any[] = [];
  private fixedManifestPoll?: Subscription;
  /** Live "your verification changed" listener (admin approval/rejection). */
  private driverVerifyUnsub: (() => void) | null = null;
  // Default map centre (Mumbai) until we have a real fix.
  private readonly defaultCentre = { lat: 19.0760, lng: 72.8777 };

  constructor(
    private locationConsent: LocationConsentService,
    private api: ApiService,
    public auth: AuthService,
    private presence: DriverPresenceService,
    private mapsLoader: MapsLoaderService,
    private geo: GeolocationService,
    private router: Router,
    private alertCtrl: AlertController,
    private push: PushService,
    private modalCtrl: ModalController,
    private realtime: RealtimeService,
    private homeSession: HomeSessionService,
  ) {
    this.homeLoading = !this.homeSession.locationLoaderShown;
    this.homeSession.locationLoaderShown = true;
    this.presence.onError((err) => {
      this.error = err.message;
    });
    this.presence.onLocated((fix: PresenceFix) => {
      // Every GPS fix from the online presence watcher lands here — drive the
      // same marker so the driver sees themselves move in real time.
      this.applyFix(fix.lat, fix.lng, fix.accuracy, fix.bearing);
    });

    // Safety: never trap the driver behind the skeleton if the map or profile
    // is slow/unavailable (e.g. a pending location-permission prompt).
    setTimeout(() => this.finishHomeLoading(), 6000);
  }

  private documentRequirements: DocumentRequirement[] = [];
  private documentPromptSignature = '';
  private documentPromptBusy = false;
  private dashboardActive = false;
  private lastDocumentCheck = 0;
  private documentCheckBusy = false;
  private greetingInProgress = true;

  private applyDocumentRequirements(requirements: DocumentRequirement[]): void {
    this.documentRequirements = requirements.filter(doc => doc.status !== 'approved');
    if (!this.documentRequirements.length) this.documentPromptSignature = '';
    else void this.showDocumentRequirements();
  }

  private async showDocumentRequirements(force = false): Promise<void> {
    const signature = JSON.stringify(this.documentRequirements);
    if (!this.dashboardActive || this.greetingInProgress || this.documentPromptBusy || (!force && signature === this.documentPromptSignature)) return;
    this.documentPromptBusy = true;
    try {
      if (await this.modalCtrl.getTop()) return;
      this.documentPromptSignature = signature;
      const modal = await this.modalCtrl.create({
        component: DocumentRequirementsModalComponent,
        componentProps: { requirements: this.documentRequirements },
        cssClass: 'document-requirements-modal',
        breakpoints: [0, 1],
        initialBreakpoint: 1,
        handle: false,
      });
      await modal.present();
      const { data } = await modal.onDidDismiss();
      if (data?.upload) await this.router.navigate(['/profile'], { queryParams: { tab: 'documents' } });
    } finally { this.documentPromptBusy = false; }
  }

  private checkDocumentRequirements(): void {
    if (this.documentCheckBusy) return;
    this.documentCheckBusy = true;
    this.lastDocumentCheck = Date.now();
    this.api.get<{ document_requirements?: DocumentRequirement[] }>('/drivers/me').subscribe({
      next: res => { if (this.dashboardActive) this.applyDocumentRequirements(res.document_requirements ?? []); },
      error: () => { this.documentCheckBusy = false; },
      complete: () => { this.documentCheckBusy = false; },
    });
  }

  private syncTimer: ReturnType<typeof setInterval> | null = null;

  ionViewWillEnter(): void {
    this.homeDate = new Date();
    this.dashboardActive = true;
    this.greetingInProgress = true;
    this.hasInitialOverviewFramed = false;
    this.refresh();
    this.loadServiceAccess();
    void this.loadActiveFixedVehicleState();
    this.startSyncTimer();
    this.setupBannerSubscription();
    this.loadBanners();
  }

  loadServiceAccess(): void {
    this.serviceAccessRequest?.unsubscribe();
    this.serviceAccessFailed = false;
    this.serviceAccessRequest = this.api.get<DriverServiceAccess>('/drivers/me/service-access').subscribe({
      next: access => { this.serviceAccess = access; },
      error: () => { this.serviceAccess = null; this.serviceAccessFailed = true; },
    });
  }

  // ── App Banners handlers ────────────────────────────────────────────────
  get showFullScreenBanner(): boolean {
    return !this.greetingInProgress && !!this.fullScreenBanner && !this.isFullScreenDismissed;
  }

  get showHalfBanner(): boolean {
    return !this.greetingInProgress && !!this.halfBanner && !this.isHalfBannerCollapsed &&
      (!this.fullScreenBanner || this.isFullScreenDismissed);
  }

  setupBannerSubscription(): void {
    if (!this.bannerRealtimeUnsub) {
      this.bannerRealtimeUnsub = this.realtime.subscribeAppBanners((payload) => {
        if (payload.target_app === 'both' || payload.target_app === 'driver') {
          this.loadBanners(true);
        }
      });
    }

    this.bannerPollSub ??= interval(20000).subscribe(() => {
      this.loadBanners(false);
    });
  }

  loadBanners(isLiveEvent = false): void {
    this.api.get<{ data: AppBanner[] }>('/app-banners?app=driver').subscribe({
      next: (res) => {
        const banners = res?.data ?? [];
        const newFullScreen = banners.find((b) => b.position === 'full_screen') || null;
        const newHalf = banners.find((b) => b.position === 'half') || null;

        // Recreated pages restore the driver's choice for this exact offer.
        this.isFullScreenDismissed = !!newFullScreen && this.homeSession.dismissedOffers.has(this.offerKey(newFullScreen));
        this.isHalfBannerCollapsed = !!newHalf && this.homeSession.dismissedOffers.has(this.offerKey(newHalf));
        this.fullScreenBanner = newFullScreen;
        this.halfBanner = newHalf;
      },
      error: () => {},
    });
  }

  private offerKey(banner: AppBanner): string {
    return JSON.stringify([banner.position, banner.id, banner.title, banner.image_url, banner.url_link]);
  }

  private rememberOffer(banner: AppBanner | null, dismissed: boolean): void {
    if (!banner) return;
    const key = this.offerKey(banner);
    if (dismissed) this.homeSession.dismissedOffers.add(key);
    else this.homeSession.dismissedOffers.delete(key);
  }

  dismissFullScreenBanner(): void {
    this.rememberOffer(this.fullScreenBanner, true);
    this.isFullScreenDismissed = true;
  }

  collapseHalfBanner(): void {
    this.rememberOffer(this.halfBanner, true);
    this.isHalfBannerCollapsed = true;
  }

  expandHalfBanner(): void {
    this.rememberOffer(this.halfBanner, false);
    this.isHalfBannerCollapsed = false;
  }

  get showOfferPill(): boolean {
    if (this.greetingInProgress) return false;
    if (this.fullScreenBanner && !this.isFullScreenDismissed) return false;
    if (this.halfBanner && !this.isHalfBannerCollapsed) return false;
    return (
      (!!this.fullScreenBanner && this.isFullScreenDismissed) ||
      (!!this.halfBanner && this.isHalfBannerCollapsed)
    );
  }

  reopenOfferBanner(): void {
    if (this.fullScreenBanner && this.isFullScreenDismissed) {
      this.rememberOffer(this.fullScreenBanner, false);
      this.isFullScreenDismissed = false;
    } else if (this.halfBanner && this.isHalfBannerCollapsed) {
      this.rememberOffer(this.halfBanner, false);
      this.isHalfBannerCollapsed = false;
    } else {
      this.rememberOffer(this.fullScreenBanner, false);
      this.isFullScreenDismissed = false;
      this.rememberOffer(this.halfBanner, false);
      this.isHalfBannerCollapsed = false;
    }
  }

  resolveBannerImageUrl(url: string | null | undefined): string {
    const value = url?.trim();
    if (!value) return '';
    const apiBase = environment.apiUrl.replace(/\/api\/?$/i, '').replace(/\/$/, '');

    try {
      const apiOrigin = new URL(apiBase);
      const imageUrl = new URL(value, `${apiBase}/`);
      if (!['http:', 'https:'].includes(imageUrl.protocol)) return '';

      if (['localhost', '127.0.0.1', '[::1]'].includes(imageUrl.hostname)) {
        return `${apiBase}${imageUrl.pathname}${imageUrl.search}${imageUrl.hash}`;
      }

      // Older servers can return HTTP links for uploads on our HTTPS API host.
      if (apiOrigin.protocol === 'https:' && imageUrl.protocol === 'http:'
        && imageUrl.host === apiOrigin.host) {
        imageUrl.protocol = 'https:';
      }
      return imageUrl.href;
    } catch {
      return '';
    }
  }

  async onBannerClick(banner: AppBanner | null): Promise<void> {
    if (!banner?.url_link) return;
    const url = banner.url_link;
    const alert = await this.alertCtrl.create({
      header: 'Visit Link?',
      message: `Do you want to visit this link?\n\n${url}`,
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
        },
        {
          text: 'Visit Link',
          handler: () => {
            window.open(url, '_blank') || (window.location.href = url);
          },
        },
      ],
    });
    await alert.present();
  }

  private startSyncTimer(): void {
    this.stopSyncTimer();
    this.syncTimer = setInterval(() => {
      this.refreshWalletBalance();
      if (Date.now() - this.lastDocumentCheck > 30000) this.checkDocumentRequirements();
      if (this.documentRequirements.length) void this.showDocumentRequirements();
    }, 4000);
  }

  private stopSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  ionViewDidEnter(): void {
    void this.refreshLocationQuietly();
    // App-open greeting: the AI mode chooser (Voice / Self), then — if the
    // operator enabled it — the subscription nudge.
    void this.greetOnAppOpen();
    if (this.map) {
      google.maps.event.trigger(this.map, 'resize');
      if (this.activeFixedVehicleOpen) {
        this.renderFixedRouteOnDashboard();
      }
    }
  }

  /**
   * Runs the app-open prompts in order: the mode chooser first, then the
   * subscription nudge. The two are independent (each has its own guard) so the
   * subscription prompt still shows even when the mode chooser was already shown
   * this session.
   */
  private async greetOnAppOpen(): Promise<void> {
    try {
      await this.maybeShowModePrompt();
      await this.maybeShowSubscriptionPrompt();
    } finally {
      this.greetingInProgress = false;
      if (this.documentRequirements.length) void this.showDocumentRequirements();
    }
  }

  /**
   * Greet the driver on app open with the mode chooser — "Continue with Voice"
   * (the AI voice assistant) or "Continue as Self" (manual). Shown once per app
   * session; the picked mode is remembered so the AI feature can wire in later.
   */
  private async maybeShowModePrompt(): Promise<void> {
    try {
      if (sessionStorage.getItem('dc_mode_prompt_shown') === '1') return;
    } catch { /* sessionStorage unavailable — fall through */ }
    // Mark shown up-front so a slow render can't double-present the greeting.
    try { sessionStorage.setItem('dc_mode_prompt_shown', '1'); } catch { /* ignore */ }

    const modal = await this.modalCtrl.create({
      component: ModeSelectModalComponent,
      cssClass: 'mode-select-modal',
      componentProps: { current: this.readDriverMode() },
    });
    await modal.present();
    const { data } = await modal.onDidDismiss<{ mode?: DriverMode }>();
    if (data?.mode) {
      try { localStorage.setItem('dc_driver_mode', data.mode); } catch { /* ignore */ }
    }
  }

  /**
   * Operator-controlled subscription nudge, shown on app open right after the
   * mode chooser. Off (Operator Settings → Subscription) or already-subscribed
   * = nothing shows. The buttons (admin-labelled) open the Subscriptions screen
   * so the driver can pick a plan.
   */
  /** Shown at most once per app launch (resets on a cold start). */
  private static subPromptShown = false;
  /** Synchronous guard against a concurrent double-fire of the prompt. */
  private subPromptBusy = false;

  private async maybeShowSubscriptionPrompt(): Promise<void> {
    if (DashboardPage.subPromptShown || this.subPromptBusy) return;
    this.subPromptBusy = true;
    try {
      const cfg = await firstValueFrom(
        this.api.get<SubscriptionPrompt>('/operator/subscription-popup'),
      ).catch(() => null);
      if (!cfg?.enabled) return;

      // Don't nag drivers who already hold a plan.
      const sub = await firstValueFrom(
        this.api.get<{ subscription: unknown | null }>('/drivers/me/subscription'),
      ).catch(() => null);
      if (sub?.subscription) return;

      // Mark shown only once we've passed the gates, so a disabled/subscribed
      // state doesn't permanently suppress it for this launch.
      DashboardPage.subPromptShown = true;

      // Full-page modal that mirrors the Subscriptions screen (hero + plan
      // cards); the operator's title/description drive the headline.
      const modal = await this.modalCtrl.create({
        component: SubscriptionPromptModalComponent,
        componentProps: { title: cfg.title, desc: cfg.desc },
      });
      await modal.present();
      await modal.onDidDismiss();
    } catch {
      /* best-effort prompt — never block the dashboard */
    } finally {
      this.subPromptBusy = false;
    }
  }

  /** The driver's last-picked mode, if any (used to highlight it on reopen). */
  private readDriverMode(): DriverMode | null {
    try {
      const m = localStorage.getItem('dc_driver_mode');
      return m === 'voice' || m === 'self' ? m : null;
    } catch {
      return null;
    }
  }

  async ngAfterViewInit(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      this.resumeListener = CapacitorApp.addListener('appStateChange', state => {
        if (state.isActive && this.dashboardActive) void this.refreshLocationQuietly();
      });
    }
    this.subscribeVerificationUpdates();
    try {
      if (this.mapDiv?.nativeElement) {
        await this.mapsLoader.ensureLoaded();
        this.initMap();
      }
      await this.refreshLocationQuietly();
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      // Home no longer displays a map; location tracking still resolves normally.
      this.mapReady = true;
      this.maybeFinishHome();
    }
  }

  ionViewWillLeave(): void {
    this.dashboardActive = false;
    this.stopSyncTimer();
    this.stopFixedManifestPolling();
    // Drop the visual-only watch when navigating away. If the driver is online,
    // DriverPresenceService keeps its own watch alive so dispatch still sees us.
    void this.stopVisualWatch();
  }

  ngOnDestroy(): void {
    this.serviceAccessRequest?.unsubscribe();
    void this.resumeListener?.then(handle => handle.remove());
    this.stopSyncTimer();
    this.stopFixedManifestPolling();
    this.clearFixedMapObjects();
    void this.stopVisualWatch();
    this.stopOnlineTimer();
    this.driverVerifyUnsub?.();
    this.driverVerifyUnsub = null;
    this.bannerRealtimeUnsub?.();
    this.bannerRealtimeUnsub = null;
    this.bannerPollSub?.unsubscribe();
    this.bannerPollSub = undefined;
  }

  /**
   * Live-update the moment the operator approves (or rejects) this driver, so the
   * "under review" banner clears and Go Online appears with no manual refresh.
   * The backend broadcasts DriverVerificationUpdated on the driver's private
   * channel; we just re-pull /drivers/me when it fires.
   */
  private subscribeVerificationUpdates(): void {
    if (this.driverVerifyUnsub) return;
    const uid = this.auth.getUser()?.id;
    if (!uid) return;
    this.driverVerifyUnsub = this.realtime.subscribeDriverVerification(uid, () => {
      this.refresh();
    });
  }

  // ---------------------------------------------------------------- display --

  get user(): AuthUser | null {
    return this.auth.getUser();
  }
  get firstName(): string {
    const n = this.user?.name?.trim() || 'Driver';
    return n.split(/\s+/)[0];
  }
  get homeGreeting(): string {
    const hour = this.homeDate.getHours();
    return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  }
  get operatingCityLabel(): string {
    const cities = this.driver?.['cities'];
    if (Array.isArray(cities)) {
      const names = cities.map(city => typeof city?.name === 'string' ? city.name : '').filter(Boolean);
      if (names.length) return names.join(' / ');
    }
    return typeof this.driver?.['city_name'] === 'string' ? this.driver['city_name'] : '';
  }
  get homeNotice(): { title: string; text: string; icon: string; path?: string; action?: string } {
    if (!this.isApproved) return { title: 'Account under review', text: 'Check your application before starting your next shift.', icon: 'time-outline', path: '/driver-pending-review', action: 'View application' };
    if (this.isWalletBelowLimit) return { title: 'Your wallet needs attention', text: `Add ₹${this.walletShortfall} to reach the minimum balance for going online.`, icon: 'wallet-outline', path: '/tabs/wallet', action: 'View wallet' };
    if (this.documentRequirements.length) return { title: 'Documents need attention', text: 'Review the documents requested for your driver account.', icon: 'document-text-outline', path: '/profile?tab=documents', action: 'Review documents' };
    return { title: this.isOnline ? 'Ready for your next ride' : 'Before you go online', text: 'Keep your phone charged and your vehicle ready for the next ride.', icon: 'shield-checkmark-outline' };
  }
  get avatarUrl(): string | null {
    return this.auth.resolveAvatarUrl(this.user);
  }
  get vehicleRegistration(): string {
    return String(this.driver?.['vehicle_reg_no'] || '');
  }
  get homeVehicleIdentity(): string {
    const driver = this.driver as any;
    const name = driver?.city_vehicle_type?.display_name || driver?.vehicle_type_ref?.name || driver?.vehicle_type || '';
    return [this.vehicleRegistration, name].filter(Boolean).join(' · ');
  }
  get registeredServiceMode(): string {
    return String(this.driver?.['service_mode'] || this.driveMode || '');
  }
  get registeredServiceLabel(): string {
    if (!this.registeredServiceMode) return '';
    return `${this.scopeLabel(String(this.driver?.['service_scope'] || this.driveScope || ''))} · ${this.serviceLabel(this.registeredServiceMode)}`;
  }

  private refreshHomeEarnings(): void {
    if (this.earningsLoading) return;
    this.earningsLoading = true;
    this.earningsUnavailable = false;
    this.api.get<{ ride_earnings?: number; currency?: string }>('/drivers/me/earnings?period=week').subscribe({
      next: res => {
        const amount = res.ride_earnings;
        this.homeEarnings = typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
        this.earningsCurrency = res.currency || 'INR';
        this.earningsUnavailable = this.homeEarnings === null;
        this.earningsLoading = false;
      },
      error: () => {
        this.homeEarnings = null;
        this.earningsUnavailable = true;
        this.earningsLoading = false;
      },
    });
  }
  readonly defaultAvatar = 'assets/default-avatar.svg';
  /** Swap a broken/unreachable avatar for the bundled default image. */
  onAvatarError(ev: Event): void {
    const img = ev.target as HTMLImageElement | null;
    if (img && img.src.indexOf('default-avatar') === -1) {
      img.src = this.defaultAvatar;
    }
  }
  get isApproved(): boolean {
    return this.driver?.['approval_status'] === 'approved';
  }
  get isOnline(): boolean {
    return !!this.driver?.['is_online'] || this.activeFixedVehicleOpen;
  }

  /** True if a minimum wallet limit is configured and the driver's balance is below that floor. */
  get isWalletBelowLimit(): boolean {
    return this.minWalletLimit !== 0 && this.walletBalance < this.minWalletLimit;
  }

  /** Amount needed to recharge to reach or exceed minimum wallet limit. */
  get walletShortfall(): number {
    if (!this.isWalletBelowLimit) return 0;
    return Math.max(0, Math.ceil(this.minWalletLimit - this.walletBalance));
  }

  /**
   * A driver may go ONLINE once documents are approved AND their wallet balance
   * is above the configured minimum limit.
   */
  get canGoOnline(): boolean {
    return this.isApproved && !this.isWalletBelowLimit;
  }

  // ------------------------------------------------------------------ drawer --

  navTo(path: string): void {
    this.router.navigateByUrl(path);
  }


  serviceLabel(mode: 'private' | 'fixed' | 'shuttle' | string | null | undefined = this.driveMode): string {
    if (mode === 'fixed') return 'Fixed vehicle';
    if (mode === 'shuttle') return 'Shuttle rides';
    if (mode === 'private') return 'Private rides';
    return 'Service';
  }

  scopeLabel(scope: 'local' | 'outstation' | 'both' | string | null | undefined = this.driveScope): string {
    if (scope === 'both') return 'Local & Outstation';
    return scope === 'outstation' ? 'Outstation' : 'Local';
  }

  activeServiceLabel(): string {
    return `${this.scopeLabel()} - ${this.serviceLabel().replace(' rides', '').replace(' vehicle', '')}`;
  }

  chooseFixedRouteForBoarding(): void {
    this.router.navigateByUrl('/tabs/fixed');
  }

  closeRoutePicker(): void {
    if (this.openingRouteId !== null) return;
    this.routePickerOpen = false;
    this.routePickerError = null;
  }

  async openFixedRouteForBoarding(route: FixedRouteOption): Promise<void> {
    if (this.openingRouteId !== null || this.toggling) return;
    this.openingRouteId = route.id;
    this.toggling = true;
    this.error = null;
    this.routePickerError = null;

    try {
      const created = await firstValueFrom(this.api.post<{ departure?: FixedVehicleSummary; vehicle?: FixedVehicleSummary }>('/fixed/driver/vehicles', { route_id: route.id }));
      this.activeFixedVehicle = created?.departure || created?.vehicle || { id: 0, status: 'FORMING' };
      this.routePickerOpen = false;
      setTimeout(() => this.router.navigateByUrl('/tabs/fixed'), 120);
    } catch (e) {
      const body = (e as { error?: Record<string, unknown> })?.error;
      this.routePickerError = (body?.['message'] as string) || (e as Error)?.message || 'Could not open fixed vehicle.';
      this.error = this.routePickerError;
    } finally {
      this.openingRouteId = null;
      this.toggling = false;
    }
  }

  routeTitle(route: FixedRouteOption): string {
    return route.name || ((route.origin_name && route.dest_name) ? route.origin_name + ' to ' + route.dest_name : 'Fixed route #' + route.id);
  }

  get fixedRouteLineTitle(): string {
    const dep = this.activeDepartureManifest || this.activeFixedVehicle;
    if (!dep) return 'Fixed Route Ride';
    if (dep.origin_name && dep.dest_name && dep.origin_name !== 'Origin' && dep.dest_name !== 'Destination') {
      return `${dep.origin_name} to ${dep.dest_name}`;
    }
    if (this.fixedStops.length > 1) {
      return `${this.fixedStops[0]?.name || 'Origin'} to ${this.fixedStops[this.fixedStops.length - 1]?.name || 'Destination'}`;
    }
    return dep.route_name || 'Fixed Route Ride';
  }

  get fixedRideStatusLabel(): string {
    const status = this.activeDepartureManifest?.status || this.activeFixedVehicle?.status || '';
    switch (status.toUpperCase()) {
      case 'FORMING': return 'Boarding Active';
      case 'DISPATCHED': return 'Assigned';
      case 'DEPARTED': return 'Ride In Progress';
      default: return 'Active Ride';
    }
  }

  get fixedPassengerCountSummary(): string {
    if (!this.fixedPassengers.length) return '';
    const waiting = this.fixedPassengers.filter((p) => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase())).length;
    const boarded = this.fixedPassengers.filter((p) => (p.status || '').toUpperCase() === 'BOARDED').length;
    return `${waiting} waiting · ${boarded} on-board`;
  }

  get fixedNextStopName(): string | null {
    if (!this.fixedStops.length) return null;
    const reachedSeq = Number(this.activeDepartureManifest?.fixed_last_reached_stop_seq || 0);
    const nextStop = this.fixedStops.find((s) => Number(s.seq) > reachedSeq);
    return nextStop?.name || null;
  }

  private async loadActiveFixedVehicleState(): Promise<boolean> {
    try {
      const existing = await firstValueFrom(this.api.get<{ data: FixedVehicleSummary[] }>('/fixed/driver/vehicles'));
      const active = (existing.data || []).find((vehicle) => !['COMPLETED', 'CANCELLED'].includes(vehicle.status));
      if (active) {
        this.activeFixedVehicle = active;
        this.driveMode = 'fixed';
        try { localStorage.setItem('dc_driver_intended_online', '1'); } catch { /* ignore */ }
        this.startFixedManifestPolling(active.id);
        return true;
      } else {
        this.clearActiveFixedRide();
        return false;
      }
    } catch {
      return false;
    }
  }

  private startFixedManifestPolling(vehicleId: number): void {
    this.stopFixedManifestPolling();
    this.loadFixedManifest(vehicleId, true);
    this.fixedManifestPoll = interval(4000).subscribe(() => {
      this.loadFixedManifest(vehicleId, false);
    });
  }

  private stopFixedManifestPolling(): void {
    this.fixedManifestPoll?.unsubscribe();
    this.fixedManifestPoll = undefined;
  }

  private loadFixedManifest(vehicleId: number, forceRedraw = false): void {
    const oldStopsJson = JSON.stringify(this.fixedStops.map((s) => ({ id: s.id, seq: s.seq })));
    const oldPassengersJson = JSON.stringify(this.fixedPassengers.map((p) => ({
      id: p.id,
      status: p.status,
      lat: p.customer_lat,
      lng: p.customer_lng,
    })));

    this.api.get<FixedManifestResponse>(`/fixed/departures/${vehicleId}/manifest`).subscribe({
      next: (res) => {
        if (!res?.departure || ['COMPLETED', 'CANCELLED'].includes(res.departure.status)) {
          this.clearActiveFixedRide();
          return;
        }
        this.activeDepartureManifest = res.departure;
        this.fixedPassengers = res.passengers || [];
        this.fixedStops = (res.stops || []).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));

        const newStopsJson = JSON.stringify(this.fixedStops.map((s) => ({ id: s.id, seq: s.seq })));
        const newPassengersJson = JSON.stringify(this.fixedPassengers.map((p) => ({
          id: p.id,
          status: p.status,
          lat: p.customer_lat,
          lng: p.customer_lng,
        })));

        if (forceRedraw || !this.fixedRouteLine || oldStopsJson !== newStopsJson || oldPassengersJson !== newPassengersJson) {
          this.renderFixedRouteOnDashboard();
        }
      },
      error: () => {
        // Keep current state on transient failure
      },
    });
  }

  private clearActiveFixedRide(): void {
    this.stopFixedManifestPolling();
    this.hasInitialOverviewFramed = false;
    this.activeFixedVehicle = null;
    this.activeDepartureManifest = null;
    this.fixedStops = [];
    this.fixedPassengers = [];
    this.clearFixedMapObjects();

    if (this.lastPos) {
      this.applyFix(this.lastPos.lat, this.lastPos.lng, null, null, false);
    }
  }

  private clearFixedMapObjects(): void {
    if (this.fixedRouteLine) {
      this.fixedRouteLine.setMap(null);
      this.fixedRouteLine = null;
    }
    for (const marker of this.fixedStopMarkers) marker.map = null;
    for (const marker of this.fixedPassengerMarkers) marker.map = null;
    this.fixedStopMarkers = [];
    this.fixedPassengerMarkers = [];
  }

  private hasInitialOverviewFramed = false;

  private renderFixedRouteOnDashboard(): void {
    if (!this.map) return;
    this.clearFixedMapObjects();

    const routeStops = this.fixedStops.filter((stop) => {
      const lat = Number(stop.lat);
      const lng = Number(stop.lng);
      return !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0;
    });

    if (routeStops.length > 0) {
      // 1. Stop Markers (Route line eliminated as requested: driver sees stop points and passenger pins only)
      this.fixedStopMarkers = routeStops.map((stop) => {
        return new google.maps.marker.AdvancedMarkerElement({
          position: { lat: Number(stop.lat), lng: Number(stop.lng) },
          map: this.map,
          title: stop.name,
          content: this.buildFixedStopMarker(stop),
          zIndex: Number(stop.seq || 0) + 100,
        });
      });
    }

    // 3. Passenger Markers
    this.fixedPassengerMarkers = this.fixedPassengerPointGroups().map((point) => {
      return new google.maps.marker.AdvancedMarkerElement({
        position: point.position,
        map: this.map,
        title: point.title,
        content: this.buildFixedPassengerMarker(point.kind, point.count, point.name, point.isLive, point.avatarUrl),
        zIndex: point.kind === 'pickup' ? (point.isLive ? 960 : 920) : 850,
      });
    });

    // 4. Force driver car marker update
    if (this.lastPos) {
      this.applyFix(this.lastPos.lat, this.lastPos.lng, null, null, false);
    }

    // 5. Fit active corridor overview
    if (!this.hasInitialOverviewFramed) {
      this.fitFixedRideOverview();
      this.hasInitialOverviewFramed = true;
    }
  }

  private fitFixedRideOverview(): void {
    if (!this.map || typeof google === 'undefined' || !google.maps) return;
    const bounds = new google.maps.LatLngBounds();
    let count = 0;

    for (const stop of this.fixedStops) {
      const lat = Number(stop.lat);
      const lng = Number(stop.lng);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        bounds.extend({ lat, lng });
        count++;
      }
    }

    for (const marker of this.fixedPassengerMarkers) {
      if (marker?.position) {
        bounds.extend(marker.position as any);
        count++;
      }
    }

    if (this.lastPos) {
      bounds.extend(this.lastPos);
      count++;
    }

    if (count > 0) {
      fitDriverMap(this.map, bounds, { top: 90, right: 36, bottom: 250, left: 36 } as any);
    }
  }

  private buildFixedStopMarker(stop: FixedStop): HTMLElement {
    const reachedSeq = Number(this.activeDepartureManifest?.fixed_last_reached_stop_seq || 0);
    return buildStopMarkerElement({
      seq: stop.seq,
      isReached: Number(stop.seq || 0) <= reachedSeq,
    });
  }

  private fixedPassengerPointGroups(): Array<{
    kind: 'pickup' | 'drop';
    count: number;
    title: string;
    name: string;
    isLive: boolean;
    avatarUrl?: string | null;
    position: { lat: number; lng: number };
  }> {
    const points: Array<{
      kind: 'pickup' | 'drop';
      count: number;
      title: string;
      name: string;
      isLive: boolean;
      avatarUrl?: string | null;
      position: { lat: number; lng: number };
    }> = [];

    for (const passenger of this.fixedPassengers) {
      const status = (passenger.status || '').toUpperCase();
      if (['CANCELLED', 'NO_SHOW', 'DROPPED', 'COMPLETED'].includes(status)) continue;

      if (['BOOKED', 'CONFIRMED'].includes(status)) {
        const pickup = this.getFixedPassengerPosition(passenger, 'pickup');
        if (pickup) {
          const isLive = passenger.customer_lat != null && passenger.customer_lng != null &&
            Number.isFinite(Number(passenger.customer_lat)) && Number.isFinite(Number(passenger.customer_lng));
          const name = passenger.customer_name || 'Passenger';
          points.push({
            kind: 'pickup',
            count: passenger.seats || 1,
            name,
            isLive,
            avatarUrl: passenger.customer_avatar_url || null,
            title: `${name} (${passenger.seats || 1} seat${(passenger.seats || 1) > 1 ? 's' : ''}) - ${isLive ? 'Live Walking' : 'Pickup at ' + (passenger.board || 'stop')}`,
            position: pickup,
          });
        }
      } else if (status === 'BOARDED') {
        const drop = this.getFixedPassengerPosition(passenger, 'drop');
        if (drop) {
          const name = passenger.customer_name || 'Passenger';
          points.push({
            kind: 'drop',
            count: passenger.seats || 1,
            name,
            isLive: false,
            avatarUrl: passenger.customer_avatar_url || null,
            title: `${name} - Drop off at ${passenger.drop || 'destination'}`,
            position: drop,
          });
        }
      }
    }
    return points;
  }

  private getFixedPassengerPosition(passenger: FixedPassenger, kind: 'pickup' | 'drop'): { lat: number; lng: number } | null {
    if (kind === 'pickup') {
      if (passenger.customer_lat != null && passenger.customer_lng != null &&
          Number.isFinite(Number(passenger.customer_lat)) && Number.isFinite(Number(passenger.customer_lng))) {
        return { lat: Number(passenger.customer_lat), lng: Number(passenger.customer_lng) };
      }
      if (passenger.board_lat != null && passenger.board_lng != null &&
          Number.isFinite(Number(passenger.board_lat)) && Number.isFinite(Number(passenger.board_lng))) {
        return { lat: Number(passenger.board_lat), lng: Number(passenger.board_lng) };
      }
      const stop = this.fixedStops.find((s) => Number(s.id) === Number(passenger.board_stop_id));
      return (stop?.lat != null && stop?.lng != null) ? { lat: Number(stop.lat), lng: Number(stop.lng) } : null;
    }

    if (passenger.drop_lat != null && passenger.drop_lng != null &&
        Number.isFinite(Number(passenger.drop_lat)) && Number.isFinite(Number(passenger.drop_lng))) {
      return { lat: Number(passenger.drop_lat), lng: Number(passenger.drop_lng) };
    }
    const dropStop = this.fixedStops.find((s) => Number(s.id) === Number(passenger.drop_stop_id));
    return (dropStop?.lat != null && dropStop?.lng != null) ? { lat: Number(dropStop.lat), lng: Number(dropStop.lng) } : null;
  }

  private buildFixedPassengerMarker(kind: 'pickup' | 'drop', count: number, name = 'Passenger', isLive = false, avatarUrl?: string | null): HTMLElement {
    return buildPassengerMarkerElement({ kind, count, name, isLive, avatarUrl });
  }

  async choosePrivateRides(): Promise<void> {
    await this.setDriveMode('private');
  }

  async chooseFixedVehicle(): Promise<void> {
    const ok = await this.setDriveMode('fixed');
    if (ok) this.navTo('/tabs/fixed');
  }

  async chooseShuttleRides(): Promise<void> {
    await this.setDriveMode('shuttle');
  }

  async resetDriveMode(): Promise<void> {
    await this.setDriveMode(null);
  }

  private async setDriveMode(mode: 'private' | 'fixed' | 'shuttle' | null): Promise<boolean> {
    if (this.toggling) return false;
    this.toggling = true;
    this.error = null;

    try {
      const res = await firstValueFrom(
        this.api.post<{ driver: Record<string, unknown> }>('/drivers/service-mode', { mode })
      );
      this.driver = res.driver;
      this.driveMode = (res.driver?.['active_service_mode'] as 'private' | 'fixed' | 'shuttle' | null) ?? null;
      this.driveScope = (res.driver?.['active_service_scope'] as 'local' | 'outstation' | 'both' | null) ?? null;
      return true;
    } catch (e) {
      const body = (e as { error?: Record<string, unknown> })?.error;
      this.error = (body?.['message'] as string) || (e as Error)?.message || 'Could not change service mode';
      return false;
    } finally {
      this.toggling = false;
    }
  }

  async confirmGoOffline(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Go offline?',
      message: 'You will stop receiving new ride requests until you go back online.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Go offline', role: 'destructive', handler: () => { void this.goOffline(); } },
      ],
    });
    await alert.present();
  }

  async confirmDeleteAccount(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Delete account',
      message: 'You are about to delete your account. Some data will be lost forever.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', role: 'destructive', handler: () => this.router.navigateByUrl('/delete-account') },
      ],
    });
    await alert.present();
  }

  async confirmSignOut(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Sign out?',
      message: 'You will need to sign in again to go online and accept rides.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Sign out', role: 'destructive', handler: () => this.performSignOut() },
      ],
    });
    await alert.present();
  }

  private async performSignOut(): Promise<void> {
    try {
      await this.push.unregister();
    } catch {
      /* best-effort */
    }
    this.api.post('/me/logout', {}).subscribe({
      next: () => this.finishSignOut(),
      error: () => this.finishSignOut(),
    });
  }

  private async finishSignOut(): Promise<void> {
    await this.auth.logout();
    this.router.navigateByUrl('/auth/login', { replaceUrl: true });
  }

  // ----------------------------------------------------------------- profile --

  refresh(): void {
    this.loading = true;
    this.error = null;
    this.refreshHomeEarnings();
    this.api.get<{
      driver: Record<string, unknown> | null;
      user: { name?: string; roles?: string[]; avatar_path?: string | null; avatar_url?: string | null };
      city_vehicle_type_config?: CityVehicleTypeConfig | null;
      wallet_balance?: number | null;
      document_requirements?: DocumentRequirement[];
    }>('/drivers/me').subscribe({
      next: (res) => {
        this.driver = res.driver;
        const driverMarkerUrl = (res.driver as any)?.vehicle?.map_marker_url
          || (res.driver as any)?.map_marker_url
          || null;
        if (this.selfMarker && driverMarkerUrl) {
          updateCarMarkerImage(this.selfMarker, driverMarkerUrl);
        }
        this.lastDocumentCheck = Date.now();
        this.applyDocumentRequirements(res.document_requirements ?? []);
        // Keep the route guard's cached state in step with reality so navigation
        // (e.g. via "View application") never bounces on a stale "pending".
        if (this.driver?.['approval_status'] === 'approved') {
          ApprovedDriverGuard.setStateApproved();
        }
        // Wallet gate config for this driver's (city, vehicle type), null-safe.
        this.cityVehicleTypeConfig = res.city_vehicle_type_config ?? null;
        // Prefer a balance served alongside the profile; otherwise the wallet
        // service fetch below keeps walletBalance in sync.
        if (typeof res.wallet_balance === 'number') {
          this.walletBalance = res.wallet_balance;
          this.homeWalletBalance = res.wallet_balance;
        }
        this.refreshWalletBalance();
        if (res.user) {
          // Keep the locally-stored user in sync with the server — crucially the
          // avatar, so a photo uploaded anywhere (app or admin) shows up here,
          // in the drawer and on the profile screen.
          this.auth.updateUser({
            name: res.user.name,
            roles: res.user.roles,
            avatar_path: res.user.avatar_path,
            avatar_url: res.user.avatar_url,
          });
        }
        // App may have been reloaded while online — resume the presence stream
        // so dispatch keeps seeing us as Free, and hand GPS ownership to it.
        const wasIntendedOnline = localStorage.getItem('dc_driver_intended_online') === '1';
        const isServerOnline = !!this.driver?.['is_online'];

        if (isServerOnline || wasIntendedOnline || this.activeFixedVehicleOpen) {
          if (!isServerOnline && wasIntendedOnline && this.canGoOnline) {
            void this.goOnline(true);
          } else {
            try { localStorage.setItem('dc_driver_intended_online', '1'); } catch { /* ignore */ }
            if (!this.presence.isStreaming()) {
              void this.presence.start().then(() => this.stopVisualWatch());
            } else {
              void this.stopVisualWatch();
            }
            this.driveMode = (this.driver?.['active_service_mode'] as 'private' | 'fixed' | 'shuttle' | null) ?? (this.activeFixedVehicleOpen ? 'fixed' : null);
            this.driveScope = (this.driver?.['active_service_scope'] as 'local' | 'outstation' | 'both' | null) ?? null;
            void this.loadActiveFixedVehicleState();
            this.startOnlineTimer();
          }
        } else {
          void this.loadActiveFixedVehicleState();
          this.stopOnlineTimer();
        }
      },
      error: (err) => {
        if (err?.status === 401) {
          this.finishSignOut();
          return;
        }
        this.error = driverProfileErrorMessage(err);
        this.driver = null;
        this.profileReady = true;
        this.maybeFinishHome();
      },
      complete: () => {
        this.loading = false;
        this.profileReady = true;
        this.maybeFinishHome();
      },
    });
  }

  private previousWarningState: boolean | null = null;
  isTransitioningState = false;

  /**
   * Keep walletBalance and minWalletLimit current so the home screen
   * updates live the instant settings or balance change.
   */
  private refreshWalletBalance(): void {
    this.api.get<{ balance?: number; minimum_wallet_limit?: number }>('/drivers/me/wallet').subscribe({
      next: (res) => {
        const prevBelow = this.isWalletBelowLimit;
        if (typeof res?.balance === 'number') this.walletBalance = res.balance;
        this.homeWalletBalance = typeof res?.balance === 'number' && Number.isFinite(res.balance) ? res.balance : null;
        if (typeof res?.minimum_wallet_limit === 'number') this.minWalletLimit = res.minimum_wallet_limit;
        const nextBelow = this.isWalletBelowLimit;

        if (this.previousWarningState !== null && prevBelow !== nextBelow) {
          this.isTransitioningState = true;
          setTimeout(() => {
            this.isTransitioningState = false;
          }, 500);
        }
        this.previousWarningState = nextBelow;
      },
      error: () => { this.homeWalletBalance = null; },
    });
  }

  /**
   * The full-screen skeleton lifts only once BOTH the profile and the map are
   * ready, so the driver never sees a half-loaded dashboard.
   */
  private maybeFinishHome(): void {
    const timeElapsed = Date.now() - this.homeLoadStart > 5000;
    if (this.profileReady && this.mapReady && (this.hasFix || timeElapsed)) {
      this.finishHomeLoading();
    }
  }

  /**
   * Fade the skeleton out once everything's ready, keeping it up for a short
   * minimum so it never flashes on a fast load.
   */
  private finishHomeLoading(): void {
    if (!this.homeLoading) return;
    const elapsed = Date.now() - this.homeLoadStart;
    const minMs = 500;
    if (elapsed >= minMs) {
      this.homeLoading = false;
    } else {
      setTimeout(() => (this.homeLoading = false), minMs - elapsed);
    }
  }

  // -------------------------------------------------------------------- map ---

  private initMap(): void {
    if (!this.mapDiv?.nativeElement || this.map) return;
    this.map = new google.maps.Map(this.mapDiv.nativeElement, {
      ...DRIVER_MAP_STYLE,
      center: this.defaultCentre,
      // mapId is required for AdvancedMarkerElement. DEMO_MAP_ID is Google's
      // public test id; swap for a styled Cloud-console mapId in production.
      mapId: 'DEMO_MAP_ID',
      disableDefaultUI: true,
      gestureHandling: 'greedy',
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
    });

    // The moment the driver drags the map, stop auto-following so we don't yank
    // the camera back on the next GPS tick.
    this.map.addListener('dragstart', () => {
      this.followMe = false;
    });

    // Ionic view transitions can render the container 0×0 on the first tick;
    // nudge a resize once the page is laid out or tiles stay blank.
    setTimeout(() => {
      if (this.map) {
        google.maps.event.trigger(this.map, 'resize');
        this.map.setCenter(this.lastPos || this.defaultCentre);
        if (this.activeFixedVehicleOpen) {
          this.renderFixedRouteOnDashboard();
        }
      }
    }, 300);
  }

  private waitForMap(timeoutMs = 5000): Promise<boolean> {
    if (!this.mapDiv?.nativeElement) return Promise.resolve(false);
    return new Promise((resolve) => {
      if (this.map) return resolve(true);
      const start = Date.now();
      const tick = () => {
        if (this.map) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // -------------------------------------------------------- live tracking ---

  /**
   * Show the driver where they are the instant the map is ready, then keep the
   * marker moving as they do. Runs on every page entry; safe to call repeatedly.
   */
  private locationRefreshBusy = false;
  private resumeListener?: Promise<PluginListenerHandle>;

  @HostListener('document:visibilitychange')
  onAppVisibilityChange(): void {
    if (document.visibilityState === 'visible' && this.dashboardActive) {
      void this.refreshLocationQuietly();
    }
  }

  private async refreshLocationQuietly(): Promise<void> {
    if (this.locationRefreshBusy) return;
    this.locationRefreshBusy = true;
    try {
      await this.startLiveTracking();
    } finally {
      this.locationRefreshBusy = false;
    }
  }

  private async startLiveTracking(): Promise<void> {
    try {
      await this.geo.requestPermissions();
    } catch {
      /* web prompts lazily on first read */
    }

    // One immediate fix so the marker appears without waiting for a watch tick.
    try {
      const fix = await this.geo.getCurrentPosition({
        enableHighAccuracy: true,
        maximumAge: 4000,
        timeout: 15000,
      });
      if (fix) this.applyFix(fix.lat, fix.lng, fix.accuracy, fix.bearing, true);
    } catch (e) {
      this.error = `Could not read GPS: ${(e as Error)?.message || 'permission denied'}`;
    }

    // Offline → we own the watch (purely to animate the marker). Online → the
    // presence service already streams + feeds onLocated, so we stay out of it.
    if (this.dashboardActive && !this.isOnline) {
      await this.startVisualWatch();
    }
  }

  private async startVisualWatch(): Promise<void> {
    if (this.visualWatchId) return;
    this.visualWatchId = await this.geo.watchPosition(
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 30000 },
      (fix, err) => {
        if (err || !fix) return;
        this.applyFix(fix.lat, fix.lng, fix.accuracy, fix.bearing);
      },
    );
  }

  private async stopVisualWatch(): Promise<void> {
    const id = this.visualWatchId;
    if (!id) return;
    this.visualWatchId = null;
    await this.geo.clearWatch(id);
  }

  /** Recenter FAB — re-arm follow mode and snap back to the driver. */
  async recenter(): Promise<void> {
    this.followMe = true;
    if (this.activeFixedVehicleOpen) {
      this.fitFixedRideOverview();
      return;
    }
    if (this.lastPos && this.map) {
      this.gpsCamera.follow(this.map, this.lastPos);
      return;
    }
    this.locating = true;
    try {
      const fix = await this.geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      if (fix) this.applyFix(fix.lat, fix.lng, fix.accuracy, fix.bearing, true);
    } catch (e) {
      this.error = `Could not read GPS: ${(e as Error)?.message || 'permission denied'}`;
    } finally {
      this.locating = false;
    }
  }

  /**
   * Single source of truth for "put the driver on the map". Builds the puck +
   * accuracy ring once, then only moves them on subsequent fixes.
   */
  private applyFix(
    lat: number,
    lng: number,
    accuracy: number | null,
    bearing: number | null,
    recenter = false,
  ): void {
    this.hasFix = true;
    this.maybeFinishHome();
    this.lastPos = { lat, lng };
    if (!this.map) return;
    const pos = { lat, lng };

    if (this.accuracyCircle) {
      this.accuracyCircle.setMap(null);
      this.accuracyCircle = null;
    }
    this.markerHeading = null;

    const hasCarContent = this.selfMarker?.content?.classList?.contains('fixed-driver-car-marker');
    if (!this.selfMarker || !hasCarContent) {
      if (this.selfMarker) this.selfMarker.map = null;
      this.selfMarker = new google.maps.marker.AdvancedMarkerElement({
        map: this.map,
        position: pos,
        title: 'You',
        content: buildReusableCarMarkerElement({
          bearing: bearing ?? 0,
          label: 'You',
          markerUrl: (this.driver as any)?.vehicle?.map_marker_url || (this.driver as any)?.map_marker_url || null,
        }),
        zIndex: 1000,
      });
    } else {
      this.selfMarker.position = pos;
      if (this.selfMarker.map !== this.map) {
        this.selfMarker.map = this.map;
      }
      if (bearing != null) {
        updateCarMarkerBearing(this.selfMarker, bearing);
      }
      const expectedMarkerUrl = (this.driver as any)?.vehicle?.map_marker_url
        || (this.driver as any)?.map_marker_url
        || null;
      if (expectedMarkerUrl) {
        updateCarMarkerImage(this.selfMarker, expectedMarkerUrl);
      }
    }

    if (recenter || this.followMe) {
      this.gpsCamera.follow(this.map, pos, bearing);
    }
  }

  private buildSelfMarkerContent(): HTMLElement {
    // Styles for these classes live in global.scss — AdvancedMarkerElement
    // content is rendered outside this component's view encapsulation, so
    // component-scoped SCSS (and @keyframes) would not reach it.
    const wrap = document.createElement('div');
    wrap.className = 'driver-puck';

    const pulse = document.createElement('div');
    pulse.className = 'driver-puck__pulse';

    const heading = document.createElement('div');
    heading.className = 'driver-puck__heading';
    heading.style.opacity = '0';
    this.markerHeading = heading;

    const dot = document.createElement('div');
    dot.className = 'driver-puck__dot';

    wrap.appendChild(pulse);
    wrap.appendChild(heading);
    wrap.appendChild(dot);
    return wrap;
  }

  // ------------------------------------------------------------ online flip ---

  async goOnline(silent = false): Promise<void> {
    if (!(await this.locationConsent.ensure())) return;
    if (this.toggling) return;
    if (this.isWalletBelowLimit) {
      if (!silent) void this.showWalletLowAlert();
      return;
    }
    if (!this.canGoOnline) {
      if (!silent) await this.showDocumentRequirements(true);
      return;
    }
    this.toggling = true;
    this.isGoingOnline = true;
    this.error = null;

    try {
      try { localStorage.setItem('dc_driver_intended_online', '1'); } catch { /* ignore */ }
      await this.geo.requestPermissions();

      await new Promise<void>((resolve, reject) => {
        this.api.post<{ driver: Record<string, unknown> }>('/drivers/go-online', {}).subscribe({
          next: (res) => {
            this.driver = res.driver;
        const driverMarkerUrl = (res.driver as any)?.vehicle?.map_marker_url
          || (res.driver as any)?.map_marker_url
          || null;
        if (this.selfMarker && driverMarkerUrl) {
          updateCarMarkerImage(this.selfMarker, driverMarkerUrl);
        }
            this.driveMode = (res.driver?.['active_service_mode'] as 'private' | 'fixed' | 'shuttle' | null) ?? null;
            this.driveScope = (res.driver?.['active_service_scope'] as 'local' | 'outstation' | 'both' | null) ?? null;
            resolve();
          },
          error: (err) => reject(err),
        });
      });

      // Hand GPS ownership to the presence service (it streams + feeds onLocated).
      await this.stopVisualWatch();
      await this.presence.start();
      this.startOnlineTimer();

      await this.waitForMap();
      if (this.map) {
        google.maps.event.trigger(this.map, 'resize');
      }
      this.followMe = true;
    } catch (e) {
      const body = (e as { error?: Record<string, unknown> })?.error;
      if (body?.['error_code'] === 'documents_required') {
        try { localStorage.removeItem('dc_driver_intended_online'); } catch { /* ignore */ }
        this.documentRequirements = (body['document_requirements'] as DocumentRequirement[]).filter(doc => doc.status !== 'approved');
        await this.showDocumentRequirements(true);
      } else if (!silent) {
        this.error = (body?.['message'] as string) || (e as Error)?.message || 'Could not go online';
      }
    } finally {
      this.toggling = false;
      this.isGoingOnline = false;
    }
  }

  async showWalletLowAlert(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Wallet Balance Low',
      subHeader: `Current: ₹${this.walletBalance.toFixed(2)} · Required Limit: ₹${this.minWalletLimit.toFixed(2)}`,
      message: 'Your wallet balance is below the minimum required limit. Please recharge your wallet to go online and receive rides.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Recharge Wallet', handler: () => this.openWalletTopup() },
      ],
    });
    await alert.present();
  }

  openWalletTopup(): void {
    this.navTo('/tabs/wallet');
  }

  async goOffline(): Promise<void> {
    if (this.toggling) return;
    this.toggling = true;
    this.isGoingOffline = true;
    this.error = null;

    try {
      try { localStorage.removeItem('dc_driver_intended_online'); } catch { /* ignore */ }
      await new Promise<void>((resolve, reject) => {
        this.api.post<{ driver: Record<string, unknown> }>('/drivers/go-offline', {}).subscribe({
          next: (res) => { this.driver = res.driver; resolve(); },
          error: (err) => reject(new Error(err?.error?.message || 'Could not go offline')),
        });
      });
      await this.presence.stop();
      this.driveMode = null;
      this.driveScope = null;
      this.clearActiveFixedRide();
      this.stopOnlineTimer();
      // Keep showing the driver where they are — take the watch back ourselves.
      await this.startVisualWatch();
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.toggling = false;
      this.isGoingOffline = false;
    }
  }

  // ----------------------------------------------------------- online timer ---

  private startOnlineTimer(): void {
    if (this.onlineTimer) return;
    if (!this.onlineSince) this.onlineSince = Date.now();
    this.tickElapsed();
    this.onlineTimer = setInterval(() => this.tickElapsed(), 1000);
  }

  private stopOnlineTimer(): void {
    if (this.onlineTimer) {
      clearInterval(this.onlineTimer);
      this.onlineTimer = null;
    }
    this.onlineSince = null;
    this.onlineElapsed = '00:00';
  }

  private tickElapsed(): void {
    if (!this.onlineSince) return;
    const secs = Math.max(0, Math.floor((Date.now() - this.onlineSince) / 1000));
    const pad = (n: number) => n.toString().padStart(2, '0');
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    this.onlineElapsed = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
}
import { driverProfileErrorMessage } from '../../core/profile-error.helper';
