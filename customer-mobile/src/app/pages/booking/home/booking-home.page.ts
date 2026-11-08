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
import { AlertController, ModalController, ViewDidEnter, ViewDidLeave, ViewWillEnter } from '@ionic/angular';
import { Subscription, interval } from 'rxjs';

import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import {
  buildPassengerMarkerElement,
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
} from '../../../core/car-marker.helper';
import { GeolocationService } from '../../../core/geolocation.service';
import { PlacesService } from '../../../core/places.service';
import { RealtimeService, TripLocationPayload } from '../../../core/realtime.service';
import {
  BookingService,
  resolveCity,
  nearestCity,
  distanceKm,
  pointInPolygon,
  scopesOffered,
  tilesFor,
  RawScope
} from '../booking.service';
import { City, RideMode, ServiceTile, TripScope } from '../booking.models';
import { environment } from '../../../../environments/environment';
import { AiBookingAssistantModalComponent } from '../../../shared/ai-booking-assistant/ai-booking-assistant.component';
import { ModeSelectModalComponent, AssistantMode } from '../../../shared/mode-select-modal/mode-select-modal.component';

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

  loading = true;
  locationFetching = true;
  locationPermissionNeeded = false;
  mapReady = false;

  scope: TripScope = 'local';
  scopes: TripScope[] = ['local'];
  mode: RideMode | null = null;
  tiles: ServiceTile[] = [];

  city: City | null = null;
  located = false;

  // ── App Banners ─────────────────────────────────────────────────────────
  fullScreenBanner: AppBanner | null = null;
  halfBanner: AppBanner | null = null;
  isFullScreenDismissed = false;
  isHalfBannerCollapsed = false;

  // Active Live Fixed Ride
  activeFixedRide: ActiveFixedRide | null = null;
  activeFixedRides: ActiveFixedRide[] = [];
  activeRideIndex = 0;
  private activeRidePollSub?: Subscription;
  private activeRideTrackingUnsub: (() => void) | null = null;
  private activeRideTrackingTripId: number | null = null;
  private fixedPickupMarker: any = null;
  private fixedDropMarker: any = null;
  private fixedDriverMarker: any = null;
  private fixedRoutePolylines: any[] = [];
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
    private modalCtrl: ModalController,
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
    if (!this.located || !this.city) {
      void this.initHome();
    }
    this.setupBannerSubscription();
    this.loadBanners();
    this.checkActiveFixedRide();
    this.activeRidePollSub ??= interval(6000).subscribe(() => this.checkActiveFixedRide());
  }

  ionViewDidEnter(): void {
    if (this.map && !this.watchId) {
      void this.startWatch();
    }
    if (this.map && this.activeFixedRide) {
      this.syncActiveRideMap();
    }
    void this.maybeShowModePrompt();
  }

  ionViewDidLeave(): void {
    if (this.watchId) {
      void this.geo.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.activeRidePollSub?.unsubscribe();
    this.activeRidePollSub = undefined;
    this.stopActiveRideTracking();
    this.bannerPollSub?.unsubscribe();
    this.bannerPollSub = undefined;
  }

  ngOnDestroy(): void {
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

        // If a half banner was added or changed by admin, make it visible live!
        if (newHalf) {
          const changed = !this.halfBanner ||
            this.halfBanner.id !== newHalf.id ||
            this.halfBanner.title !== newHalf.title ||
            this.halfBanner.image_url !== newHalf.image_url;
          if (changed) {
            this.isHalfBannerCollapsed = false;
          }
        } else {
          this.isHalfBannerCollapsed = false;
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

  collapseHalfBanner(): void {
    this.isHalfBannerCollapsed = true;
    this.cdr.markForCheck();
  }

  expandHalfBanner(): void {
    this.isHalfBannerCollapsed = false;
    this.cdr.markForCheck();
  }

  get showOfferPill(): boolean {
    if (this.locationPermissionNeeded) return false;
    if (this.fullScreenBanner && !this.isFullScreenDismissed) return false;
    if (this.halfBanner && !this.isHalfBannerCollapsed) return false;
    return (
      (!!this.fullScreenBanner && this.isFullScreenDismissed) ||
      (!!this.halfBanner && this.isHalfBannerCollapsed)
    );
  }

  reopenOfferBanner(): void {
    if (this.fullScreenBanner && this.isFullScreenDismissed) {
      this.isFullScreenDismissed = false;
    } else if (this.halfBanner && this.isHalfBannerCollapsed) {
      this.isHalfBannerCollapsed = false;
    } else {
      this.isFullScreenDismissed = false;
      this.isHalfBannerCollapsed = false;
    }
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

  private async initHome(): Promise<void> {
    this.locationFetching = true;
    this.locationPermissionNeeded = false;
    this.cdr.markForCheck();

    await Promise.all([this.loadLocationAndCatalog(), this.initMap()]);
  }

  async requestLocation(): Promise<void> {
    this.locationPermissionNeeded = false;
    this.locationFetching = true;
    this.cdr.markForCheck();

    try {
      await this.geo.requestPermissions();
    } catch {
      /* ignore */
    }

    await this.loadLocationAndCatalog();
    if (this.located && this.map) {
      await this.startWatch();
    }
  }

  // ── Map setup ────────────────────────────────────────────────────────────

  private async initMap(): Promise<void> {
    try {
      await this.places.ensureLoaded();

      const el = this.mapElRef.nativeElement;

      this.map = new google.maps.Map(el, {
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

      // Start watching GPS once map is ready
      await this.startWatch();
    } catch {
      // Maps unavailable (offline / key missing)
      this.locationFetching = false;
      this.cdr.markForCheck();
    }
  }

  currentCoords: { lat: number; lng: number } | null = null;
  private hasFittedActiveBounds = false;

  recenterMap(): void {
    if (!this.map) return;
    if (this.activeFixedRide) {
      this.fitActiveRideBounds(true);
    } else if (this.currentCoords) {
      this.map.panTo(this.currentCoords);
      this.map.setZoom(16);
    } else {
      void this.requestLocation();
    }
  }

  private async startWatch(): Promise<void> {
    // Quick first fix — centre the map immediately if no active ride.
    try {
      const fix = await this.geo.getCurrentFix();
      if (fix) {
        this.updateMapPosition(fix.lat, fix.lng, fix.accuracy ?? 40, !this.activeFixedRide, fix.bearing);
      }
    } catch {
      /* ignore */
    }

    // Continuous watch — moves user avatar marker smoothly as user walks without jarring map pans.
    try {
      if (this.watchId) {
        await this.geo.clearWatch(this.watchId);
      }
      this.watchId = await this.geo.watchPosition(
        { enableHighAccuracy: true, maximumAge: 2000 },
        (pos, err) => {
          if (err || !pos) return;
          this.updateMapPosition(pos.lat, pos.lng, pos.accuracy ?? 40, false, pos.bearing);
        },
      );
    } catch {
      /* ignore */
    }
  }

  private async updateMapPosition(
    lat: number, lng: number, accuracy: number, pan: boolean, bearing?: number | null,
  ): Promise<void> {
    if (!this.map) return;
    const latlng = { lat, lng };
    this.currentCoords = latlng;
    this.located = true;

    try {
      if (typeof google === 'undefined' || !google.maps) return;

      if (!this.userMarker) {
        const { AdvancedMarkerElement } = await (google.maps as any).importLibrary('marker');
        if (!AdvancedMarkerElement) return;

        this.userMarker = new AdvancedMarkerElement({
          map: this.map,
          position: latlng,
          content: buildPassengerMarkerElement({
            kind: 'pickup',
            name: this.auth.getUser()?.name || 'You',
            isLive: true,
            avatarUrl: this.auth.resolveAvatarUrl(this.auth.getUser()),
          }),
          zIndex: 1100,
          title: 'Your exact location',
        });
      } else {
        this.userMarker.position = latlng;
        if (!this.userMarker.map) this.userMarker.map = this.map;
      }

      if (pan && typeof this.map.setCenter === 'function') {
        this.map.setCenter(latlng);
        if (typeof this.map.setZoom === 'function') {
          this.map.setZoom(16);
        }
      }
    } catch {
      // Maps not ready or invalid key
    }
  }

  // ── City / catalogue loading ─────────────────────────────────────────────

  private async loadLocationAndCatalog(): Promise<void> {
    this.zone.run(() => {
      this.loading = true;
      this.cdr.markForCheck();
    });

    try {
      const cities = await this.booking.cities().catch(() => [] as City[]);

      // Attempt to retrieve real coordinates from device GPS
      let fix = await this.geo.getCurrentPosition();
      if (!fix) {
        const longFix = await this.geo.getCurrentFix();
        if (longFix) fix = { lat: longFix.lat, lng: longFix.lng };
      }

      const hasGpsFix = !!fix;
      if (!fix) {
        // Fall back gracefully to the first city or default center without blocking the user with a modal
        const defaultCity = cities[0] || {
          id: 1,
          name: 'Sopore',
          center_lat: 34.2985,
          center_lng: 74.4712,
        };
        fix = {
          lat: Number(defaultCity.center_lat ?? 34.2985),
          lng: Number(defaultCity.center_lng ?? 74.4712),
        };
      }

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
        ? await this.booking.catalog(activeCity.id).catch(() => [])
        : [];

      this.zone.run(() => {
        this.located = hasGpsFix || !!this.currentCoords;
        this.city = activeCity;
        this.locationPermissionNeeded = false;
        this.booking.setCity(activeCity.id);
        this.catalog = catalogData;

        const offered = scopesOffered(this.catalog);
        this.scopes = offered.length ? offered : ['local'];
        this.scope = this.scopes[0];
        this.rebuildTiles();
        this.locationFetching = false;
        this.loading = false;
        this.cdr.markForCheck();
      });

      // Pan map to user fix
      if (this.map) {
        if (hasGpsFix) {
          await this.updateMapPosition(fix.lat, fix.lng, 40, true);
        } else if (!this.currentCoords) {
          this.map.setCenter(fix);
          this.map.setZoom(12);
        }
      }
    } catch {
      this.zone.run(() => {
        const fallbackCity = {
          id: 1,
          name: 'Sopore',
          center_lat: 34.2985,
          center_lng: 74.4712,
        };
        this.located = !!this.currentCoords;
        this.city = fallbackCity as City;
        this.locationPermissionNeeded = false;
        this.locationFetching = false;
        this.loading = false;
        this.cdr.markForCheck();
      });
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
    this.cdr.markForCheck();
  }

  pickMode(tile: ServiceTile): void {
    this.mode = tile.mode;
    this.booking.setMode(tile.mode, tile.rideTypeId);
    this.cdr.markForCheck();
  }

  whereTo(): void {
    this.booking.setScope(this.scope);
    const selectedTile = this.tiles.find((t) => t.mode === this.mode);
    if (this.mode) this.booking.setMode(this.mode, selectedTile?.rideTypeId ?? null);

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

  // ── Active Live Fixed Ride Tracking & Map ────────────────────────────────
  checkActiveFixedRide(): void {
    this.api.get<{ data: ActiveFixedRide[] }>('/fixed/bookings?per_page=20').subscribe({
      next: (res) => {
        const list = res?.data || [];
        const actives = list.filter((b) =>
          ['BOOKED', 'CONFIRMED', 'BOARDED'].includes((b.status || '').toUpperCase()) &&
          !['DROPPED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].includes((b.status || '').toUpperCase())
        );

        this.activeFixedRides = actives;

        if (actives.length > 0) {
          if (this.activeRideIndex >= actives.length) {
            this.activeRideIndex = 0;
          }
          const currentActive = actives[this.activeRideIndex];
          this.loadSingleActiveRide(currentActive);
        } else {
          if (this.activeFixedRide) {
            this.activeFixedRide = null;
            this.activeFixedRides = [];
            this.activeRideIndex = 0;
            this.driverPosition = null;
            this.hasFittedActiveBounds = false;
            this.clearActiveRideMap();
            this.stopActiveRideTracking();
            this.cdr.markForCheck();
          }
        }
      },
      error: () => {},
    });
  }

  loadSingleActiveRide(active: ActiveFixedRide): void {
    this.api.get<{ booking: ActiveFixedRide }>('/fixed/bookings/' + active.id).subscribe({
      next: (bRes) => {
        const full = bRes?.booking || active;
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
        this.activeFixedRide = active;
        if (this.map) {
          this.syncActiveRideMap();
        }
        this.syncActiveRideTracking();
        this.cdr.markForCheck();
      },
    });
  }

  nextActiveRide(): void {
    if (this.activeRideIndex < this.activeFixedRides.length - 1) {
      this.activeRideIndex++;
      this.hasFittedActiveBounds = false;
      this.clearActiveRideMap();
      this.stopActiveRideTracking();
      this.loadSingleActiveRide(this.activeFixedRides[this.activeRideIndex]);
    }
  }

  prevActiveRide(): void {
    if (this.activeRideIndex > 0) {
      this.activeRideIndex--;
      this.hasFittedActiveBounds = false;
      this.clearActiveRideMap();
      this.stopActiveRideTracking();
      this.loadSingleActiveRide(this.activeFixedRides[this.activeRideIndex]);
    }
  }

  viewAllActiveRides(): void {
    void this.router.navigate(['/customer-tabs/fixed-rides'], { queryParams: { active: 1 } });
  }

  private syncActiveRideMap(): void {
    if (!this.map || typeof google === 'undefined' || !this.activeFixedRide) return;
    const b = this.activeFixedRide;

    // 1. Pickup Pin Marker
    if (b.board_lat != null && b.board_lng != null) {
      const pos = { lat: Number(b.board_lat), lng: Number(b.board_lng) };
      const label = 'Pickup: ' + (b.board || 'Stop');
      if (!this.fixedPickupMarker) {
        this.fixedPickupMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: label,
          content: this.buildDashboardPin('pickup', label),
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
          content: this.buildDashboardPin('drop', label),
          zIndex: 900,
        });
      } else {
        this.fixedDropMarker.position = pos;
        if (!this.fixedDropMarker.map) this.fixedDropMarker.map = this.map;
      }
    }

    // 3. Driver Vehicle Live Marker (Only when real driver GPS position exists)
    if (this.driverPosition) {
      const driverLabel = b.driver_name || b.vehicle_name || 'Driver';
      if (!this.fixedDriverMarker) {
        this.fixedDriverMarker = new google.maps.marker.AdvancedMarkerElement({
          position: this.driverPosition,
          map: this.map,
          title: driverLabel,
          content: buildReusableCarMarkerElement({
            bearing: this.driverBearing,
            label: driverLabel,
          }),
          zIndex: 1000,
        });
      } else {
        this.fixedDriverMarker.position = this.driverPosition;
        if (!this.fixedDriverMarker.map) this.fixedDriverMarker.map = this.map;
        updateCarMarkerBearing(this.fixedDriverMarker, this.driverBearing);
      }
    } else if (this.fixedDriverMarker) {
      this.fixedDriverMarker.map = null;
      this.fixedDriverMarker = null;
    }

    // 4. Draw Route Polyline
    this.renderActiveRidePolyline();

    // 5. Fit Map Bounds (Only once on initial load, prevents screen jumping)
    this.fitActiveRideBounds(false);
  }

  private renderActiveRidePolyline(): void {
    if (!this.map || typeof google === 'undefined') return;

    for (const poly of this.fixedRoutePolylines) {
      poly.setMap(null);
    }
    this.fixedRoutePolylines = [];
    // Route polylines eliminated: customer sees only pickup/drop pins and driver live vehicle marker
  }

  private fitActiveRideBounds(force = false): void {
    if (!this.map || typeof google === 'undefined' || !this.activeFixedRide) return;
    if (this.hasFittedActiveBounds && !force) return;

    try {
      const bounds = new google.maps.LatLngBounds();
      let count = 0;
      if (this.currentCoords) {
        bounds.extend(this.currentCoords);
        count++;
      }
      if (this.driverPosition) {
        bounds.extend(this.driverPosition);
        count++;
      }
      if (this.activeFixedRide.board_lat != null && this.activeFixedRide.board_lng != null) {
        bounds.extend({ lat: Number(this.activeFixedRide.board_lat), lng: Number(this.activeFixedRide.board_lng) });
        count++;
      }
      if (this.activeFixedRide.drop_lat != null && this.activeFixedRide.drop_lng != null) {
        bounds.extend({ lat: Number(this.activeFixedRide.drop_lat), lng: Number(this.activeFixedRide.drop_lng) });
        count++;
      }

      if (count >= 2) {
        this.map.fitBounds(bounds, { top: 80, bottom: 280, left: 40, right: 40 });
        this.hasFittedActiveBounds = true;
      }
    } catch {
      /* ignore */
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
        if (payload?.location) {
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
    for (const poly of this.fixedRoutePolylines) {
      poly.setMap(null);
    }
    this.fixedRoutePolylines = [];
  }

  private buildDashboardPin(kind: 'pickup' | 'drop', label: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `dc-dash-pin dc-dash-pin--${kind}`;
    const bg = kind === 'pickup' ? '#10B981' : '#0F172A';
    el.innerHTML = `
      <div style="background: ${bg}; color: #ffffff; font-size: 10.5px; font-weight: 850; padding: 2.5px 8px; border-radius: 99px; box-shadow: 0 3px 8px rgba(15, 23, 42, 0.3); border: 1.5px solid #ffffff; white-space: nowrap; display: flex; align-items: center; gap: 4px;">
        <span>${label}</span>
      </div>
    `;
    return el;
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

  /**
   * Opens the conversational AI Booking Assistant modal component.
   */
  async openAiAssistant(initialQuery?: string): Promise<void> {
    const lat = this.currentCoords?.lat;
    const lng = this.currentCoords?.lng;

    const modal = await this.modalCtrl.create({
      component: AiBookingAssistantModalComponent,
      cssClass: 'dc-ai-booking-modal',
      componentProps: {
        initialQuery,
        userLat: lat,
        userLng: lng,
      },
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<{ booked?: boolean; holdId?: number }>();
    if (data?.booked) {
      this.checkActiveFixedRide();
    }
  }

  /**
   * App-open mode chooser. Offers the rider hands-free voice AI vs manual tapping.
   */
  private async maybeShowModePrompt(): Promise<void> {
    try {
      if (sessionStorage.getItem('dc_mode_prompt_shown') === '1') return;
    } catch {
      /* ignore */
    }
    try {
      sessionStorage.setItem('dc_mode_prompt_shown', '1');
    } catch {
      /* ignore */
    }

    const modal = await this.modalCtrl.create({
      component: ModeSelectModalComponent,
      cssClass: 'mode-select-modal',
      componentProps: { current: this.readMode() },
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<{ mode?: AssistantMode }>();
    if (data?.mode) {
      try {
        localStorage.setItem('dc_customer_mode', data.mode);
      } catch {
        /* ignore */
      }
      if (data.mode === 'voice') {
        void this.openAiAssistant();
      }
    }
  }

  private readMode(): AssistantMode | null {
    try {
      const m = localStorage.getItem('dc_customer_mode');
      return m === 'voice' || m === 'self' ? (m as AssistantMode) : null;
    } catch {
      return null;
    }
  }
}


