import { buildFixedRidePin, fixedRideNavigationTarget } from '../../../core/fixed-ride-map';
import { NavigationRouteRenderer, separateNavigationMarkers } from '../../../core/navigation-route.helper';
import { CUSTOMER_MAP_STYLE, focusCustomerNavigation } from '../../../core/customer-map';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ViewDidEnter, ViewDidLeave, ViewWillEnter } from '@ionic/angular';
import { Subscription, interval } from 'rxjs';

import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import {
  buildPassengerMarkerElement,
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
} from '../../../core/car-marker.helper';
import { GeolocationService } from '../../../core/geolocation.service';
import { PlacesService } from '../../../core/places.service';
import { RealtimeService, TripLocationPayload } from '../../../core/realtime.service';
import {
  BookingService,
  nearestCity,
  distanceKm,
  pointInPolygon,
  scopesOffered,
  tilesFor,
  RawScope
} from '../booking.service';
import { City, RideMode, ServiceTile, TripScope } from '../booking.models';
import { environment } from '../../../../environments/environment';

declare const google: any;

export interface AppBanner {
  id: number;
  title: string;
  image_url: string;
  url_link: string | null;
  target_app: 'customer' | 'driver' | 'both';
  position: 'full_screen' | 'half';
  is_active: boolean;
}

export interface ActiveFixedRide {
  id: number;
  route_name?: string | null;
  trip_id?: number | null;
  departure_status?: string | null;
  status: string;
  driver_name?: string | null;
  driver_phone?: string | null;
  vehicle_name?: string | null;
  vehicle_brand?: string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
  vehicle_reg_no?: string | null;
  map_marker_url?: string | null;
  image_url?: string | null;
  vehicle?: any;
  board?: string | null;
  drop?: string | null;
  board_lat?: number | null;
  board_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  fare_amount?: number | null;
  boarding_code?: string | null;
  seats?: number;
  stops?: Array<{ id: number; seq: number; name: string; lat: number | null; lng: number | null }>;
  latest_driver_location?: { lat: number; lng: number; recorded_at?: string } | null;
}

interface HomeRoute {
  id: number;
  name: string;
  scope: TripScope;
  origin_name?: string;
  dest_name?: string;
  flat_fare?: number | null;
  stops?: Array<{ id: number }>;
}

interface HomeOffer {
  id: number;
  title: string;
  discount_label: string;
  subtitle?: string | null;
  description?: string | null;
  status: 'available' | 'used' | 'expired';
  is_available: boolean;
}

/**
 * Home — Google Maps behind the bottom sheet, live GPS tracking & Active Ride overlay.
 */
@Component({
  selector: 'app-booking-home',
  templateUrl: './booking-home.page.html',
  styleUrls: ['./booking-home.page.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookingHomePage implements OnInit, ViewWillEnter, ViewDidEnter, ViewDidLeave, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapElRef!: ElementRef<HTMLDivElement>;
  private failedProfileImageUrl: string | null = null;

  get profileImageUrl(): string | null {
    const url = this.auth.resolveAvatarUrl(this.auth.getUser());
    return url && url !== this.failedProfileImageUrl ? url : null;
  }

  onProfileImageError(url: string): void {
    this.failedProfileImageUrl = url;
    this.cdr.markForCheck();
  }

  loading = true;
  locationFetching = true;
  locationPermissionNeeded = false;
  locationMessage = 'We couldn’t access your location. Enable location access and try again.';
  private locationRevision = 0;
  private pageActive = true;
  private homeInitPromise: Promise<void> | null = null;
  private mapInitPromise: Promise<void> | null = null;
  private watchStarting = false;
  private watchRevision = 0;
  private catalogFix: { lat: number; lng: number } | null = null;
  private resolvingFix: { lat: number; lng: number } | null = null;
  private catalogRetryAfter = 0;
  mapReady = false;

  scope: TripScope = 'local';
  scopes: TripScope[] = ['local'];
  mode: RideMode | null = null;
  tiles: ServiceTile[] = [];

  city: City | null = null;
  located = false;
  homeExpanded = false;
  offersTab: 'offers' | 'coupons' = 'offers';
  savedPlaces: Array<{ label: string }> = [];
  homeOffers: HomeOffer[] = [];
  offerBanners: AppBanner[] = [];
  private failedHomeBannerImages = new Set<string>();
  private homeOffersSub?: Subscription;
  homeRoutes: HomeRoute[] = [];
  routesLoading = false;
  routesError = false;
  private homeRoutesSub?: Subscription;

  // ── App Banners ─────────────────────────────────────────────────────────
  fullScreenBanner: AppBanner | null = null;
  halfBanner: AppBanner | null = null;
  isFullScreenDismissed = false;

  // Active Live Fixed Ride
  activeFixedRide: ActiveFixedRide | null = null;
  private activeRidePollSub?: Subscription;
  private activeRideTrackingUnsub: (() => void) | null = null;
  private activeRideTrackingTripId: number | null = null;
  private fixedPickupMarker: any = null;
  private fixedDropMarker: any = null;
  private fixedDriverMarker: any = null;
  private activeNavigation = new NavigationRouteRenderer();
  private activeRideRequest = 0;
  private overviewBookingId: number | null = null;
  private overviewBoarded = false;
  private driverPosition: { lat: number; lng: number } | null = null;
  private driverBearing = 0;

  private catalog: RawScope[] = [];

  // ── Google Maps internals ────────────────────────────────────────────────
  private map: any = null;
  private userMarker: any = null;   // AdvancedMarkerElement
  private accuracyCircle: any = null;
  private watchId: string | null = null;

  constructor(
    private alertCtrl: AlertController,
    private api: ApiService,
    private auth: AuthService,
    private booking: BookingService,
    private geo: GeolocationService,
    private places: PlacesService,
    private realtime: RealtimeService,
    private router: Router,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  private bannerRealtimeUnsub: (() => void) | null = null;
  private bannerPollSub?: Subscription;

  async ngOnInit(): Promise<void> {
    this.setupBannerSubscription();
    this.loadBanners();
    await this.initHome();
  }

  ionViewWillEnter(): void {
    this.pageActive = true;
    this.loadSavedPlaces();
    this.loadHomeOffers();
    if (!this.located || !this.city) {
      void this.initHome();
    }
    this.setupBannerSubscription();
    this.loadBanners();
    this.checkActiveFixedRide();
    this.activeRidePollSub ??= interval(6000).subscribe(() => this.checkActiveFixedRide());
  }

  ionViewDidEnter(): void {
    if (!this.watchId) {
      void this.startWatch();
    }
    if (this.map && this.activeFixedRide) {
      this.syncActiveRideMap();
    }
  }

  ionViewDidLeave(): void {
    this.pageActive = false;
    ++this.locationRevision;
    ++this.watchRevision;
    this.watchStarting = false;
    this.resolvingFix = null;
    this.homeInitPromise = null;
    this.homeRoutesSub?.unsubscribe();
    if (this.watchId) {
      void this.geo.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.activeRidePollSub?.unsubscribe();
    this.activeRidePollSub = undefined;
    this.stopActiveRideTracking();
    this.clearActiveRideMap();
    this.bannerPollSub?.unsubscribe();
    this.bannerPollSub = undefined;
  }

  ngOnDestroy(): void {
    this.pageActive = false;
    ++this.locationRevision;
    ++this.watchRevision;
    this.homeOffersSub?.unsubscribe();
    this.homeRoutesSub?.unsubscribe();
    if (this.watchId) {
      void this.geo.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.activeRidePollSub?.unsubscribe();
    this.activeRidePollSub = undefined;
    this.stopActiveRideTracking();
    this.clearActiveRideMap();
    this.bannerRealtimeUnsub?.();
    this.bannerRealtimeUnsub = null;
    this.bannerPollSub?.unsubscribe();
    this.bannerPollSub = undefined;
    this.userMarker = null;
    this.map = null;
  }

  // ── App Banners handlers ────────────────────────────────────────────────
  setupBannerSubscription(): void {
    if (!this.bannerRealtimeUnsub) {
      this.bannerRealtimeUnsub = this.realtime.subscribeAppBanners((payload) => {
        if (payload.target_app === 'both' || payload.target_app === 'customer') {
          this.zone.run(() => this.loadBanners(true));
        }
      });
    }

    this.bannerPollSub ??= interval(20000).subscribe(() => {
      this.loadBanners(false);
    });
  }

  loadBanners(isLiveEvent = false): void {
    this.api.get<{ data: AppBanner[] }>('/app-banners?app=customer').subscribe({
      next: (res) => {
        const banners = res?.data ?? [];
        const nextOffers = banners.filter(banner => banner.position === 'half');
        for (const banner of nextOffers) {
          const previous = this.offerBanners.find(item => item.id === banner.id);
          if (!previous || previous.title !== banner.title || previous.image_url !== banner.image_url || previous.url_link !== banner.url_link) {
            this.failedHomeBannerImages.delete(`${banner.id}:${banner.image_url}`);
          }
        }
        this.offerBanners = nextOffers;
        const newFullScreen = banners.find((b) => b.position === 'full_screen') || null;
        const newHalf = banners.find((b) => b.position === 'half') || null;

        // If a full-screen banner was added or changed by admin, make it visible live!
        if (newFullScreen) {
          const changed = !this.fullScreenBanner ||
            this.fullScreenBanner.id !== newFullScreen.id ||
            this.fullScreenBanner.title !== newFullScreen.title ||
            this.fullScreenBanner.image_url !== newFullScreen.image_url;
          if (changed) {
            this.isFullScreenDismissed = false;
          }
        } else {
          this.isFullScreenDismissed = false;
        }

        this.fullScreenBanner = newFullScreen;
        this.halfBanner = newHalf;
        this.cdr.markForCheck();
      },
      error: () => {},
    });
  }

  dismissFullScreenBanner(): void {
    this.isFullScreenDismissed = true;
    this.cdr.markForCheck();
  }

  get homeOfferBanners(): AppBanner[] {
    return this.offerBanners.length ? this.offerBanners : (this.halfBanner ? [this.halfBanner] : []);
  }

  trackHomeBanner = (_: number, banner: AppBanner): number => banner.id;

  homeBannerImage(banner: AppBanner): string {
    return this.failedHomeBannerImages.has(`${banner.id}:${banner.image_url}`) ? '' : this.resolveBannerImageUrl(banner.image_url);
  }

  onHomeBannerImageError(banner: AppBanner): void {
    this.failedHomeBannerImages.add(`${banner.id}:${banner.image_url}`);
    this.cdr.markForCheck();
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

  private initHome(): Promise<void> {
    if (this.homeInitPromise) return this.homeInitPromise;
    const work = Promise.all([this.loadLocationAndCatalog(), this.ensureMap(), this.startWatch()]).then(() => {});
    this.homeInitPromise = work;
    void work.finally(() => { if (this.homeInitPromise === work) this.homeInitPromise = null; });
    return work;
  }

  async requestLocation(): Promise<void> {
    if (this.locationFetching) return;
    const request = this.beginLocationRequest();
    this.locationPermissionNeeded = false;
    this.locationFetching = true;
    this.cdr.markForCheck();

    try {
      // A permission-denied watch may have no native registration left. Retry
      // must replace it after permissions change, rather than retain a dead ID.
      ++this.watchRevision;
      this.watchStarting = false;
      const previousWatch = this.watchId;
      this.watchId = null;
      if (previousWatch) await this.geo.clearWatch(previousWatch);
      await this.geo.requestPermissions();
    } catch {
      /* ignore */
    }

    if (!this.isCurrentLocationRequest(request)) return;
    await this.loadLocationAndCatalog(request);
    if (this.pageActive) void this.startWatch();
  }

  // ── Map setup ────────────────────────────────────────────────────────────

  private ensureMap(): Promise<void> {
    if (this.map) return Promise.resolve();
    if (this.mapInitPromise) return this.mapInitPromise;
    const work = this.initMap();
    this.mapInitPromise = work;
    void work.finally(() => { if (this.mapInitPromise === work) this.mapInitPromise = null; });
    return work;
  }

  private async initMap(): Promise<void> {
    try {
      await this.places.ensureLoaded();
      if (!this.pageActive) return;

      const el = this.mapElRef.nativeElement;

      this.map = new google.maps.Map(el, {
        ...CUSTOMER_MAP_STYLE,
        center: { lat: 34.2985, lng: 74.4712 }, // Centered on Jammu & Kashmir region
        zoom: 14,
        disableDefaultUI: true,
        mapId: 'DEMO_MAP_ID',         // needed for AdvancedMarkerElement
        gestureHandling: 'greedy',    // single-finger pan on mobile
        clickableIcons: false,
      });

      this.zone.run(() => {
        this.mapReady = true;
        this.cdr.markForCheck();
      });

      if (this.currentCoords) {
        await this.updateMapPosition(this.currentCoords.lat, this.currentCoords.lng, 40, !this.activeFixedRide);
      }
      this.syncActiveRideMap();
    } catch {
      // Maps unavailable (offline / key missing)
      this.cdr.markForCheck();
    }
  }

  currentCoords: { lat: number; lng: number } | null = null;

  recenterMap(): void {
    if (!this.map) return;
    if (this.activeFixedRide) {
      this.syncActiveRideMap(true);
    } else if (this.currentCoords) {
      this.centerUserOnMap(this.currentCoords);
      this.map.setZoom(16);
    } else {
      void this.requestLocation();
    }
  }

  private async startWatch(): Promise<void> {
    if (!this.pageActive || this.watchId || this.watchStarting) return;
    const watchRequest = ++this.watchRevision;
    this.watchStarting = true;
    try {
      const id = await this.geo.watchPosition(
        { enableHighAccuracy: true, maximumAge: 2000 },
        (pos, err) => {
          if (!this.pageActive || watchRequest !== this.watchRevision) return;
          if (err) {
            // A failed initial watch must not supersede an in-flight GPS/catalog
            // request. A later valid fix can still recover without a page reload.
            if (!this.locationFetching) this.failLocation(++this.locationRevision);
            return;
          }
          if (pos) void this.onLocationFix(pos);
        },
      );
      if (!this.pageActive || watchRequest !== this.watchRevision) await this.geo.clearWatch(id);
      else this.watchId = id;
    } catch {
      // The explicit GPS request owns the initial error and retry state.
    } finally {
      if (watchRequest === this.watchRevision) this.watchStarting = false;
    }
  }

  private async onLocationFix(fix: { lat: number; lng: number; accuracy?: number | null; bearing?: number | null }): Promise<void> {
    if (!this.pageActive || !this.validCoords(fix)) return;
    void this.updateMapPosition(fix.lat, fix.lng, fix.accuracy ?? 40, false, fix.bearing).catch(() => {});
    if (Date.now() < this.catalogRetryAfter) return;
    const reference = this.resolvingFix || this.catalogFix;
    // GPS jitter must not continuously restart catalog loading. Re-evaluate
    // after meaningful movement, or immediately when no catalog was resolved.
    if (reference && distanceKm(fix.lat, fix.lng, reference.lat, reference.lng) < 0.5) return;
    const request = this.beginLocationRequest();
    await this.resolveLocationCatalog(fix, request);
  }

  private async updateMapPosition(
    lat: number, lng: number, accuracy: number, pan: boolean, bearing?: number | null,
  ): Promise<void> {
    const latlng = { lat, lng };
    this.currentCoords = latlng;
    if (!this.map) return;

    if (!this.userMarker) {
      const { AdvancedMarkerElement } = await (google.maps as any).importLibrary('marker');

      if (!this.pageActive || !this.map) return;
      this.userMarker ??= new AdvancedMarkerElement({
        map: this.map,
        position: latlng,
        content: buildPassengerMarkerElement({
          kind: 'pickup',
          avatarUrl: this.auth.resolveAvatarUrl(this.auth.getUser()),
        }),
        zIndex: 1100,
        title: 'Your exact location',
      });
    } else {
      if (!this.activeNavigation.following) this.userMarker.position = latlng;
    }

    if (this.activeFixedRide) {
      this.syncActiveRideMap();
      return;
    }
    this.userMarker.map = this.map;

    if (pan) {
      this.centerUserOnMap(latlng);
      this.map.setZoom(16);
    }
  }

  private centerUserOnMap(coords: { lat: number; lng: number }): void {
    this.map.setCenter(coords);
    // Keep the location pin in the visible map above the mobile booking panel.
    if (window.innerWidth < 768) {
      this.map.panBy(0, Math.round(this.mapElRef.nativeElement.clientHeight * 0.22));
    }
  }

  // ── City / catalogue loading ─────────────────────────────────────────────

  private validCoords(fix: { lat: number; lng: number } | null | undefined): fix is { lat: number; lng: number } {
    return !!fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng)
      && Math.abs(fix.lat) <= 90 && Math.abs(fix.lng) <= 180;
  }

  private isCurrentLocationRequest(request: number): boolean {
    return this.pageActive && request === this.locationRevision;
  }

  private beginLocationRequest(): number {
    const request = ++this.locationRevision;
    this.zone.run(() => {
      this.loading = true;
      this.locationFetching = true;
      this.located = false;
      this.city = null;
      this.catalog = [];
      this.tiles = [];
      this.mode = null;
      this.homeRoutesSub?.unsubscribe();
      this.homeRoutes = [];
      this.catalogRetryAfter = 0;
      this.resolvingFix = null;
      this.cdr.markForCheck();
    });
    return request;
  }

  private failLocation(request: number, message = 'We couldn’t access your location. Enable location access and try again.'): void {
    if (!this.isCurrentLocationRequest(request)) return;
    this.zone.run(() => {
      this.located = false;
      this.loading = false;
      this.locationFetching = false;
      this.locationPermissionNeeded = true;
      this.locationMessage = message;
      this.city = null;
      this.catalog = [];
      this.tiles = [];
      this.homeRoutesSub?.unsubscribe();
      this.homeRoutes = [];
      this.catalogFix = null;
      this.resolvingFix = null;
      this.cdr.markForCheck();
    });
  }

  private async loadLocationAndCatalog(request = this.beginLocationRequest()): Promise<void> {
    try {
      let fix = await this.geo.getCurrentPosition();
      if (!this.isCurrentLocationRequest(request)) return;
      if (!fix) {
        const longFix = await this.geo.getCurrentFix();
        if (longFix) fix = { lat: longFix.lat, lng: longFix.lng };
      }
      if (!this.isCurrentLocationRequest(request)) return;
      if (!this.validCoords(fix)) { this.failLocation(request); return; }
      await this.resolveLocationCatalog(fix, request);
    } catch {
      this.failLocation(request);
    }
  }

  private async resolveLocationCatalog(fix: { lat: number; lng: number }, request: number): Promise<void> {
    if (!this.isCurrentLocationRequest(request)) return;
    this.resolvingFix = fix;
    try {
      const cities = await this.booking.cities();
      if (!this.isCurrentLocationRequest(request)) return;
      // 1. Check if user coordinates match an active Admin City's boundary polygon
      let adminCity = cities.find((c) =>
        Array.isArray(c.boundary_polygon) &&
        c.boundary_polygon.length >= 3 &&
        pointInPolygon(fix.lat, fix.lng, c.boundary_polygon)
      );

      // If no polygon match, check if user is within close proximity (<= 8km) of an Admin City center
      if (!adminCity && cities.length > 0) {
        for (const c of cities) {
          if (c.center_lat != null && c.center_lng != null) {
            const km = distanceKm(fix.lat, fix.lng, Number(c.center_lat), Number(c.center_lng));
            if (km <= 8) {
              adminCity = c;
              break;
            }
          }
        }
      }

      let activeCity: City;

      if (adminCity) {
        // Admin city exists for this location -> Use the Admin city entity
        activeCity = adminCity;
      } else {
        // City does not exist in Admin -> Detect real city / town name from device coordinates
        const detectedName = await this.places.reverseGeocodeCity(fix.lat, fix.lng).catch(() => null);
        if (!this.isCurrentLocationRequest(request)) return;
        const nearest = nearestCity(cities, fix.lat, fix.lng);
        const fallbackId = nearest?.id ?? cities[0]?.id ?? 1;

        activeCity = {
          id: fallbackId,
          name: detectedName || 'Your Location',
          center_lat: fix.lat,
          center_lng: fix.lng,
        };
      }

      const catalogData = activeCity.id
        ? await this.booking.catalog(activeCity.id)
        : [];
      if (!this.isCurrentLocationRequest(request)) return;

      this.zone.run(() => {
        this.currentCoords = fix;
        this.located = true;
        this.catalogFix = fix;
        this.resolvingFix = null;
        this.city = activeCity;
        this.locationPermissionNeeded = false;
        this.booking.setCity(activeCity.id);
        this.catalog = catalogData;

        const offered = scopesOffered(this.catalog);
        this.scopes = offered.length ? offered : ['local'];
        this.scope = this.scopes[0];
        this.rebuildTiles();
        this.loadHomeRoutes();
        this.locationFetching = false;
        this.loading = false;
        this.cdr.markForCheck();
      });

      if (this.map) {
        await this.updateMapPosition(fix.lat, fix.lng, 40, true).catch(() => {});
      }
    } catch {
      this.failLocation(request, 'Your location is available, but we couldn’t load rides for this area. Please retry.');
      if (this.isCurrentLocationRequest(request)) this.catalogRetryAfter = Date.now() + 15000;
    }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────

  get hasScopeSwitch(): boolean {
    return this.scopes.length > 1;
  }

  scopeLabel(scope: TripScope): string {
    return scope === 'outstation' ? 'Outstation' : 'Local';
  }

  pickScope(scope: TripScope): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.booking.setScope(scope);
    this.mode = null;
    this.rebuildTiles();
    this.loadHomeRoutes();
    this.cdr.markForCheck();
  }

  pickMode(tile: ServiceTile): void {
    this.mode = tile.mode;
    this.booking.setMode(tile.mode, tile.rideTypeId);
    this.cdr.markForCheck();
  }

  whereTo(): void {
    this.booking.setScope(this.scope);
    if (this.mode) this.booking.setMode(this.mode);

    switch (this.mode) {
      case 'private': void this.router.navigate(['/customer-tabs/go/private']); break;
      case 'fixed':   void this.router.navigate(['/customer-tabs/go/fixed']);   break;
      case 'shuttle': void this.router.navigate(['/customer-tabs/go/shuttle']); break;
      default:        void this.router.navigate(['/customer-tabs/go/private']);
    }
  }

  trackByMode = (_: number, tile: ServiceTile): string => tile.mode;

  private rebuildTiles(): void {
    this.tiles = tilesFor(this.catalog, this.scope);
    if (this.tiles.length && !this.tiles.some((t) => t.mode === this.mode)) {
      const first = this.tiles[0];
      this.mode = first.mode;
      this.booking.setMode(first.mode, first.rideTypeId);
    }
  }

  get offersFixed(): boolean {
    return this.tiles.some(tile => tile.mode === 'fixed');
  }

  private loadSavedPlaces(): void {
    this.booking.savedPlaces().then(res => {
      this.savedPlaces = (res.data ?? [])
        .filter(place => typeof place.label === 'string' && place.label.trim())
        .slice(0, 4);
      this.cdr.markForCheck();
    }).catch(() => {
      this.savedPlaces = [];
      this.cdr.markForCheck();
    });
  }

  private loadHomeOffers(): void {
    this.homeOffersSub?.unsubscribe();
    this.homeOffersSub = this.api.get<{ data: HomeOffer[] }>('/me/coupons').subscribe({
      next: res => {
        this.homeOffers = (res.data ?? []).filter(offer => offer.is_available && offer.status === 'available').slice(0, 5);
        this.cdr.markForCheck();
      },
      error: () => {
        this.homeOffers = [];
        this.cdr.markForCheck();
      },
    });
  }

  private loadHomeRoutes(): void {
    this.homeRoutesSub?.unsubscribe();
    this.homeRoutes = [];
    this.routesError = false;
    this.routesLoading = false;
    if (!this.city || !this.offersFixed) return;
    const params = new URLSearchParams({ city_id: String(this.city.id) });
    if (this.currentCoords) {
      params.set('lat', String(this.currentCoords.lat));
      params.set('lng', String(this.currentCoords.lng));
    }
    this.routesLoading = true;
    this.homeRoutesSub = this.api.get<{ data: HomeRoute[] }>('/fixed/routes?' + params).subscribe({
      next: res => {
        this.homeRoutes = (res.data ?? []).filter(route => route.scope === this.scope).slice(0, 3);
        this.routesLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.routesLoading = false;
        this.routesError = true;
        this.cdr.markForCheck();
      },
    });
  }

  openHomeRoute(route: HomeRoute): void {
    const fixed = this.tiles.find(tile => tile.mode === 'fixed');
    if (!fixed) return;
    this.pickMode(fixed);
    this.booking.setScope(this.scope);
    void this.router.navigate(['/customer-tabs/go/fixed'], { queryParams: { routeId: route.id } });
  }

  browseFixedRoutes(): void {
    const fixed = this.tiles.find(tile => tile.mode === 'fixed');
    if (!fixed) return;
    this.pickMode(fixed);
    this.whereTo();
  }

  openVoice(): void {
    void this.router.navigate(['/customer-tabs/go/voice']);
  }

  // ── Active Live Fixed Ride Tracking & Map ────────────────────────────────
  checkActiveFixedRide(): void {
    if (!this.pageActive) return;
    const request = ++this.activeRideRequest;
    this.api.get<{ data: ActiveFixedRide[] }>('/fixed/bookings?per_page=5').subscribe({
      next: (res) => {
        if (!this.pageActive || request !== this.activeRideRequest) return;
        const list = res?.data || [];
        const active = list.find((b) =>
          ['BOOKED', 'CONFIRMED', 'BOARDED'].includes((b.status || '').toUpperCase()) &&
          !['DROPPED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].includes((b.status || '').toUpperCase())
        );

        if (active) {
          this.api.get<{ booking: ActiveFixedRide }>('/fixed/bookings/' + active.id).subscribe({
            next: (bRes) => {
              const full = bRes?.booking || active;
              if (!this.pageActive || request !== this.activeRideRequest) return;
              if (this.activeFixedRide?.id !== full.id) {
                this.clearActiveRideMap();
                this.driverPosition = null;
              }
              this.activeFixedRide = full;
              if (full.latest_driver_location?.lat != null && full.latest_driver_location?.lng != null) {
                this.driverPosition = {
                  lat: Number(full.latest_driver_location.lat),
                  lng: Number(full.latest_driver_location.lng),
                };
              }
              if (this.map) {
                this.syncActiveRideMap();
              }
              this.syncActiveRideTracking();
              this.cdr.markForCheck();
            },
            error: () => {
              if (!this.pageActive || request !== this.activeRideRequest || this.activeFixedRide?.id === active.id) return;
              this.clearActiveRideMap();
              this.driverPosition = null;
              this.activeFixedRide = active;
              if (this.map) {
                this.syncActiveRideMap();
              }
              this.syncActiveRideTracking();
              this.cdr.markForCheck();
            },
          });
        } else {
          if (this.activeFixedRide) {
            this.activeFixedRide = null;
            this.driverPosition = null;
            this.clearActiveRideMap();
            if (this.userMarker && this.map) this.userMarker.map = this.map;
            if (this.map && this.currentCoords) {
              this.map.setHeading(0);
              this.centerUserOnMap(this.currentCoords);
            }
            this.stopActiveRideTracking();
            this.cdr.markForCheck();
          }
        }
      },
      error: () => {},
    });
  }

  private syncActiveRideMap(recenter = false): void {
    if (!this.map || typeof google === 'undefined' || !this.activeFixedRide) return;
    const b = this.activeFixedRide;
    const boarded = b.status?.toUpperCase() === 'BOARDED';
    if (this.userMarker) this.userMarker.map = boarded ? null : this.map;

    // 1. Pickup Pin Marker
    if (b.board_lat != null && b.board_lng != null) {
      const pos = { lat: Number(b.board_lat), lng: Number(b.board_lng) };
      const label = 'Pickup: ' + (b.board || 'Stop');
      if (!this.fixedPickupMarker) {
        this.fixedPickupMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: label,
          content: buildFixedRidePin('pickup', label),
          zIndex: 900,
        });
      } else {
        this.fixedPickupMarker.position = pos;
        if (!this.fixedPickupMarker.map) this.fixedPickupMarker.map = this.map;
      }
    }

    // 2. Drop Pin Marker
    if (b.drop_lat != null && b.drop_lng != null) {
      const pos = { lat: Number(b.drop_lat), lng: Number(b.drop_lng) };
      const label = 'Drop: ' + (b.drop || 'Stop');
      if (!this.fixedDropMarker) {
        this.fixedDropMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: label,
          content: buildFixedRidePin('drop', label),
          zIndex: 900,
        });
      } else {
        this.fixedDropMarker.position = pos;
        if (!this.fixedDropMarker.map) this.fixedDropMarker.map = this.map;
      }
    }

    // 3. Driver Vehicle Live Marker (Only when real driver GPS position exists)
    if (this.driverPosition) {
      if (!this.fixedDriverMarker) {
        this.fixedDriverMarker = new google.maps.marker.AdvancedMarkerElement({
          position: this.driverPosition,
          map: this.map,
          title: 'Driver',
          content: buildReusableCarMarkerElement({
            bearing: this.driverBearing,
            markerUrl: b.map_marker_url || (b as any).vehicle?.map_marker_url || null,
          }),
          zIndex: 1000,
        });
      } else {
        if (!boarded) this.fixedDriverMarker.position = this.driverPosition;
        if (!this.fixedDriverMarker.map) this.fixedDriverMarker.map = this.map;
        updateCarMarkerBearing(this.fixedDriverMarker, this.driverBearing);
        const markerUrl = b.map_marker_url || (b as any).vehicle?.map_marker_url || null;
        if (markerUrl) {
          updateCarMarkerImage(this.fixedDriverMarker, markerUrl);
        }
      }
    } else if (this.fixedDriverMarker) {
      this.fixedDriverMarker.map = null;
      this.fixedDriverMarker = null;
    }

    separateNavigationMarkers(this.fixedDriverMarker, this.userMarker);
    const origin = boarded ? this.driverPosition : this.currentCoords;
    const marker = boarded ? this.fixedDriverMarker : this.userMarker;
    const target = fixedRideNavigationTarget(b);
    if (origin && target && marker) {
      this.overviewBookingId = null;
      void this.activeNavigation.render(this.map, origin, target, boarded ? 'drop' : 'pickup');
      this.activeNavigation.follow(this.map, origin, target, marker, recenter);
    } else {
      this.activeNavigation.clear();
      if (target && (recenter || this.overviewBookingId !== b.id || this.overviewBoarded !== boarded)) {
        focusCustomerNavigation(this.map, target);
        this.overviewBookingId = b.id;
        this.overviewBoarded = boarded;
      }
    }
  }

  private syncActiveRideTracking(): void {
    const tripId = this.activeFixedRide?.trip_id;
    if (!tripId) {
      this.stopActiveRideTracking();
      return;
    }
    if (this.activeRideTrackingTripId === tripId && this.activeRideTrackingUnsub) return;

    this.stopActiveRideTracking();
    this.activeRideTrackingTripId = tripId;
    this.activeRideTrackingUnsub = this.realtime.subscribeTracking(
      tripId,
      (payload: TripLocationPayload) => {
        if (this.pageActive && this.activeRideTrackingTripId === tripId && payload?.location) {
          const loc = payload.location;
          this.zone.run(() => {
            this.driverPosition = { lat: loc.lat, lng: loc.lng };
            if (loc.bearing_deg != null) this.driverBearing = loc.bearing_deg;
            this.syncActiveRideMap();
            this.cdr.markForCheck();
          });
        }
      },
      () => {
        this.zone.run(() => this.checkActiveFixedRide());
      },
    );
  }

  private stopActiveRideTracking(): void {
    if (this.activeRideTrackingUnsub) {
      this.activeRideTrackingUnsub();
      this.activeRideTrackingUnsub = null;
    }
    this.activeRideTrackingTripId = null;
  }

  private clearActiveRideMap(): void {
    if (this.fixedPickupMarker) {
      this.fixedPickupMarker.map = null;
      this.fixedPickupMarker = null;
    }
    if (this.fixedDropMarker) {
      this.fixedDropMarker.map = null;
      this.fixedDropMarker = null;
    }
    if (this.fixedDriverMarker) {
      this.fixedDriverMarker.map = null;
      this.fixedDriverMarker = null;
    }
    this.activeNavigation.clear();
    this.overviewBookingId = null;
  }

  openActiveFixedRide(): void {
    if (this.activeFixedRide?.id) {
      void this.router.navigate(['/customer-tabs/fixed-rides', this.activeFixedRide.id]);
    }
  }

  callDriver(phone?: string | null, event?: Event): void {
    event?.stopPropagation();
    if (phone) {
      window.open('tel:' + phone, '_system');
    }
  }

  activeRideStatusLabel(r: ActiveFixedRide): string {
    const status = (r.status || '').toUpperCase();
    const depStatus = (r.departure_status || '').toUpperCase();
    if (status === 'BOARDED') return 'Onboard · En Route';
    if (depStatus === 'IN_PROGRESS' || depStatus === 'STARTED') return 'Driver on route';
    if (depStatus === 'CLOSED') return 'Departure ready';
    return 'Booking confirmed';
  }
}

