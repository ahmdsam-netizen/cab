import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { App as CapacitorApp } from '@capacitor/app';
import { PluginListenerHandle } from '@capacitor/core';
import { interval, Subscription } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { customerMarkerSignature, hasCustomerLocation, isCustomerLocationLive } from '../../core/customer-location.helper';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BackgroundLocationService } from '../../core/background-location.service';
import {
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  buildPassengerMarkerElement,
  buildStopMarkerElement,
} from '../../core/car-marker.helper';
import { GeoFix, GeolocationService } from '../../core/geolocation.service';
import { PlacesService } from '../../core/places.service';
import { FixedSeatHoldRequestedPayload, RealtimeService } from '../../core/realtime.service';
import { AudioRingtoneService } from '../../core/audio-ringtone.service';
import { PushService } from '../../core/push.service';

declare const google: any;

/** Haversine formula in meters */
export function haversineDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface PendingSeatHold {
  id: number;
  route_departure_id: number;
  user_id?: number;
  board_stop_id?: number | null;
  drop_stop_id?: number | null;
  seat_labels: string[];
  seats: number;
  amount: number;
  status: string;
  expires_at: string | null;
  customer_name?: string | null;
  board_name?: string | null;
  drop_name?: string | null;
  user?: { id: number; name: string | null; phone: string | null } | null;
  board_stop?: { id: number; name: string } | null;
  drop_stop?: { id: number; name: string } | null;
}


interface FixedRoute {
  id: number;
  city_id: number;
  origin_city_id?: number | null;
  dest_city_id?: number | null;
  city_name?: string | null;
  origin_city_name?: string | null;
  dest_city_name?: string | null;
  name: string;
  scope: 'local' | 'outstation';
  origin_name: string;
  dest_name: string;
  origin_lat?: number | null;
  origin_lng?: number | null;
  dest_lat?: number | null;
  dest_lng?: number | null;
  path_polyline?: Array<{ lat: number; lng: number }> | string | null;
  flat_fare: number | null;
  image_url?: string | null;
  max_luggage_per_vehicle: number;
  stops?: FixedStop[];
}

interface FixedVehicle {
  id: number;
  route_id: number;
  trip_id?: number | null;
  route_name: string;
  origin_name?: string | null;
  dest_name?: string | null;
  scope: string;
  capacity: number;
  seats_taken: number;
  seats_remaining: number;
  status: string;
  visible_to_customers: boolean;
  fixed_last_reached_stop_seq?: number | null;
  fixed_last_reached_stop_at?: string | null;
  active_hold_count?: number;
  reservation_count?: number;
  map_marker_url?: string | null;
  image_url?: string | null;
}

interface SeatLayout {
  id: number;
  name: string;
  rows: number;
  cols: number;
  seat_count: number;
}

export interface SeatMapCell {
  row: number;
  col: number;
  kind: 'seat' | 'blocked' | 'aisle';
  label: string | null;
  category?: string | null;
  price_delta?: number;
  status: 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED' | 'AISLE';
}

export interface DepartureSeatMap {
  departure: { id: number; route_id: number; status: string };
  layout: { id: number; name: string; rows: number; cols: number };
  cells: SeatMapCell[];
}

interface FixedPassenger {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  customer_lat?: number | null;
  customer_lng?: number | null;
  customer_location_updated_at?: string | null;
  seats: number;
  seat_labels?: string[];
  status: string;
  no_show_unlock_at?: string | null;
  payment_status: string | null;
  fare_amount: number | null;
  board_stop_id?: number | null;
  drop_stop_id?: number | null;
  board: string | null;
  drop: string | null;
  board_lat?: number | null;
  board_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  customer_avatar_url?: string | null;
}

interface FixedStop {
  id: number;
  seq: number;
  name: string;
  lat?: number | null;
  lng?: number | null;
  is_pickup?: boolean;
  is_drop?: boolean;
  is_active?: boolean;
  is_temporarily_unavailable?: boolean;
}

interface StopGuide extends FixedStop {
  waitingCount: number;
  boardedCount: number;
  dropCount: number;
  completedCount: number;
  status: 'done' | 'next' | 'pending';
}

export interface FixedCitySettings {
  fixed_waiting_time_per_stop_minutes?: number;
  fixed_stop_arrival_radius_m?: number;
  fixed_stop_arrival_dwell_seconds?: number;
  fixed_driver_missed_stop_grace_minutes?: number;
  fixed_customer_pickup_radius_m?: number;
  fixed_vehicle_approaching_alert_radius_m?: number;
  fixed_customer_grace_minutes?: number;
}

export interface StopDetailModalData {
  stop: FixedStop;
  guide: StopGuide;
  isReached: boolean;
  isNext: boolean;
  arrivalRadiusM: number;
  customerPickupRadiusM: number;
  approachingRadiusM: number;
  waitTimeMin: number;
  dwellSec: number;
  customerGraceMin: number;
  driverMissedGraceMin: number;
  boardingPassengers: FixedPassenger[];
  droppingPassengers: FixedPassenger[];
}

interface ManifestResponse {
  departure: FixedVehicle;
  passengers: FixedPassenger[];
  stops?: FixedStop[];
  city_settings?: FixedCitySettings;
}

@Component({
  selector: 'app-fixed-driver',
  templateUrl: './fixed-driver.page.html',
  styleUrls: ['./fixed-driver.page.scss'],
  standalone: false,
})
export class FixedDriverPage implements OnDestroy {
  private configuredDriverMarkerUrl: string | null = null;
  get driverMapMarkerUrl(): string | null {
    return this.activeVehicle?.map_marker_url || this.configuredDriverMarkerUrl || (this.auth.getUser() as any)?.vehicle?.map_marker_url || null;
  }

  get stopDistanceLabel(): string {
    const stop = this.selectedStopDetail?.stop;
    if (!this.driverPosition || stop?.lat == null || stop.lng == null) return stop ? `Stop ${stop.seq}` : '';
    const distance = haversineDistanceMeters(this.driverPosition.lat, this.driverPosition.lng, stop.lat, stop.lng);
    return distance >= 1000 ? `${(distance / 1000).toFixed(1)} km away` : `${Math.round(distance)} m away`;
  }

  get nextPassengerAtStop(): FixedPassenger | null {
    return this.selectedStopDetail?.boardingPassengers.find(passenger =>
      this.boardReady(passenger) && this.boardCooldown(passenger) <= 0) ?? null;
  }

  async verifyStopPassengers(): Promise<void> {
    const passenger = this.nextPassengerAtStop;
    if (passenger && !this.busy && !this.otpSending) await this.board(passenger);
  }

  private failedPassengerAvatars = new Set<string>();

  passengerAvatarUrl(passenger: FixedPassenger): string | null {
    const url = passenger.customer_avatar_url?.trim();
    return url && !this.failedPassengerAvatars.has(url) ? url : null;
  }

  onPassengerAvatarError(passenger: FixedPassenger): void {
    const url = passenger.customer_avatar_url?.trim();
    if (url) this.failedPassengerAvatars.add(url);
  }

  loading = false;
  busy = false;
  error: string | null = null;
  message: string | null = null;

  routes: FixedRoute[] = [];
  vehicles: FixedVehicle[] = [];
  selectedRouteId: number | null = null;
  routeChoiceId: number | null = null;
  failedRouteImages = new Set<string>();

  routeCardImage(route: FixedRoute): string | null {
    const url = route.image_url?.trim();
    return url && !this.failedRouteImages.has(url) ? url : null;
  }

  onRouteImageError(route: FixedRoute): void {
    const url = route.image_url?.trim();
    if (url) this.failedRouteImages.add(url);
  }

  get chosenRoute(): FixedRoute | null {
    return this.filteredRoutes.find(route => route.id === this.routeChoiceId) ?? null;
  }

  reviewChosenRoute(): void {
    const route = this.chosenRoute;
    if (!route || this.loading || this.busy || this.error || this.activeVehicle) return;
    this.selectRoute(route);
  }
  capacity = 4;

  // Filters for available routes list
  driverCities: { id: number; name: string }[] = [];
  driverScope: string | null = null;
  selectedCityFilter: number | 'all' = 'all';
  selectedScopeFilter: 'all' | 'local' | 'outstation' = 'all';
  routeSearchQuery = '';
  routeProximityFilter: 'all' | 'nearby' = 'all';
  nearbyLocationLoading = false;

  async setProximityFilter(filter: 'all' | 'nearby'): Promise<void> {
    this.routeProximityFilter = filter;
    if (filter !== 'nearby' || this.nearbyLocationLoading) return;
    this.nearbyLocationLoading = true;
    try {
      const fix = await this.geo.getCurrentPosition({ timeout: 8000, maximumAge: 15000 });
      this.driverPosition = fix ? { lat: fix.lat, lng: fix.lng } : null;
    } catch {
      this.driverPosition = null;
    } finally {
      this.nearbyLocationLoading = false;
    }
  }

  private routeStartsNearby(route: FixedRoute): boolean {
    if (!this.driverPosition || this.nearbyLocationLoading) return false;
    const firstStop = route.stops?.[0];
    const lat = route.origin_lat ?? firstStop?.lat;
    const lng = route.origin_lng ?? firstStop?.lng;
    if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
    return haversineDistanceMeters(this.driverPosition.lat, this.driverPosition.lng, Number(lat), Number(lng)) <= 5000;
  }

  get filteredRoutes(): FixedRoute[] {
    return this.routes.filter((r) => {
      if (this.routeProximityFilter === 'nearby' && !this.routeStartsNearby(r)) return false;
      // 1. City Filter (matches city_id, origin_city_id, dest_city_id)
      if (this.selectedCityFilter !== 'all') {
        const cId = Number(this.selectedCityFilter);
        const matchesCity = r.city_id === cId || r.origin_city_id === cId || r.dest_city_id === cId;
        if (!matchesCity) return false;
      }

      // 2. Scope Filter (Local / Outstation)
      if (this.selectedScopeFilter !== 'all') {
        if (r.scope !== this.selectedScopeFilter) return false;
      }

      // 3. Search Query Filter
      if (this.routeSearchQuery && this.routeSearchQuery.trim()) {
        const q = this.routeSearchQuery.toLowerCase().trim();
        const destMatches = (r.dest_name || '').toLowerCase().includes(q);
        if (!destMatches) return false;
      }

      return true;
    });
  }

  get hasMultipleScopes(): boolean {
    if (this.driverScope === 'both') return true;
    const scopes = new Set(this.routes.map((r) => r.scope));
    return scopes.size > 1;
  }

  setCityFilter(cityId: number | 'all'): void {
    this.selectedCityFilter = cityId;
  }

  setScopeFilter(scope: 'all' | 'local' | 'outstation'): void {
    this.selectedScopeFilter = scope;
  }

  resetRouteFilters(): void {
    this.routeProximityFilter = 'all';
    this.selectedCityFilter = 'all';
    this.selectedScopeFilter = 'all';
    this.routeSearchQuery = '';
  }

  // Seat layouts (M6): fetched per selected route; driver picks which one to
  // open the vehicle with. Capacity derives from the layout's seat_count so
  // the seat map and the "seats total" counter can never disagree.
  layouts: SeatLayout[] = [];
  selectedLayoutId: number | null = null;
  layoutsLoading = false;

  activeVehicle: FixedVehicle | null = null;
  passengers: FixedPassenger[] = [];
  private renderedPassengerSignature = '';
  stops: FixedStop[] = [];
  citySettings: FixedCitySettings | null = null;
  selectedStopDetail: StopDetailModalData | null = null;
  passengerFilter: 'all' | 'waiting' | 'onboard' | 'done' = 'all';
  sheetTab: 'stops' | 'seats' = 'seats';
  showStopsTimeline = false;
  passengerSheetExpanded = true;
  detailsModalOpen = false;
  fixedLocationStreaming = false;

  // Seat layout map state
  seatMapData: DepartureSeatMap | null = null;
  livePanelTab: 'seats' | 'list' = 'seats';
  boardingSuccess: FixedPassenger | null = null;
  completionSummary: { route: string; capacity: number; dropped: number; noShows: number } | null = null;

  get onboardSeatCount(): number {
    return this.passengers.filter(p => p.status === 'BOARDED').reduce((sum, p) => sum + Number(p.seats || 1), 0);
  }

  get upcomingStopGuides(): StopGuide[] {
    return this.stopGuide.filter(stop => stop.status !== 'done').slice(0, 3);
  }

  get nextBoardingPassenger(): FixedPassenger | null {
    return this.passengers.find(p => p.id !== this.boardingSuccess?.id && this.boardReady(p) && this.boardCooldown(p) <= 0) ?? null;
  }

  async continueAfterBoarding(): Promise<void> {
    const next = this.nextBoardingPassenger;
    this.boardingSuccess = null;
    if (next) await this.board(next);
  }

  closeCompletion(destination: 'home' | 'history' | 'routes'): void {
    this.completionSummary = null;
    if (destination !== 'routes') void this.router.navigateByUrl(destination === 'home' ? '/tabs/dashboard' : '/tabs/history');
  }
  seatMapLoading = false;
  seatActionBusy = false;

  // Route details preview map (Step 2: Detail View Before Start Ride)
  previewMap: any = null;
  previewStopMarkers: any[] = [];
  selectedPreviewStop: FixedStop | null = null;
  previewMapLoading = false;
  previewMapFullscreen = false;

  openDetailsModal(tab: 'passengers' | 'stops' | 'seats' = 'seats'): void {
    this.sheetTab = tab === 'passengers' ? 'seats' : tab;
    if (tab === 'passengers') this.livePanelTab = 'list';
    this.detailsModalOpen = true;
    if (this.activeVehicle) {
      this.loadDepartureSeatMap(this.activeVehicle.id);
    }
  }

  openDetailsModalWithTab(tab: 'passengers' | 'stops' | 'seats'): void {
    this.openDetailsModal(tab);
  }

  selectSheetTab(tab: 'passengers' | 'stops' | 'seats'): void {
    this.sheetTab = tab === 'passengers' ? 'seats' : tab;
    if (tab === 'passengers') this.livePanelTab = 'list';
    if (tab === 'seats' && this.activeVehicle && !this.seatMapData) {
      this.loadDepartureSeatMap(this.activeVehicle.id);
    }
  }

  closeDetailsModal(): void {
    this.detailsModalOpen = false;
  }

  private map: any = null;
  private routeLine: any = null;
  private stopMarkers: any[] = [];
  private passengerMarkers: any[] = [];
  private selfMarker: any = null;
  private selfWatchId: string | null = null;

  private manifestPoll?: Subscription;
  private unsubscribeFixedCatalog: (() => void) | null = null;
  // Ticks every second while the page is open so the No-show waiting-time
  // countdown updates smoothly between the 8s manifest refreshes.
  nowMs = Date.now();
  private clockTimer?: Subscription;

  // Pending seat requests (M1.02)
  incomingSeatRequests: PendingSeatHold[] = [];
  activeSeatRequest: PendingSeatHold | null = null;
  requestCountdown = 60;
  private holdTimerSubscription?: Subscription;
  private unsubscribeDriverHoldRequests?: (() => void) | null;
  private unsubscribeDepHoldRequests?: (() => void) | null;

  // Boarding OTP popup: tapping "Board" sends a code to the customer and the
  // driver must type it back here to confirm the right passenger boards.
  otpPassenger: FixedPassenger | null = null;
  otpCode = '';
  otpError: string | null = null;
  otpSending = false;    // requesting/resending the code
  otpVerifying = false;  // checking a typed code
  otpResendIn = 0;       // seconds until Resend unlocks
  otpLockedFor = 0;      // seconds of anti-brute-force lockout
  // Per-passenger cooldown (reservation id → seconds). Set when the driver
  // closes the OTP sheet while a resend/lockout timer is still running: the
  // row's Board button shows the countdown and stays disabled until it ends,
  // then a fresh tap starts the whole process again with a new code.
  boardCooldowns: Record<number, number> = {};
  private otpTimer?: Subscription;
  private appStateHandle?: PluginListenerHandle;

  driverPosition: { lat: number; lng: number } | null = null;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private alerts: AlertController,
    private toasts: ToastController,
    private router: Router,
    private route: ActivatedRoute,
    private realtime: RealtimeService,
    private backgroundLocation: BackgroundLocationService,
    private geo: GeolocationService,
    private places: PlacesService,
    private ringtone: AudioRingtoneService,
    private push: PushService,
    private cd: ChangeDetectorRef,
  ) {
    this.route.queryParams.subscribe((params) => {
      const depId = params['departure'] ? Number(params['departure']) : null;
      if (depId) {
        this.loadPendingHolds(depId);
      }
    });
  }

  /**
   * Fresh GPS fix attached to board/drop/no-show requests so the backend's
   * stop-reached check never depends on the background stream being alive.
   * Falls back to {} (backend then uses the last streamed ping) if the fix
   * can't be obtained quickly.
   */
  private async actionCoords(): Promise<{ lat?: number; lng?: number }> {
    try {
      const fix = await this.geo.getCurrentPosition({ timeout: 8000, maximumAge: 15000 });
      return fix ? { lat: fix.lat, lng: fix.lng } : {};
    } catch {
      return {};
    }
  }

  ionViewWillEnter(): void {
    this.api.get<{ driver?: { map_marker_url?: string | null; vehicle?: { map_marker_url?: string | null } } }>('/drivers/me').subscribe({
      next: response => {
        this.configuredDriverMarkerUrl = response.driver?.vehicle?.map_marker_url || response.driver?.map_marker_url || null;
        this.cd.markForCheck();
      },
      error: () => {},
    });
    this.subscribeFixedCatalog();
    this.subscribeHoldRequests();
    this.startClock();
    this.refresh();

    void this.geo.getCurrentPosition({ timeout: 8000, maximumAge: 15000 }).then((fix) => {
      if (fix) {
        this.driverPosition = { lat: fix.lat, lng: fix.lng };
        this.updatePassengerMarkerDistances();
        this.cd.markForCheck();
      }
    }).catch(() => {});

    CapacitorApp.addListener('appStateChange', (state) => {
      if (state.isActive) {
        this.refresh();
        if (this.activeVehicle) {
          this.loadPendingHolds(this.activeVehicle.id);
        }
      }
    }).then((handle) => {
      this.appStateHandle = handle;
    }).catch(() => {});
  }

  ionViewWillLeave(): void {
    this.appStateHandle?.remove();
    this.appStateHandle = undefined;
    this.unsubscribeFixedCatalog?.();
    this.unsubscribeFixedCatalog = null;
    this.unsubscribeHoldRequests();
    this.stopHoldCountdown();
    this.stopManifestPolling();
    this.stopClock();
    this.closeBoardingOtp();
    // Leaving the page: drop row cooldowns and their ticker — the server
    // still enforces the exact remaining time (429 puts it back on the button).
    this.boardCooldowns = {};
    this.otpTimer?.unsubscribe();
    this.otpTimer = undefined;
    void this.stopFixedTripLocationStreaming();
    void this.stopDriverWatch();
    this.resetEmbeddedMap();
    this.destroyRoutePreviewMap();
  }

  ngOnDestroy(): void {
    this.unsubscribeHoldRequests();
    this.stopHoldCountdown();
    void this.stopDriverWatch();
    this.resetEmbeddedMap();
    this.destroyRoutePreviewMap();
  }

  private subscribeFixedCatalog(): void {
    this.unsubscribeFixedCatalog?.();
    this.unsubscribeFixedCatalog = this.realtime.subscribeFixedCatalog(() => this.refresh());
  }

  refresh(forceMap = true): void {
    this.loading = true;
    this.error = null;
    this.message = null;
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) this.loading = false;
    };

    this.api.get<{ data: FixedRoute[]; driver_cities?: { id: number; name: string }[]; driver_scope?: string }>('/fixed/driver/routes').pipe(finalize(done)).subscribe({
      next: (res) => {
        this.routes = res.data ?? [];
        if (res.driver_cities && res.driver_cities.length) {
          this.driverCities = res.driver_cities;
        } else {
          const map = new Map<number, string>();
          for (const r of this.routes) {
            if (r.city_id && r.city_name) map.set(r.city_id, r.city_name);
            if (r.origin_city_id && r.origin_city_name) map.set(r.origin_city_id, r.origin_city_name);
            if (r.dest_city_id && r.dest_city_name) map.set(r.dest_city_id, r.dest_city_name);
          }
          this.driverCities = Array.from(map.entries()).map(([id, name]) => ({ id, name }));
        }

        if (res.driver_scope) {
          this.driverScope = res.driver_scope;
        }

        if (this.selectedRouteId && !this.routes.some(r => r.id === this.selectedRouteId)) {
          this.selectedRouteId = null;
          this.destroyRoutePreviewMap();
        }
        if (this.selectedRouteId && !this.activeVehicle) {
          this.syncCapacity();
          const r = this.routes.find((item) => item.id === Number(this.selectedRouteId));
          if (r) {
            this.ensureRoutePreviewMap(r);
          }
        }
      },
      error: (err) => this.error = err?.error?.message || 'Could not load fixed routes.',
    });

    this.api.get<{ data: FixedVehicle[] }>('/fixed/driver/vehicles').pipe(finalize(done)).subscribe({
      next: (res) => {
        this.vehicles = res.data ?? [];
        this.activeVehicle = this.pickActiveVehicle();
        if (this.activeVehicle) {
          this.destroyRoutePreviewMap();
          this.loadManifest(this.activeVehicle.id, false, forceMap);
          this.startManifestPolling();
          void this.syncFixedTripLocationStreaming();
        } else {
          this.stopManifestPolling();
          void this.stopFixedTripLocationStreaming();
          this.resetEmbeddedMap();
          if (this.selectedRouteId) {
            const r = this.routes.find((item) => item.id === Number(this.selectedRouteId));
            if (r) {
              this.ensureRoutePreviewMap(r);
            }
          }
        }
      },
      error: (err) => this.error = err?.error?.message || 'Could not load fixed vehicles.',
    });
  }

  selectRoute(route: FixedRoute): void {
    this.selectedRouteId = route.id;
    this.syncCapacity();
    this.selectedPreviewStop = null;
    this.ensureRoutePreviewMap(route);
  }

  clearSelectedRoute(): void {
    this.selectedRouteId = null;
    this.layouts = [];
    this.selectedLayoutId = null;
    this.selectedPreviewStop = null;
    this.destroyRoutePreviewMap();
  }

  /**
   * Route changed: reload the layouts for the new route and (re)derive the
   * capacity. Called from the route <ion-select>'s (ionChange) hook.
   */
  syncCapacity(): void {
    this.selectedLayoutId = null;
    this.layouts = [];
    if (!this.selectedRouteId) {
      this.capacity = 1;
      return;
    }
    this.layoutsLoading = true;
    this.api.get<{ data: SeatLayout[] }>(`/fixed/driver/routes/${this.selectedRouteId}/layouts`)
      .pipe(finalize(() => this.layoutsLoading = false))
      .subscribe({
        next: (res) => {
          this.layouts = res.data ?? [];
          // Pre-select the first (usually only) layout so a single-tap Open works.
          this.selectedLayoutId = this.layouts[0]?.id ?? null;
          this.applyLayoutCapacity();
        },
        error: (err) => {
          this.error = err?.error?.message || 'Could not load seat layouts.';
        },
      });
  }

  onLayoutChange(): void {
    this.applyLayoutCapacity();
  }

  private applyLayoutCapacity(): void {
    const layout = this.layouts.find((l) => l.id === this.selectedLayoutId);
    if (layout) this.capacity = layout.seat_count;
    else this.capacity = 4;
  }

  openVehicle(): void {
    if (!this.selectedRouteId) {
      this.error = 'Select a fixed route first.';
      return;
    }
    if (!this.selectedLayoutId) {
      this.error = 'Pick a seat layout.';
      return;
    }

    this.busy = true;
    this.error = null;
    this.api.post<{ vehicle: FixedVehicle; message: string }>('/fixed/driver/vehicles', {
      route_id: this.selectedRouteId,
      vehicle_seat_layout_id: this.selectedLayoutId,
    }).pipe(finalize(() => this.busy = false)).subscribe({
      next: (res) => {
        this.message = res.message || 'Ride opened.';
        this.activeVehicle = res.vehicle;
        this.refresh();
      },
      error: (err) => {
        // If 500 or error occurs but vehicle was actually created on server, recover automatically
        this.api.get<{ vehicle?: FixedVehicle | null; data?: FixedVehicle[] }>('/fixed/driver/vehicles').subscribe({
          next: (check) => {
            const v = check?.vehicle || (Array.isArray(check?.data) && check.data.length > 0 ? check.data[0] : null);
            if (v) {
              this.activeVehicle = v;
              this.error = null;
              this.message = 'Ride active.';
              this.refresh();
            } else {
              this.error = err?.error?.message || 'Could not open ride.';
            }
          },
          error: () => {
            this.error = err?.error?.message || 'Could not open ride.';
          },
        });
      },
    });
  }

  async closeBookings(): Promise<void> {
    if (!this.activeVehicle || !this.canCloseVehicle(this.activeVehicle)) return;

    const activePassengerCount = this.passengers.filter(
      (p) => !['CANCELLED', 'NO_SHOW'].includes((p.status || '').toUpperCase())
    ).length;

    let header = 'Close ride?';
    let message = 'This closes the active ride because no customer has booked yet.';

    if (activePassengerCount > 0) {
      header = 'Cancel entire departure?';
      message = `This will cancel the departure and automatically issue a 100% full refund to all ${activePassengerCount} booked passenger(s).`;
    }

    const alert = await this.alerts.create({
      header,
      message,
      buttons: [
        { text: 'Keep open', role: 'cancel' },
        { text: activePassengerCount > 0 ? 'Cancel ride & refund all' : 'Close', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role !== 'confirm') return;

    this.busy = true;
    this.error = null;

    const endpoint = activePassengerCount > 0
      ? `/fixed/driver/vehicles/${this.activeVehicle.id}/cancel`
      : `/fixed/departures/${this.activeVehicle.id}/close-bookings`;

    const payload = activePassengerCount > 0
      ? { reason: 'Driver emergency / breakdown before departure' }
      : {};

    this.api.post<{ vehicle?: FixedVehicle | null; departure?: FixedVehicle | null; message: string }>(endpoint, payload)
      .pipe(finalize(() => this.busy = false))
      .subscribe({
        next: async (res) => {
          this.activeVehicle = res.vehicle || res.departure || null;
          this.passengers = [];
          this.stops = [];
          this.stopManifestPolling();
          await this.stopFixedTripLocationStreaming();
          await this.showToast(res.message || 'Ride closed.');
          this.refresh();
        },
        error: (err) => {
          this.error = this.apiErrorMessage(err, 'Could not close ride.');
          if (this.activeVehicle) this.loadManifest(this.activeVehicle.id, false);
        },
      });
  }

  loadManifest(vehicleId: number, showSpinner = true, forceMap = false): void {
    if (showSpinner) this.busy = true;
    const oldRadius = Number(this.citySettings?.fixed_stop_arrival_radius_m || 0);
    const oldNextStopId = this.nextStopGuide?.id;
    const oldStopsJson = JSON.stringify(this.stops.map((s) => ({ id: s.id, seq: s.seq })));
    const oldPassengersJson = this.renderedPassengerSignature;
    const oldCitySettingsJson = JSON.stringify(this.citySettings || {});
    const hadMap = !!this.map;

    this.api.get<ManifestResponse>(`/fixed/departures/${vehicleId}/manifest`)
      .pipe(finalize(() => { if (showSpinner) this.busy = false; }))
      .subscribe({
        next: (res) => {
          if (['CANCELLED', 'COMPLETED'].includes((res.departure.status || '').toUpperCase())) {
            this.activeVehicle = null;
            this.passengers = [];
            this.stops = [];
            this.incomingSeatRequests = [];
            this.seatMapData = null;
            this.boardingSuccess = null;
            this.closeDetailsModal();
            this.closeStopDetail();
            this.otpPassenger = null;
            this.stopManifestPolling();
            void this.stopFixedTripLocationStreaming();
            this.resetEmbeddedMap();
            this.refresh();
            return;
          }
          this.activeVehicle = res.departure;
          this.passengers = res.passengers ?? [];
          this.stops = this.visibleManifestStops(res.stops ?? [], this.passengers);
          if (res.city_settings) {
            this.citySettings = res.city_settings;
          }
          this.loadPendingHolds(vehicleId);
          this.loadDepartureSeatMap(vehicleId);
          void this.syncFixedTripLocationStreaming();

          const newRadius = Number(this.citySettings?.fixed_stop_arrival_radius_m || 0);
          const newStopsJson = JSON.stringify(this.stops.map((s) => ({ id: s.id, seq: s.seq })));
          const newPassengersJson = customerMarkerSignature(this.passengers);
          this.renderedPassengerSignature = newPassengersJson;
          const newCitySettingsJson = JSON.stringify(this.citySettings || {});

          // Live update stop detail popup if open
          if (this.selectedStopDetail) {
            this.openStopDetail(this.selectedStopDetail.stop);
          }

          if (!hadMap) {
            this.ensureEmbeddedMap(forceMap);
          } else if (
            forceMap ||
            oldNextStopId !== this.nextStopGuide?.id ||
            oldStopsJson !== newStopsJson ||
            oldPassengersJson !== newPassengersJson ||
            oldCitySettingsJson !== newCitySettingsJson ||
            oldRadius !== newRadius
          ) {
            if (this.map && typeof google !== 'undefined' && google.maps?.event) {
              google.maps.event.trigger(this.map, 'resize');
            }
            this.refreshEmbeddedMap(forceMap);
          }
        },
        error: (err) => {
          if (showSpinner) this.error = err?.error?.message || 'Could not load passenger list.';
        },
      });
  }

  openRouteMap(): void {
    if (!this.activeVehicle) return;
    void this.router.navigateByUrl(`/tabs/fixed/map/${this.activeVehicle.id}`);
  }

  async startRide(): Promise<void> {
    if (!this.activeVehicle) return;
    const alert = await this.alerts.create({
      header: 'Start boarding here?',
      message: 'Begin boarding passengers at the current stop. Customers can still book seats for upcoming stops.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Start boarding', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role !== 'confirm') return;

    this.busy = true;
    this.error = null;
    this.api.post<{ vehicle: FixedVehicle; message: string }>(`/fixed/departures/${this.activeVehicle.id}/start`, {})
      .pipe(finalize(() => this.busy = false))
      .subscribe({
        next: async (res) => {
          this.activeVehicle = res.vehicle;
          await this.showToast(res.message || 'Boarding started.');
          void this.syncFixedTripLocationStreaming();
          this.refresh();
        },
        error: (err) => this.error = err?.error?.message || 'Could not start boarding.',
      });
  }

  canDepart(vehicle: FixedVehicle | null): boolean {
    return (vehicle?.status || '').toUpperCase() === 'DISPATCHED';
  }

  async departRide(): Promise<void> {
    if (!this.activeVehicle || !this.canDepart(this.activeVehicle)) return;
    const alert = await this.alerts.create({
      header: 'Depart from origin?',
      message: 'This starts the route from its origin and closes boarding here. Customers can still book seats for upcoming stops.',
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Depart from origin', role: 'confirm' }],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') return;
    this.busy = true;
    this.error = null;
    this.api.post<{ vehicle: FixedVehicle; message: string }>(`/fixed/departures/${this.activeVehicle.id}/depart`, {})
      .pipe(finalize(() => this.busy = false))
      .subscribe({
        next: async (res) => {
          this.activeVehicle = res.vehicle;
          await this.showToast(res.message || 'Vehicle departed.');
          this.refresh();
        },
        error: (err) => this.error = err?.error?.message || 'Could not depart.',
      });
  }

  async completeRide(): Promise<void> {
    if (!this.activeVehicle) return;

    if (!this.canComplete(this.activeVehicle)) {
      const active = this.passengers.filter((p) =>
        ['BOOKED', 'CONFIRMED', 'BOARDED'].includes((p.status || '').toUpperCase())
      );
      if (active.length > 0) {
        const boardCount = active.filter((p) => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase())).length;
        const dropCount = active.filter((p) => (p.status || '').toUpperCase() === 'BOARDED').length;
        let details = `You have ${active.length} active passenger(s) remaining:`;
        if (boardCount > 0) details += `\n• ${boardCount} passenger(s) waiting to board`;
        if (dropCount > 0) details += `\n• ${dropCount} passenger(s) on-board needing drop-off`;
        details += '\n\nPlease board/drop, cancel, or mark no-show for all passengers before completing the ride.';

        const alert = await this.alerts.create({
          header: 'Passengers Incomplete',
          message: details,
          buttons: [{ text: 'OK', role: 'cancel' }],
        });
        await alert.present();
        return;
      }
    }

    const alert = await this.alerts.create({
      header: 'Complete fixed ride?',
      message: 'This will finish the route, complete the ride for all stops, and close the vehicle.',
      buttons: [
        { text: 'Keep open', role: 'cancel' },
        { text: 'Complete ride', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role !== 'confirm') return;

    const completedSnapshot = {
      route: this.activeVehicle.route_name || 'Fixed route',
      capacity: this.activeVehicle.capacity,
      dropped: this.passengers.filter(p => ['DROPPED', 'COMPLETED'].includes(p.status)).reduce((sum, p) => sum + Number(p.seats || 1), 0),
      noShows: this.passengers.filter(p => p.status === 'NO_SHOW').length,
    };
    this.busy = true;
    this.error = null;
    this.api.post<{ vehicle: FixedVehicle; message: string }>("/fixed/departures/" + this.activeVehicle.id + "/complete", {})
      .pipe(finalize(() => this.busy = false))
      .subscribe({
        next: async (res) => {
          this.activeVehicle = res.vehicle;
          this.stopManifestPolling();
          await this.stopFixedTripLocationStreaming();
          await this.showToast(res.message || 'Fixed ride completed.');
          this.detailsModalOpen = false;
          this.closeStopDetail();
          this.boardingSuccess = null;
          this.completionSummary = completedSnapshot;
          this.refresh();
        },
        error: (err) => this.error = err?.error?.message || 'Could not complete fixed ride.',
      });
  }

  /**
   * Boarding is OTP-gated: tapping Board sends a code to the customer
   * (on their booking screen until the SMS template is DLT-approved, then by
   * SMS; email/push per operator settings) and slides up the half-screen
   * sheet where the driver types the code the customer reads out.
   */
  async board(passenger: FixedPassenger): Promise<void> {
    if (!this.boardReady(passenger) || this.otpSending || this.boardCooldown(passenger) > 0) return;

    this.otpSending = true;
    this.error = null;
    const coords = await this.actionCoords();
    this.api.post<{ message: string; resend_after?: number }>(
      `/fixed/bookings/${passenger.id}/boarding-otp`, coords,
    )
      .pipe(finalize(() => this.otpSending = false))
      .subscribe({
        next: (res) => {
          delete this.boardCooldowns[passenger.id];
          this.openBoardingOtp(passenger);
          this.startOtpCountdown(res.resend_after ?? 30);
        },
        error: (err) => {
          // Server-side cooldown/lockout still running (e.g. app restarted):
          // put the countdown on the row's Board button instead of opening
          // the sheet — same UX as closing it mid-timer.
          if (err?.status === 429 && (err?.error?.retry_after || err?.error?.locked_for)) {
            this.setBoardCooldown(passenger.id, err.error.retry_after || err.error.locked_for);
            if (err?.error?.locked_for) {
              this.error = err?.error?.message || 'Too many wrong codes. Wait before retrying.';
            }
            return;
          }
          this.error = err?.error?.message || 'Could not send the boarding code.';
        },
      });
  }

  /** Seconds left before this passenger's Board button unlocks again. */
  boardCooldown(passenger: FixedPassenger): number {
    return this.boardCooldowns[passenger.id] ?? 0;
  }

  private setBoardCooldown(reservationId: number, seconds: number): void {
    const secs = Math.max(0, Math.round(seconds));
    if (secs <= 0) return;
    this.boardCooldowns[reservationId] = secs;
    this.ensureOtpTimer();
  }

  async resendBoardingOtp(): Promise<void> {
    const passenger = this.otpPassenger;
    if (!passenger || this.otpResendIn > 0 || this.otpLockedFor > 0 || this.otpSending) return;

    this.otpSending = true;
    this.otpError = null;
    const coords = await this.actionCoords();
    this.api.post<{ message: string; resend_after?: number }>(
      `/fixed/bookings/${passenger.id}/boarding-otp`, coords,
    )
      .pipe(finalize(() => this.otpSending = false))
      .subscribe({
        next: async (res) => {
          this.otpCode = '';
          this.startOtpCountdown(res.resend_after ?? 30);
          await this.showToast('Code re-sent to the passenger.');
        },
        error: (err) => {
          if (err?.status === 429 && err?.error?.retry_after) {
            this.startOtpCountdown(err.error.retry_after);
            return;
          }
          if (err?.status === 429 && err?.error?.locked_for) {
            this.otpError = err?.error?.message || 'Too many wrong codes.';
            this.startOtpLockout(err.error.locked_for);
            return;
          }
          this.otpError = err?.error?.message || 'Could not resend the code.';
        },
      });
  }

  async confirmBoardingOtp(): Promise<void> {
    const passenger = this.otpPassenger;
    if (!passenger || this.otpCode.length !== 4 || this.otpVerifying || this.otpLockedFor > 0) return;

    this.otpVerifying = true;
    this.otpError = null;
    const coords = await this.actionCoords();
    this.api.post<{ message: string }>(`/fixed/bookings/${passenger.id}/board`, { code: this.otpCode, ...coords })
      .pipe(finalize(() => this.otpVerifying = false))
      .subscribe({
        next: async (res) => {
          this.closeBoardingOtp();
          this.closeStopDetail();
          this.boardingSuccess = { ...passenger, status: 'BOARDED' };
          // Boarded — any leftover resend countdown is moot and the Board
          // button hides for this passenger.
          delete this.boardCooldowns[passenger.id];
          await this.showToast(res.message || 'Passenger boarded.');
          if (this.activeVehicle) this.loadManifest(this.activeVehicle.id, false);
        },
        error: (err) => {
          this.otpCode = '';
          if (err?.status === 429 && err?.error?.locked_for) {
            this.otpError = err?.error?.message || 'Too many wrong codes.';
            this.startOtpLockout(err.error.locked_for);
            return;
          }
          this.otpError = err?.error?.message || 'Wrong code. Try again.';
        },
      });
  }

  closeBoardingOtp(): void {
    // Sheet closed while a resend/lockout timer is running → move the
    // remaining seconds onto the row's Board button so the driver can't
    // hammer new codes; it re-enables by itself when the timer ends.
    if (this.otpPassenger) {
      const remaining = Math.max(this.otpResendIn, this.otpLockedFor);
      if (remaining > 0) this.setBoardCooldown(this.otpPassenger.id, remaining);
    }
    this.otpPassenger = null;
    this.otpCode = '';
    this.otpError = null;
    this.otpResendIn = 0;
    this.otpLockedFor = 0;
    if (!Object.keys(this.boardCooldowns).length) {
      this.otpTimer?.unsubscribe();
      this.otpTimer = undefined;
    }
  }

  onOtpInput(value: string | null | undefined): void {
    this.otpCode = String(value ?? '').replace(/\D+/g, '').slice(0, 4);
    if (this.otpError && this.otpCode.length > 0) this.otpError = null;
  }

  otpDigit(i: number): string {
    return this.otpCode[i] ?? '';
  }

  private openBoardingOtp(passenger: FixedPassenger): void {
    this.otpPassenger = passenger;
    this.otpCode = '';
    this.otpError = null;
    this.otpLockedFor = 0;
  }

  private startOtpCountdown(seconds: number): void {
    this.otpResendIn = Math.max(0, Math.round(seconds));
    this.ensureOtpTimer();
  }

  private startOtpLockout(seconds: number): void {
    this.otpLockedFor = Math.max(0, Math.round(seconds));
    this.ensureOtpTimer();
  }

  /**
   * One shared 1s ticker drives the in-sheet resend/lockout countdowns AND
   * the per-row Board-button cooldowns (after the sheet was closed).
   */
  private ensureOtpTimer(): void {
    if (this.otpTimer) return;
    this.otpTimer = interval(1000).subscribe(() => {
      if (this.otpResendIn > 0) this.otpResendIn--;
      if (this.otpLockedFor > 0) {
        this.otpLockedFor--;
        if (this.otpLockedFor === 0 && this.otpError) this.otpError = null;
      }
      for (const key of Object.keys(this.boardCooldowns)) {
        const id = Number(key);
        this.boardCooldowns[id]--;
        if (this.boardCooldowns[id] <= 0) delete this.boardCooldowns[id];
      }
      if (this.otpResendIn <= 0 && this.otpLockedFor <= 0 && !Object.keys(this.boardCooldowns).length) {
        this.otpTimer?.unsubscribe();
        this.otpTimer = undefined;
      }
    });
  }

  private startClock(): void {
    this.nowMs = Date.now();
    this.clockTimer?.unsubscribe();
    this.clockTimer = interval(1000).subscribe(() => (this.nowMs = Date.now()));
  }

  private stopClock(): void {
    this.clockTimer?.unsubscribe();
    this.clockTimer = undefined;
  }

  drop(passenger: FixedPassenger): void {
    if (!this.canDropPassenger(passenger)) return;
    this.updatePassenger(passenger, 'drop');
  }

  async noShow(passenger: FixedPassenger): Promise<void> {
    if (!this.canNoShowPassenger(passenger)) return;
    const alert = await this.alerts.create({
      header: 'Mark passenger no-show?',
      message: 'Use this only after reaching the pickup stop and the customer did not board.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Mark no-show', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role !== 'confirm') return;
    this.updatePassenger(passenger, 'no-show');
  }

  canCancelPassenger(passenger: FixedPassenger): boolean {
    if (this.rideStarted) return false;
    const status = (passenger.status || '').toUpperCase();
    return ['BOOKED', 'CONFIRMED'].includes(status);
  }

  async cancelPassenger(passenger: FixedPassenger): Promise<void> {
    if (!this.canCancelPassenger(passenger)) return;
    const fareText = passenger.fare_amount ? ` Full fare of ₹${passenger.fare_amount} will be automatically refunded.` : '';
    const alert = await this.alerts.create({
      header: 'Cancel Passenger Booking?',
      message: `Are you sure you want to cancel the booking for ${passenger.customer_name || 'this passenger'}?${fareText}`,
      inputs: [
        {
          name: 'reason',
          type: 'text',
          placeholder: 'Reason for cancellation (optional)',
        },
      ],
      buttons: [
        { text: 'Keep Booking', role: 'cancel' },
        {
          text: 'Cancel & Refund',
          role: 'confirm',
          cssClass: 'alert-btn-danger',
          handler: (data) => {
            this.executeCancelPassenger(passenger, data?.reason);
          },
        },
      ],
    });
    await alert.present();
  }

  private executeCancelPassenger(passenger: FixedPassenger, reason?: string): void {
    this.busy = true;
    this.error = null;
    this.api.post<{ message: string }>(`/fixed/driver/bookings/${passenger.id}/cancel`, { reason: reason || 'Driver cancelled' })
      .pipe(finalize(() => this.busy = false))
      .subscribe({
        next: async (res) => {
          await this.showToast(res.message || 'Passenger booking cancelled.');
          if (this.activeVehicle) this.loadManifest(this.activeVehicle.id, false);
        },
        error: (err) => this.error = err?.error?.message || 'Could not cancel passenger booking.',
      });
  }

  get filteredGroupedPassengers(): Array<{ stop: string; waiting: number; boarded: number; passengers: FixedPassenger[] }> {
    const list = this.passengerFilter === 'all' 
      ? this.activeManifestPassengers 
      : this.passengerFilter === 'waiting'
      ? this.passengers.filter(p => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase()))
      : this.passengerFilter === 'onboard'
      ? this.passengers.filter(p => (p.status || '').toUpperCase() === 'BOARDED')
      : this.passengers.filter(p => ['DROPPED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'].includes((p.status || '').toUpperCase()));

    const groups = new Map<string, FixedPassenger[]>();
    for (const passenger of list) {
      const stop = passenger.board || 'Boarding point';
      groups.set(stop, [...(groups.get(stop) ?? []), passenger]);
    }
    return Array.from(groups.entries()).map(([stop, passengers]) => ({
      stop,
      passengers,
      waiting: passengers.filter((p) => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase())).length,
      boarded: passengers.filter((p) => (p.status || '').toUpperCase() === 'BOARDED').length,
    }));
  }

  get waitingCount(): number {
    return this.passengers.filter(p => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase())).length;
  }

  get onboardCount(): number {
    return this.passengers.filter(p => (p.status || '').toUpperCase() === 'BOARDED').length;
  }

  get completedCount(): number {
    return this.passengers.filter(p => ['DROPPED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'].includes((p.status || '').toUpperCase())).length;
  }

  get groupedPassengers(): Array<{ stop: string; waiting: number; boarded: number; passengers: FixedPassenger[] }> {
    const groups = new Map<string, FixedPassenger[]>();
    for (const passenger of this.activeManifestPassengers) {
      const stop = passenger.board || 'Boarding point';
      groups.set(stop, [...(groups.get(stop) ?? []), passenger]);
    }
    return Array.from(groups.entries()).map(([stop, passengers]) => ({
      stop,
      passengers,
      waiting: passengers.filter((p) => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase())).length,
      boarded: passengers.filter((p) => (p.status || '').toUpperCase() === 'BOARDED').length,
    }));
  }

  get activeManifestPassengers(): FixedPassenger[] {
    return this.passengers.filter((passenger) => this.isActivePassenger(passenger));
  }

  get stopGuide(): StopGuide[] {
    if (!this.stops.length) return [];
    const reachedSeq = this.completedStopSeq;
    const nextStop = this.stops.find((stop) => Number(stop.seq || 0) > reachedSeq) ?? null;
    return this.stops.map((stop) => {
      const seq = Number(stop.seq || 0);
      return {
        ...stop,
        waitingCount: this.stopWaitingCount(stop),
        boardedCount: this.stopBoardedCount(stop),
        dropCount: this.stopDropCount(stop),
        completedCount: this.stopCompletedCount(stop),
        status: seq <= reachedSeq ? 'done' : nextStop?.id === stop.id ? 'next' : 'pending',
      };
    });
  }

  get nextStopGuide(): StopGuide | null {
    return this.stopGuide.find((stop) => stop.status === 'next') ?? null;
  }

  get lastReachedStop(): FixedStop | null {
    const reachedSeq = this.reachedStopSeq;
    if (reachedSeq <= 0) return null;
    return this.stops
      .filter((stop) => Number(stop.seq || 0) <= reachedSeq)
      .sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0))[0] ?? null;
  }

  get reachedStopSeq(): number {
    return Number(this.activeVehicle?.fixed_last_reached_stop_seq || 0);
  }

  get completedStopSeq(): number {
    return ['FORMING', 'DISPATCHED'].includes(this.activeVehicle?.status || '')
      ? 0 : this.reachedStopSeq;
  }

  get activePassengerSummary(): Array<{ label: string; count: number }> {
    const waiting = this.passengers.filter((p) => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase())).length;
    const boarded = this.passengers.filter((p) => (p.status || '').toUpperCase() === 'BOARDED').length;
    return [
      { label: 'Waiting to board', count: waiting },
      { label: 'Onboard', count: boarded },
    ].filter((item) => item.count > 0);
  }

  get completionChecklist(): Array<{ label: string; count: number; tone: 'block' | 'done' }> {
    const waiting = this.passengers.filter((p) => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase())).length;
    const boarded = this.passengers.filter((p) => (p.status || '').toUpperCase() === 'BOARDED').length;
    const dropped = this.passengers.filter((p) => ['DROPPED', 'COMPLETED'].includes((p.status || '').toUpperCase())).length;
    const noShow = this.passengers.filter((p) => (p.status || '').toUpperCase() === 'NO_SHOW').length;
    const cancelled = this.passengers.filter((p) => (p.status || '').toUpperCase() === 'CANCELLED').length;
    return [
      { label: 'Waiting', count: waiting, tone: waiting > 0 ? 'block' : 'done' },
      { label: 'Onboard', count: boarded, tone: boarded > 0 ? 'block' : 'done' },
      { label: 'Dropped', count: dropped, tone: 'done' },
      { label: 'No-show', count: noShow, tone: 'done' },
      { label: 'Cancelled', count: cancelled, tone: 'done' },
    ];
  }

  get selectedRoute(): FixedRoute | null {
    return this.routes.find((route) => route.id === Number(this.selectedRouteId)) ?? null;
  }

  get setupHelp(): string {
    if (!this.routes.length) return 'No routes available.';
    return 'Select a route.';
  }

  getRouteOriginName(route: FixedRoute | null): string {
    if (!route) return 'Origin';
    const rName = route.name?.trim() || '';
    if (rName) {
      if (rName.includes('->')) return rName.split('->')[0].trim();
      if (rName.includes('→')) return rName.split('→')[0].trim();
      if (rName.toLowerCase().includes(' to ')) return rName.split(/ to /i)[0].trim();
    }
    if (route.stops && route.stops.length > 0 && route.stops[0]?.name) {
      return route.stops[0].name.trim();
    }
    const raw = route.origin_name?.trim();
    if (raw && raw.toLowerCase() !== 'origin') return raw;
    return 'Origin';
  }

  getRouteDestName(route: FixedRoute | null): string {
    if (!route) return 'Destination';
    const rName = route.name?.trim() || '';
    if (rName) {
      if (rName.includes('->')) return rName.split('->')[1].trim();
      if (rName.includes('→')) return rName.split('→')[1].trim();
      if (rName.toLowerCase().includes(' to ')) return rName.split(/ to /i)[1].trim();
    }
    if (route.stops && route.stops.length > 1 && route.stops[route.stops.length - 1]?.name) {
      return route.stops[route.stops.length - 1].name.trim();
    }
    const raw = route.dest_name?.trim();
    if (raw && raw.toLowerCase() !== 'destination') return raw;
    return 'Destination';
  }

  get routeOriginName(): string {
    const route = this.routes.find((r) => r.id === this.activeVehicle?.route_id) || null;
    const fromRoute = this.getRouteOriginName(route);
    if (fromRoute && fromRoute !== 'Origin') return fromRoute;

    if (this.stops.length > 0 && this.stops[0]?.name) return this.stops[0].name;
    const raw = this.activeVehicle?.origin_name?.trim();
    if (raw && raw.toLowerCase() !== 'origin') return raw;
    return 'Origin';
  }

  get routeDestName(): string {
    const route = this.routes.find((r) => r.id === this.activeVehicle?.route_id) || null;
    const fromRoute = this.getRouteDestName(route);
    if (fromRoute && fromRoute !== 'Destination') return fromRoute;

    if (this.stops.length > 1 && this.stops[this.stops.length - 1]?.name) {
      return this.stops[this.stops.length - 1].name;
    }
    const raw = this.activeVehicle?.dest_name?.trim();
    if (raw && raw.toLowerCase() !== 'destination') return raw;
    return 'Destination';
  }

  vehicleRouteLine(vehicle: FixedVehicle | null): string {
    if (!vehicle) return '';
    const orig = this.routeOriginName;
    const dest = this.routeDestName;
    if (orig && dest && orig !== 'Origin' && dest !== 'Destination') return orig + ' to ' + dest;
    return vehicle.route_name || 'Fixed route';
  }

  statusLabel(vehicle: FixedVehicle | null): string {
    if (!vehicle) return '';
    switch (vehicle.status) {
      case 'FORMING': return 'Open for bookings';
      case 'DISPATCHED': return 'Boarding';
      case 'DEPARTED': return 'Departed';
      case 'COMPLETED': return 'Completed';
      case 'CANCELLED': return 'Cancelled';
      default: return vehicle.status;
    }
  }

  completeBlockReason(vehicle: FixedVehicle | null): string | null {
    if (!vehicle) return null;
    if (['COMPLETED', 'CANCELLED'].includes(vehicle.status)) return 'This ride is already closed.';
    const active = this.passengers.filter((passenger) => ['BOOKED', 'CONFIRMED', 'BOARDED'].includes(passenger.status)).length;
    if (active > 0) {
      const parts = this.activePassengerSummary.map((item) => item.count + ' ' + item.label.toLowerCase());
      return 'Complete ride is locked: ' + (parts.length ? parts.join(', ') : active + ' active passenger(s)') + ' remain.';
    }
    return null;
  }

  canStart(vehicle: FixedVehicle | null): boolean {
    if (!vehicle) return false;
    const status = (vehicle.status || '').toUpperCase();
    return status === 'FORMING' && !this.rideStarted;
  }

  canComplete(vehicle: FixedVehicle | null): boolean {
    if (!vehicle || !this.rideStarted) return false;
    const status = (vehicle.status || '').toUpperCase();
    return !['COMPLETED', 'CANCELLED'].includes(status)
      && !this.passengers.some((passenger) => ['BOOKED', 'CONFIRMED', 'BOARDED'].includes((passenger.status || '').toUpperCase()));
  }

  canCloseVehicle(vehicle: FixedVehicle | null): boolean {
    if (!vehicle) return false;
    const status = (vehicle.status || '').toUpperCase();
    return status === 'FORMING' && !this.rideStarted;
  }

  /** The ride is under way — the backend only boards/drops on a started vehicle. */
  get rideStarted(): boolean {
    return ['DISPATCHED', 'DEPARTED'].includes((this.activeVehicle?.status || '').toUpperCase());
  }

  /** This passenger row is at a status where a Board button makes sense. Kept as
   *  the button's visibility check so the affordance stays on screen (disabled)
   *  rather than vanishing while the driver hasn't started or reached the stop. */
  canBoardPassenger(passenger: FixedPassenger): boolean {
    return ['BOOKED', 'CONFIRMED'].includes((passenger.status || '').toUpperCase());
  }

  /** Every precondition the backend enforces for boarding is met, so the tap will
   *  succeed: right status, ride started, and the pickup stop reached. Gating the
   *  button on this turns the old post-tap 422s ("Start the fixed ride…", "Reach
   *  the passenger pickup stop…") into an up-front disabled state with a reason. */
  boardReady(passenger: FixedPassenger): boolean {
    return this.canBoardPassenger(passenger)
      && this.rideStarted
      && this.isPassengerPickupReached(passenger);
  }

  /** Why the Board button is disabled, or null when it's ready to tap. */
  boardBlockReason(passenger: FixedPassenger): string | null {
    if (!this.canBoardPassenger(passenger)) return null;
    if (!this.rideStarted) return 'Start boarding to begin checking in passengers';
    if (!this.isPassengerPickupReached(passenger)) {
      const stop = this.passengerBoardStop(passenger);
      return stop ? 'Board unlocks when you reach ' + stop.name : 'Board unlocks when you reach the pickup stop';
    }
    return null;
  }

  canDropPassenger(passenger: FixedPassenger): boolean {
    return (passenger.status || '').toUpperCase() === 'BOARDED';
  }

  /**
   * The No-show button appears once the vehicle has reached the pickup stop
   * (the backend then reports a no_show_unlock_at). Before that the button is
   * hidden entirely — no dead greyed-out button.
   */
  noShowVisible(passenger: FixedPassenger): boolean {
    const status = (passenger.status || '').toUpperCase();
    return ['BOOKED', 'CONFIRMED'].includes(status) && !!passenger.no_show_unlock_at;
  }

  /**
   * Seconds left on the mandatory waiting time before no-show unlocks.
   * 0 = ready (or not applicable). The server enforces the same deadline, so
   * this is only the visible countdown, not the actual gate.
   */
  noShowCountdown(passenger: FixedPassenger): number {
    if (!passenger.no_show_unlock_at) return 0;
    const remaining = new Date(passenger.no_show_unlock_at).getTime() - this.nowMs;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  noShowCountdownLabel(passenger: FixedPassenger): string {
    const secs = this.noShowCountdown(passenger);
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return mins > 0 ? `${mins}:${rem.toString().padStart(2, '0')}` : `${rem}s`;
  }

  canNoShowPassenger(passenger: FixedPassenger): boolean {
    return this.noShowVisible(passenger) && this.noShowCountdown(passenger) <= 0;
  }

  private isActivePassenger(passenger: FixedPassenger): boolean {
    return ['BOOKED', 'CONFIRMED', 'BOARDED'].includes((passenger.status || '').toUpperCase());
  }

  stopStatusLabel(stop: StopGuide): string {
    if (stop.status === 'next') return 'Next';
    if (stop.status === 'done') return 'Reached';
    return 'Upcoming';
  }


  passengerStatusLabel(passenger: FixedPassenger): string {
    switch ((passenger.status || '').toUpperCase()) {
      case 'BOOKED':
      case 'CONFIRMED':
        return 'Booked';
      case 'BOARDED':
        return 'Boarded';
      case 'DROPPED':
        return 'Dropped off';
      case 'COMPLETED':
        return 'Completed';
      case 'NO_SHOW':
        return 'No-show';
      case 'CANCELLED':
        return 'Cancelled';
      default:
        return passenger.status || 'Status';
    }
  }

  loadDepartureSeatMap(departureId: number): void {
    if (this.seatMapLoading) return;
    this.seatMapLoading = true;
    this.api.get<DepartureSeatMap>(`/fixed/driver/departures/${departureId}/seat-map`)
      .pipe(finalize(() => { this.seatMapLoading = false; }))
      .subscribe({
        next: (res) => {
          if (this.activeVehicle?.id !== departureId) return;
          this.seatMapData = res;
        },
        error: (err) => {
          this.error = err?.error?.message || 'Could not load vehicle seat layout.';
        },
      });
  }

  get availableSeatCellsCount(): number {
    return (this.seatMapData?.cells || []).filter((c) => c.kind === 'seat' && c.status === 'AVAILABLE').length;
  }

  get bookedSeatCellsCount(): number {
    return (this.seatMapData?.cells || []).filter((c) => c.kind === 'seat' && (c.status === 'BOOKED' || c.status === 'HELD')).length;
  }

  get blockedSeatCellsCount(): number {
    return (this.seatMapData?.cells || []).filter((c) => c.kind === 'seat' && c.status === 'BLOCKED').length;
  }

  get seatMapRows(): { rowIndex: number; cells: SeatMapCell[] }[] {
    if (!this.seatMapData || !this.seatMapData.cells) return [];
    const rowMap = new Map<number, SeatMapCell[]>();
    for (const cell of this.seatMapData.cells) {
      const list = rowMap.get(cell.row) || [];
      list.push(cell);
      rowMap.set(cell.row, list);
    }
    return Array.from(rowMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([rowIndex, cells]) => ({
        rowIndex,
        cells: cells.sort((a, b) => a.col - b.col),
      }));
  }

  async onSeatCellTap(cell: SeatMapCell): Promise<void> {
    if (cell.kind !== 'seat' || !cell.label || !this.activeVehicle) return;

    if (cell.status === 'AVAILABLE') {
      const alert = await this.alerts.create({
        header: `Block Seat ${cell.label}?`,
        subHeader: 'Walk-in / Offline Passenger',
        message: `Marking seat ${cell.label} will block online app customers from booking it.`,
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          {
            text: 'Block Seat',
            role: 'confirm',
            handler: () => {
              this.blockSeat(cell.label!);
            },
          },
        ],
      });
      await alert.present();
    } else if (cell.status === 'BLOCKED') {
      const alert = await this.alerts.create({
        header: `Unblock Seat ${cell.label}?`,
        subHeader: 'Passenger Dropped Off',
        message: `Release seat ${cell.label} and make it available for online customer bookings again?`,
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          {
            text: 'Unblock & Make Available',
            role: 'confirm',
            handler: () => {
              this.unblockSeat(cell.label!);
            },
          },
        ],
      });
      await alert.present();
    } else if (cell.status === 'BOOKED' || cell.status === 'HELD') {
      const p = this.passengers.find((pass) => (pass.seat_labels || []).includes(cell.label!));
      const msg = p
        ? `Booked by: ${p.customer_name || 'Passenger'} (${p.customer_phone || 'Online'})\nFrom: ${p.board || 'Origin'} → ${p.drop || 'Destination'}`
        : 'This seat is reserved online by an app customer.';
      const alert = await this.alerts.create({
        header: `Seat ${cell.label} (Online Booked)`,
        message: msg,
        buttons: ['OK'],
      });
      await alert.present();
    }
  }

  blockSeat(label: string): void {
    if (!this.activeVehicle) return;
    this.seatActionBusy = true;
    this.api.post<{ message: string; seat_map: DepartureSeatMap; vehicle: FixedVehicle }>(
      `/fixed/driver/departures/${this.activeVehicle.id}/seats/block`,
      { label }
    ).pipe(finalize(() => { this.seatActionBusy = false; })).subscribe({
      next: (res) => {
        if (res.seat_map) this.seatMapData = res.seat_map;
        if (res.vehicle) this.activeVehicle = { ...this.activeVehicle, ...res.vehicle };
        void this.showToast(res.message || `Seat ${label} blocked.`);
      },
      error: (err) => {
        this.error = err?.error?.message || `Could not block seat ${label}.`;
      },
    });
  }

  unblockSeat(label: string): void {
    if (!this.activeVehicle) return;
    this.seatActionBusy = true;
    this.api.post<{ message: string; seat_map: DepartureSeatMap; vehicle: FixedVehicle }>(
      `/fixed/driver/departures/${this.activeVehicle.id}/seats/unblock`,
      { label }
    ).pipe(finalize(() => { this.seatActionBusy = false; })).subscribe({
      next: (res) => {
        if (res.seat_map) this.seatMapData = res.seat_map;
        if (res.vehicle) this.activeVehicle = { ...this.activeVehicle, ...res.vehicle };
        void this.showToast(res.message || `Seat ${label} released.`);
      },
      error: (err) => {
        this.error = err?.error?.message || `Could not unblock seat ${label}.`;
      },
    });
  }

  passengerStatusColor(passenger: FixedPassenger): string {
    switch ((passenger.status || '').toUpperCase()) {
      case 'BOARDED':
      case 'DROPPED':
      case 'COMPLETED':
        return 'success';
      case 'NO_SHOW':
        return 'danger';
      case 'CANCELLED':
        return 'medium';
      default:
        return 'warning';
    }
  }

  passengerActionHint(passenger: FixedPassenger): string {
    const status = (passenger.status || '').toUpperCase();
    if (['BOOKED', 'CONFIRMED'].includes(status)) {
      if (!this.rideStarted) return 'Start boarding to begin checking in passengers';
      if (!this.isPassengerPickupReached(passenger)) return 'Board & no-show unlock once you reach the pickup stop';
      const secs = this.noShowCountdown(passenger);
      if (secs > 0) return 'Wait for the passenger — no-show unlocks in ' + this.noShowCountdownLabel(passenger);
      return 'Board or mark no-show';
    }
    if (status === 'BOARDED') return 'Ready to drop';
    return this.passengerStatusLabel(passenger);
  }

  private isPassengerPickupReached(passenger: FixedPassenger): boolean {
    const stop = this.passengerBoardStop(passenger);
    return !!stop && Number(stop.seq || 0) <= this.reachedStopSeq;
  }


  private visibleManifestStops(stops: FixedStop[], passengers: FixedPassenger[]): FixedStop[] {
    const usedStopIds = new Set<number>();
    passengers.forEach((passenger) => {
      if (passenger.board_stop_id) usedStopIds.add(Number(passenger.board_stop_id));
      if (passenger.drop_stop_id) usedStopIds.add(Number(passenger.drop_stop_id));
    });

    return stops
      .filter((stop) => this.isStopAvailable(stop) || usedStopIds.has(Number(stop.id)))
      .slice()
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  }

  private isStopAvailable(stop: FixedStop): boolean {
    return stop.is_active !== false && stop.is_temporarily_unavailable !== true;
  }

  private passengerBoardStop(passenger: FixedPassenger): FixedStop | null {
    const stopId = Number(passenger.board_stop_id || 0);
    if (stopId > 0) return this.stops.find((stop) => Number(stop.id) === stopId) ?? null;
    return this.stops.find((stop) => this.sameStop(passenger.board, stop.name)) ?? null;
  }

  private stopWaitingCount(stop: FixedStop): number {
    return this.passengers.filter((p) => ['BOOKED', 'CONFIRMED'].includes((p.status || '').toUpperCase()) && this.sameStop(p.board, stop.name)).length;
  }

  private stopBoardedCount(stop: FixedStop): number {
    return this.passengers.filter((p) => (p.status || '').toUpperCase() === 'BOARDED' && this.sameStop(p.board, stop.name)).length;
  }

  private stopDropCount(stop: FixedStop): number {
    return this.passengers.filter((p) => (p.status || '').toUpperCase() === 'BOARDED' && this.sameStop(p.drop, stop.name)).length;
  }

  private stopCompletedCount(stop: FixedStop): number {
    return this.passengers.filter((p) => ['DROPPED', 'COMPLETED'].includes((p.status || '').toUpperCase()) && this.sameStop(p.drop, stop.name)).length;
  }

  private sameStop(a: string | null | undefined, b: string | null | undefined): boolean {
    return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
  }

  private fixedTripId(vehicle: FixedVehicle | null): number | null {
    const tripId = Number(vehicle?.trip_id || 0);
    return tripId > 0 ? tripId : null;
  }

  private shouldStreamFixedLocation(vehicle: FixedVehicle | null): boolean {
    return !!this.fixedTripId(vehicle) && !!vehicle && ['DISPATCHED', 'DEPARTED'].includes(vehicle.status);
  }

  private async syncFixedTripLocationStreaming(): Promise<void> {
    const vehicle = this.activeVehicle;
    if (!this.shouldStreamFixedLocation(vehicle)) {
      await this.stopFixedTripLocationStreaming();
      return;
    }

    const tripId = this.fixedTripId(vehicle);
    if (!tripId) return;

    try {
      await this.backgroundLocation.start(tripId);
      this.fixedLocationStreaming = true;
    } catch (err: any) {
      this.fixedLocationStreaming = false;
      this.error = err?.message || 'Could not start fixed ride GPS sharing.';
    }
  }

  private async stopFixedTripLocationStreaming(): Promise<void> {
    if (this.backgroundLocation.isStreaming()) {
      await this.backgroundLocation.stop();
    }
    this.fixedLocationStreaming = false;
  }

  private async updatePassenger(passenger: FixedPassenger, action: 'board' | 'drop' | 'no-show'): Promise<void> {
    this.busy = true;
    this.error = null;
    const coords = await this.actionCoords();
    this.api.post<{ message: string }>(`/fixed/bookings/${passenger.id}/${action}`, coords)
      .pipe(finalize(() => this.busy = false))
      .subscribe({
        next: async (res) => {
          await this.showToast(res.message || 'Passenger updated.');
          if (this.activeVehicle) this.loadManifest(this.activeVehicle.id, false);
        },
        error: (err) => this.error = err?.error?.message || 'Could not update passenger.',
      });
  }


  private startManifestPolling(): void {
    this.stopManifestPolling();
    if (!this.activeVehicle || ["COMPLETED", "CANCELLED"].includes(this.activeVehicle.status)) return;

    this.manifestPoll = interval(4000).subscribe(() => {
      if (!this.activeVehicle) return;
      this.loadManifest(this.activeVehicle.id, false);
    });
  }

  private stopManifestPolling(): void {
    this.manifestPoll?.unsubscribe();
    this.manifestPoll = undefined;
  }

  private pickActiveVehicle(): FixedVehicle | null {
    return this.vehicles.find((vehicle) => ['FORMING', 'DISPATCHED', 'DEPARTED'].includes(vehicle.status))
      ?? this.vehicles[0]
      ?? null;
  }

  private apiErrorMessage(err: any, fallback: string): string {
    if (typeof err?.error?.message === 'string' && err.error.message.trim()) return err.error.message;
    if (typeof err?.error === 'string' && err.error.trim()) return err.error;
    if (err?.status) return fallback + ' (' + err.status + ')';
    return fallback;
  }

  private async showToast(message: string): Promise<void> {
    const toast = await this.toasts.create({ message, duration: 1800, position: 'bottom' });
    await toast.present();
  }

  /* ─── Pending Seat Requests (M1.02 / M1.03) ─── */
  private subscribeHoldRequests(): void {
    this.unsubscribeHoldRequests();
    const user = this.auth.getUser();
    if (user?.id) {
      this.unsubscribeDriverHoldRequests = this.realtime.subscribeFixedDriverHoldRequests(user.id, (payload) => {
        this.onIncomingHoldRequested(payload);
      });
    }
    if (this.activeVehicle?.id) {
      this.unsubscribeDepHoldRequests = this.realtime.subscribeDepartureHoldRequests(this.activeVehicle.id, (payload) => {
        this.onIncomingHoldRequested(payload);
      });
    }
  }

  private unsubscribeHoldRequests(): void {
    this.unsubscribeDriverHoldRequests?.();
    this.unsubscribeDriverHoldRequests = null;
    this.unsubscribeDepHoldRequests?.();
    this.unsubscribeDepHoldRequests = null;
  }

  loadPendingHolds(departureId: number): void {
    this.api.get<{ data: PendingSeatHold[] }>(`/fixed/driver/departures/${departureId}/pending-holds`).subscribe({
      next: (res) => {
        const holds = res.data ?? [];
        this.syncPendingHolds(holds);
      },
      error: () => {},
    });
  }

  private syncPendingHolds(holds: PendingSeatHold[]): void {
    const now = Date.now();
    const activeHolds = holds.filter((h) => {
      if (!h.expires_at) return true;
      return new Date(h.expires_at).getTime() > now;
    });

    this.incomingSeatRequests = activeHolds;
    if (activeHolds.length > 0) {
      if (!this.activeSeatRequest || !activeHolds.some((h) => h.id === this.activeSeatRequest?.id)) {
        this.activeSeatRequest = activeHolds[0];
        const remaining = this.activeSeatRequest.expires_at
          ? Math.max(0, Math.floor((new Date(this.activeSeatRequest.expires_at).getTime() - now) / 1000))
          : 60;
        if (remaining > 0) {
          this.startHoldCountdown();
          this.ringtone.startRinging('fixed-hold-' + this.activeSeatRequest.id, remaining);
        } else {
          this.handleHoldExpired(this.activeSeatRequest.id);
        }
      }
    } else {
      this.activeSeatRequest = null;
      this.stopHoldCountdown();
      this.ringtone.stopRinging();
    }
  }

  private onIncomingHoldRequested(payload: FixedSeatHoldRequestedPayload): void {
    const hold: PendingSeatHold = {
      id: payload.hold_id,
      route_departure_id: payload.departure_id,
      user_id: payload.customer_id,
      customer_name: payload.customer_name,
      board_name: payload.board_stop,
      drop_name: payload.drop_stop,
      seat_labels: payload.seat_labels || [],
      seats: payload.seats || 1,
      amount: payload.amount || 0,
      status: 'PENDING_DRIVER_APPROVAL',
      expires_at: payload.expires_at,
    };

    const remaining = hold.expires_at
      ? Math.max(0, Math.floor((new Date(hold.expires_at).getTime() - Date.now()) / 1000))
      : 60;
    if (remaining <= 0) {
      return; // Expired, do not ring or add
    }

    if (!this.incomingSeatRequests.some((h) => h.id === hold.id)) {
      this.incomingSeatRequests = [hold, ...this.incomingSeatRequests];
      this.activeSeatRequest = hold;
      this.startHoldCountdown();
      this.ringtone.startRinging('fixed-hold-' + hold.id, remaining);
      void this.push.showLocalNotification(
        '🚕 New Seat Booking Request!',
        `${hold.customer_name || 'Passenger'} requested ${hold.seats} seat(s) for ₹${hold.amount}. Tap to accept or decline.`,
        { hold_id: hold.id, departure_id: hold.route_departure_id, expires_at: hold.expires_at }
      );
      void this.showToast(`New seat request for ${hold.seats} seat(s)!`);
    }
  }

  private startHoldCountdown(): void {
    this.stopHoldCountdown();
    this.updateHoldCountdown();
    this.holdTimerSubscription = interval(1000).subscribe(() => {
      this.updateHoldCountdown();
    });
  }

  private updateHoldCountdown(): void {
    if (!this.activeSeatRequest?.expires_at) {
      this.requestCountdown = 60;
      return;
    }
    const diff = Math.floor((new Date(this.activeSeatRequest.expires_at).getTime() - Date.now()) / 1000);
    if (diff <= 0) {
      this.requestCountdown = 0;
      this.handleHoldExpired(this.activeSeatRequest.id);
    } else {
      this.requestCountdown = diff;
    }
  }

  private handleHoldExpired(holdId: number): void {
    this.incomingSeatRequests = this.incomingSeatRequests.filter((h) => h.id !== holdId);
    if (this.activeSeatRequest?.id === holdId) {
      this.activeSeatRequest = this.incomingSeatRequests[0] || null;
      if (this.activeSeatRequest) {
        const remaining = this.activeSeatRequest.expires_at
          ? Math.max(0, Math.floor((new Date(this.activeSeatRequest.expires_at).getTime() - Date.now()) / 1000))
          : 60;
        if (remaining > 0) {
          this.startHoldCountdown();
          this.ringtone.startRinging('fixed-hold-' + this.activeSeatRequest.id, remaining);
        } else {
          this.handleHoldExpired(this.activeSeatRequest.id);
        }
      } else {
        this.stopHoldCountdown();
        this.ringtone.stopRinging();
      }
    }
    void this.showToast('Seat request expired.');
  }

  private stopHoldCountdown(): void {
    this.holdTimerSubscription?.unsubscribe();
    this.holdTimerSubscription = undefined;
    this.ringtone.stopRinging();
  }

  acceptSeatRequest(req: PendingSeatHold): void {
    this.ringtone.stopRinging();
    this.busy = true;
    this.api.post<{ hold: PendingSeatHold; message: string }>(`/fixed/driver/seat-holds/${req.id}/accept`, {})
      .pipe(finalize(() => (this.busy = false)))
      .subscribe({
        next: async (res) => {
          this.ringtone.playSuccessChime();
          this.incomingSeatRequests = this.incomingSeatRequests.filter((h) => h.id !== req.id);
          this.activeSeatRequest = this.incomingSeatRequests[0] || null;
          if (this.activeSeatRequest) {
            this.startHoldCountdown();
            this.ringtone.startRinging('fixed-hold-' + this.activeSeatRequest.id);
          } else {
            this.stopHoldCountdown();
          }
          await this.showToast(res.message || 'Seat request accepted. Passenger has 5 minutes to pay.');
          if (this.activeVehicle) this.loadManifest(this.activeVehicle.id, false);
        },
        error: (err) => {
          void this.showToast(err?.error?.message || 'Could not accept seat request.');
        },
      });
  }

  rejectSeatRequest(req: PendingSeatHold): void {
    this.ringtone.stopRinging();
    this.busy = true;
    this.api.post<{ hold: PendingSeatHold; message: string }>(`/fixed/driver/seat-holds/${req.id}/reject`, {})
      .pipe(finalize(() => (this.busy = false)))
      .subscribe({
        next: async (res) => {
          this.ringtone.playRejectChime();
          this.incomingSeatRequests = this.incomingSeatRequests.filter((h) => h.id !== req.id);
          this.activeSeatRequest = this.incomingSeatRequests[0] || null;
          if (this.activeSeatRequest) {
            this.startHoldCountdown();
            this.ringtone.startRinging('fixed-hold-' + this.activeSeatRequest.id);
          } else {
            this.stopHoldCountdown();
          }
          await this.showToast(res.message || 'Seat request declined.');
          if (this.activeVehicle) this.loadManifest(this.activeVehicle.id, false);
        },
        error: (err) => {
          void this.showToast(err?.error?.message || 'Could not decline seat request.');
        },
      });
  }

  /* ─── Circular Progress & Drag to Accept ─── */
  getCircleDashOffset(countdown: number, totalSeconds = 60): number {
    const circumference = 263.89; // 2 * PI * 42
    const validTotal = totalSeconds > 0 ? totalSeconds : 60;
    const remaining = Math.max(0, Math.min(countdown, validTotal));
    // Circle fills as time passes (from 0% at 60s to 100% at 0s)
    const fillRatio = (validTotal - remaining) / validTotal;
    return circumference * (1 - fillRatio);
  }

  dragProgress = 0;
  thumbTranslateX = 0;
  isDragging = false;
  private dragStartX = 0;
  private maxTrackWidth = 0;
  private draggedSeatRequest: PendingSeatHold | null = null;

  onDragStart(event: TouchEvent | PointerEvent, trackEl: HTMLElement): void {
    if (this.busy) return;
    this.isDragging = true;
    this.draggedSeatRequest = this.activeSeatRequest;
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    this.dragStartX = clientX;
    const trackWidth = trackEl.getBoundingClientRect().width;
    const thumbWidth = 56;
    this.maxTrackWidth = Math.max(1, trackWidth - thumbWidth);
  }

  onDragMove(event: TouchEvent | PointerEvent): void {
    if (!this.isDragging || this.maxTrackWidth <= 0) return;
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const deltaX = Math.max(0, Math.min(clientX - this.dragStartX, this.maxTrackWidth));
    this.thumbTranslateX = deltaX;
    this.dragProgress = Math.round((deltaX / this.maxTrackWidth) * 100);
  }

  onDragEnd(): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    const targetRequest = this.draggedSeatRequest || this.activeSeatRequest;
    this.draggedSeatRequest = null;
    if (this.dragProgress >= 80 && targetRequest) {
      this.thumbTranslateX = this.maxTrackWidth;
      this.dragProgress = 100;
      this.acceptSeatRequest(targetRequest);
      setTimeout(() => {
        this.thumbTranslateX = 0;
        this.dragProgress = 0;
      }, 600);
    } else {
      this.thumbTranslateX = 0;
      this.dragProgress = 0;
    }
  }

  onDragCancel(): void {
    this.isDragging = false;
    this.draggedSeatRequest = null;
    this.thumbTranslateX = 0;
    this.dragProgress = 0;
  }

  /* ─── Embedded Map Management ─── */
  ensureEmbeddedMap(forceRefit = false): void {
    if (this.map) {
      if (typeof google !== 'undefined' && google.maps?.event) {
        google.maps.event.trigger(this.map, 'resize');
      }
      this.refreshEmbeddedMap(forceRefit);
      return;
    }
    requestAnimationFrame(() => void this.initEmbeddedMap());
  }

  togglePassengerSheet(): void {
    this.passengerSheetExpanded = !this.passengerSheetExpanded;
  }

  private async initEmbeddedMap(): Promise<void> {
    if (this.map) return;
    try {
      await this.places.ensureLoaded();
      const div = document.getElementById('fixed-driver-embedded-map');
      if (!div) return;
      const firstStop = this.stops.find((stop) => this.hasStopCoords(stop));
      this.map = new google.maps.Map(div, {
        center: firstStop ? this.stopPosition(firstStop) : { lat: 28.6139, lng: 77.209 },
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: false,
        mapId: 'DEMO_MAP_ID',
      });
      this.refreshEmbeddedMap();
      void this.startDriverWatch();
    } catch {
      // Graceful fallback if map API cannot be reached
    }
  }

  private refreshEmbeddedMap(refit = true): void {
    if (!this.map) return;
    this.clearRouteObjects();
    const routeStops = this.stops.filter((stop) => this.hasStopCoords(stop));
    if (!routeStops.length) return;

    // Route line eliminated as requested: driver sees stop points and passenger markers only

    this.stopMarkers = routeStops.map((stop) => {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        position: this.stopPosition(stop),
        map: this.map,
        title: this.nextStopGuide?.id === stop.id ? `Next stop ${stop.seq}: ${stop.name}` : stop.name,
        content: this.buildStopMarker(stop),
        zIndex: this.nextStopGuide?.id === stop.id ? 100 : Number(stop.seq || 0),
      });

      marker.addListener('click', () => {
        this.openStopDetail(stop);
      });

      return marker;
    });

    this.passengerMarkers = this.passengerPointGroups().map((point) => {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        position: point.position,
        map: this.map,
        title: point.title,
        content: this.buildPassengerMarker(point.kind, point.count, point.name, point.isLive, point.avatarUrl, point.distanceText),
        zIndex: point.kind === 'pickup' ? (point.isLive ? 960 : 920) : 850,
      });
      (marker as any).__passenger = point.passenger;
      return marker;
    });
    if (refit) {
      this.fitEmbeddedMap();
    }
  }

  openStopDetail(stop: FixedStop): void {
    const guide = this.stopGuide.find((s) => s.id === stop.id) || {
      ...stop,
      waitingCount: 0,
      boardedCount: 0,
      dropCount: 0,
      completedCount: 0,
      status: 'pending' as const,
    };
    const reachedSeq = this.completedStopSeq;
    const isReached = stop.seq <= reachedSeq;
    const isNext = !isReached && (reachedSeq === 0 ? stop.seq === 1 : stop.seq === reachedSeq + 1);

    const boardingPassengers = this.passengers.filter((p) => {
      const status = (p.status || '').toUpperCase();
      if (['CANCELLED', 'NO_SHOW'].includes(status)) return false;
      return Number(p.board_stop_id) === Number(stop.id);
    });

    const droppingPassengers = this.passengers.filter((p) => {
      const status = (p.status || '').toUpperCase();
      if (['CANCELLED', 'NO_SHOW'].includes(status)) return false;
      return Number(p.drop_stop_id) === Number(stop.id);
    });

    this.selectedStopDetail = {
      stop,
      guide,
      isReached,
      isNext,
      arrivalRadiusM: this.citySettings?.fixed_stop_arrival_radius_m || 150,
      customerPickupRadiusM: this.citySettings?.fixed_customer_pickup_radius_m || 150,
      approachingRadiusM: this.citySettings?.fixed_vehicle_approaching_alert_radius_m || 500,
      waitTimeMin: this.citySettings?.fixed_waiting_time_per_stop_minutes || 5,
      dwellSec: this.citySettings?.fixed_stop_arrival_dwell_seconds || 20,
      customerGraceMin: this.citySettings?.fixed_customer_grace_minutes || 2,
      driverMissedGraceMin: this.citySettings?.fixed_driver_missed_stop_grace_minutes || 3,
      boardingPassengers,
      droppingPassengers,
    };
  }

  closeStopDetail(): void {
    this.selectedStopDetail = null;
  }

  navigateToStop(stop: FixedStop): void {
    if (!stop.lat || !stop.lng) return;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`;
    window.open(url, '_system');
  }

  trackByStopId(_index: number, stop: StopGuide): number {
    return stop.id;
  }

  trackByPassengerId(_index: number, passenger: FixedPassenger): number {
    return passenger.id;
  }

  trackByGroup(_index: number, group: { stop: string }): string {
    return group.stop;
  }

  private async startDriverWatch(): Promise<void> {
    if (this.selfWatchId !== null) return;
    try {
      this.selfWatchId = await this.geo.watchPosition(
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
        (fix, err) => {
          if (err) {
            void this.stopDriverWatch();
            return;
          }
          if (fix) this.onDriverPosition(fix);
        },
      );
    } catch {
      this.selfWatchId = null;
    }
  }

  private async stopDriverWatch(): Promise<void> {
    if (this.selfWatchId !== null) {
      await this.geo.clearWatch(this.selfWatchId);
      this.selfWatchId = null;
    }
  }

  private lastDriverLocationSentAt = 0;

  private onDriverPosition(fix: GeoFix): void {
    const position = { lat: fix.lat, lng: fix.lng };
    this.driverPosition = position;
    if (this.map) {
      if (!this.selfMarker) {
        this.selfMarker = new google.maps.marker.AdvancedMarkerElement({
          position,
          map: this.map,
          title: 'You (Driver)',
          content: this.buildDriverMarker(fix.bearing ?? 0),
          zIndex: 1000,
        });
        this.fitEmbeddedMap();
      } else {
        this.selfMarker.position = position;
        if (fix.bearing != null) {
          updateCarMarkerBearing(this.selfMarker, fix.bearing);
        }
      }
    }

    this.updatePassengerMarkerDistances();
    this.cd.markForCheck();

    // Proactively post GPS location to server (throttled to 4s)
    const now = Date.now();
    if (now - this.lastDriverLocationSentAt >= 4000) {
      this.lastDriverLocationSentAt = now;
      const tripId = this.fixedTripId(this.activeVehicle);
      if (tripId) {
        this.api.post(`/trips/${tripId}/location`, {
          lat: fix.lat,
          lng: fix.lng,
          accuracy_m: fix.accuracy ?? null,
          bearing_deg: fix.bearing ?? null,
          speed_kmh: fix.speed != null ? Math.max(0, fix.speed) * 3.6 : null,
        }).subscribe({ error: () => {} });
      } else {
        this.api.post('/drivers/me/location', {
          lat: fix.lat,
          lng: fix.lng,
          accuracy: fix.accuracy ?? null,
          bearing: fix.bearing ?? null,
          speed: fix.speed != null ? Math.max(0, fix.speed) * 3.6 : null,
        }).subscribe({ error: () => {} });
      }
    }
  }

  private fitEmbeddedMap(): void {
    if (!this.map) return;
    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const marker of [...this.stopMarkers, ...this.passengerMarkers, this.selfMarker]) {
      if (marker?.position) {
        bounds.extend(marker.position as any);
        any = true;
      }
    }
    if (any) this.map.fitBounds(bounds, 40);
  }

  private resetEmbeddedMap(): void {
    this.clearRouteObjects();
    if (this.selfMarker) {
      this.selfMarker.map = null;
      this.selfMarker = null;
    }
    this.map = null;
  }

  private clearRouteObjects(): void {
    if (this.routeLine) {
      this.routeLine.setMap(null);
      this.routeLine = null;
    }
    for (const marker of this.stopMarkers) marker.map = null;
    for (const marker of this.passengerMarkers) marker.map = null;
    this.stopMarkers = [];
    this.passengerMarkers = [];
  }

  private hasStopCoords(stop: FixedStop): boolean {
    return stop.lat != null && stop.lng != null && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng));
  }

  private stopPosition(stop: FixedStop): { lat: number; lng: number } {
    return { lat: Number(stop.lat), lng: Number(stop.lng) };
  }

  passengerDistanceMeters(passenger: FixedPassenger): number | null {
    if (!this.driverPosition) return null;
    const kind = (passenger.status || '').toUpperCase() === 'BOARDED' ? 'drop' : 'pickup';
    const pos = this.passengerPosition(passenger, kind);
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return null;
    return haversineDistanceMeters(this.driverPosition.lat, this.driverPosition.lng, pos.lat, pos.lng);
  }

  passengerDistanceText(passenger: FixedPassenger): string | null {
    const meters = this.passengerDistanceMeters(passenger);
    if (meters == null || isNaN(meters)) return null;
    if (meters < 1000) {
      return `${Math.round(meters)} m`;
    }
    const km = meters / 1000;
    return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  }

  hasCustomerLocation(passenger: FixedPassenger): boolean {
    return hasCustomerLocation(passenger);
  }

  isCustomerLive(passenger: FixedPassenger): boolean {
    return isCustomerLocationLive(passenger);
  }

  get nearestWaitingPassenger(): FixedPassenger | null {
    if (!this.activeVehicle || !this.driverPosition) return null;
    const waiting = this.passengers.filter((p) => {
      const s = (p.status || '').toUpperCase();
      return ['BOOKED', 'CONFIRMED'].includes(s);
    });
    if (!waiting.length) return null;

    let nearest: FixedPassenger | null = null;
    let minDistance = Infinity;

    for (const p of waiting) {
      const d = this.passengerDistanceMeters(p);
      if (d != null && d < minDistance) {
        minDistance = d;
        nearest = p;
      }
    }
    return nearest || waiting[0];
  }

  focusOnPassenger(passenger: FixedPassenger, event?: Event): void {
    if (event) event.stopPropagation();
    const pos = this.passengerPosition(passenger, (passenger.status || '').toUpperCase() === 'BOARDED' ? 'drop' : 'pickup');
    if (pos && this.map) {
      this.map.panTo(pos);
      this.map.setZoom(16);
    }
  }

  private updatePassengerMarkerDistances(): void {
    if (!this.passengerMarkers?.length || !this.driverPosition) return;
    for (const marker of this.passengerMarkers) {
      const p = (marker as any).__passenger as FixedPassenger | undefined;
      if (!p) continue;
      const dist = this.passengerDistanceText(p);
      const pill = marker.content?.querySelector('.person-tag-pill');
      if (!pill) continue;
      let distEl = pill.querySelector('.person-tag-dist');
      if (dist) {
        if (!distEl) {
          distEl = document.createElement('span');
          distEl.className = 'person-tag-dist';
          const liveDot = pill.querySelector('.person-live-dot');
          if (liveDot) {
            pill.insertBefore(distEl, liveDot);
          } else {
            pill.appendChild(distEl);
          }
        }
        distEl.textContent = dist;
        (distEl as HTMLElement).style.display = 'inline-block';
      } else if (distEl) {
        (distEl as HTMLElement).style.display = 'none';
      }
    }
  }

  private passengerPointGroups(): Array<{
    kind: 'pickup' | 'drop';
    count: number;
    title: string;
    name: string;
    isLive: boolean;
    distanceText?: string | null;
    avatarUrl?: string | null;
    position: { lat: number; lng: number };
    passenger: FixedPassenger;
  }> {
    const points: Array<{
      kind: 'pickup' | 'drop';
      count: number;
      title: string;
      name: string;
      isLive: boolean;
      distanceText?: string | null;
      avatarUrl?: string | null;
      position: { lat: number; lng: number };
      passenger: FixedPassenger;
    }> = [];

    for (const passenger of this.passengers) {
      const status = (passenger.status || '').toUpperCase();
      if (['CANCELLED', 'NO_SHOW', 'DROPPED', 'COMPLETED'].includes(status)) continue;

      if (['BOOKED', 'CONFIRMED'].includes(status)) {
        const pickup = this.passengerPosition(passenger, 'pickup');
        if (pickup) {
          const isLive = this.isCustomerLive(passenger);
          const name = passenger.customer_name || 'Passenger';
          const distText = this.passengerDistanceText(passenger);
          points.push({
            kind: 'pickup',
            count: passenger.seats || 1,
            name,
            isLive,
            distanceText: distText,
            avatarUrl: passenger.customer_avatar_url || null,
            title: `${name} (${passenger.seats || 1} seat${(passenger.seats || 1) > 1 ? 's' : ''}) - ${distText ? distText + ' away · ' : ''}${isLive ? 'Live Walking' : this.hasCustomerLocation(passenger) ? 'Last known location' : 'Pickup at ' + (passenger.board || 'stop')}`,
            position: pickup,
            passenger,
          });
        }
      } else if (status === 'BOARDED') {
        const drop = this.passengerPosition(passenger, 'drop');
        if (drop) {
          const name = passenger.customer_name || 'Passenger';
          const distText = this.passengerDistanceText(passenger);
          points.push({
            kind: 'drop',
            count: passenger.seats || 1,
            name,
            isLive: false,
            distanceText: distText,
            avatarUrl: passenger.customer_avatar_url || null,
            title: `${name} - ${distText ? distText + ' away · ' : ''}Drop off at ${passenger.drop || 'destination'}`,
            position: drop,
            passenger,
          });
        }
      }
    }
    return points;
  }

  private passengerPosition(passenger: FixedPassenger, kind: 'pickup' | 'drop'): { lat: number; lng: number } | null {
    if (kind === 'pickup') {
      // 1. Live walking / customer GPS location if available
      if (passenger.customer_lat != null && passenger.customer_lng != null &&
          Number.isFinite(Number(passenger.customer_lat)) && Number.isFinite(Number(passenger.customer_lng))) {
        return { lat: Number(passenger.customer_lat), lng: Number(passenger.customer_lng) };
      }
      // 2. Pickup stop coordinates
      if (passenger.board_lat != null && passenger.board_lng != null &&
          Number.isFinite(Number(passenger.board_lat)) && Number.isFinite(Number(passenger.board_lng))) {
        return { lat: Number(passenger.board_lat), lng: Number(passenger.board_lng) };
      }
      const stopId = passenger.board_stop_id;
      const stop = this.stops.find((item) => Number(item.id) === Number(stopId));
      return stop && this.hasStopCoords(stop) ? this.stopPosition(stop) : null;
    }

    // Drop position
    if (passenger.drop_lat != null && passenger.drop_lng != null &&
        Number.isFinite(Number(passenger.drop_lat)) && Number.isFinite(Number(passenger.drop_lng))) {
      return { lat: Number(passenger.drop_lat), lng: Number(passenger.drop_lng) };
    }
    const dropStopId = passenger.drop_stop_id;
    const dropStop = this.stops.find((item) => Number(item.id) === Number(dropStopId));
    return dropStop && this.hasStopCoords(dropStop) ? this.stopPosition(dropStop) : null;
  }

  private buildPassengerMarker(kind: 'pickup' | 'drop', count: number, name = 'Passenger', isLive = false, avatarUrl?: string | null, distanceText?: string | null): HTMLElement {
    return buildPassengerMarkerElement({ kind, count, name, isLive, avatarUrl, distanceText });
  }

  private buildStopMarker(stop: FixedStop): HTMLElement {
    const reachedSeq = this.completedStopSeq;
    const marker = buildStopMarkerElement({
      seq: stop.seq,
      name: stop.name,
      isNext: this.nextStopGuide?.id === stop.id,
      isReached: Number(stop.seq || 0) <= reachedSeq,
    });
    // The Next Stop card above the map already names the upcoming stop.
    marker.querySelector('.next-stop-marker-label')?.remove();
    return marker;
  }

  private buildDriverMarker(bearing: number): HTMLElement {
    const marker = buildReusableCarMarkerElement({
      bearing,
      markerUrl: this.driverMapMarkerUrl,
    });
    marker.setAttribute('aria-label', 'Your vehicle location');
    return marker;
  }

  /* ─── Route Preview Map Methods (Step 2: Detail View Before Start Ride) ─── */
  ensureRoutePreviewMap(route?: FixedRoute | null, attempt = 1): void {
    const targetRoute = route || this.selectedRoute;
    if (!targetRoute) return;

    if (this.previewMap && this.selectedRouteId === targetRoute.id) {
      if (typeof google !== 'undefined' && google.maps?.event) {
        google.maps.event.trigger(this.previewMap, 'resize');
      }
      this.fitRoutePreviewMap(targetRoute);
      this.previewMapLoading = false;
      return;
    }

    this.previewMapLoading = true;

    const tryInit = async () => {
      if (this.selectedRouteId !== targetRoute.id) return;
      const div = document.getElementById('fixed-route-preview-map');
      if (!div) {
        if (attempt < 20) {
          setTimeout(() => this.ensureRoutePreviewMap(targetRoute, attempt + 1), 60);
        } else {
          this.previewMapLoading = false;
        }
        return;
      }
      await this.initRoutePreviewMap(targetRoute, div);
    };

    setTimeout(() => {
      void tryInit();
    }, attempt === 1 ? 50 : 0);
  }

  private async initRoutePreviewMap(route: FixedRoute, div: HTMLElement): Promise<void> {
    try {
      await this.places.ensureLoaded();
      if (typeof google === 'undefined' || !google.maps) {
        this.previewMapLoading = false;
        return;
      }

      this.destroyRoutePreviewMap(false);

      const validStops = (route.stops || []).filter((s) => this.hasStopCoords(s));
      const originCoord = route.origin_lat != null && route.origin_lng != null
        ? { lat: Number(route.origin_lat), lng: Number(route.origin_lng) }
        : validStops.length > 0 ? this.stopPosition(validStops[0]) : null;

      const defaultCenter = originCoord || { lat: 28.6139, lng: 77.209 };

      this.previewMap = new google.maps.Map(div, {
        center: defaultCenter,
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: false,
        clickableIcons: false,
        gestureHandling: 'greedy',
        mapId: 'DEMO_MAP_ID',
      });

      this.renderRoutePreviewElements(route);
      this.previewMapLoading = false;

      setTimeout(() => {
        if (this.previewMap && typeof google !== 'undefined' && google.maps?.event) {
          google.maps.event.trigger(this.previewMap, 'resize');
          this.fitRoutePreviewMap(route);
        }
      }, 100);

      setTimeout(() => {
        if (this.previewMap && typeof google !== 'undefined' && google.maps?.event) {
          google.maps.event.trigger(this.previewMap, 'resize');
          this.fitRoutePreviewMap(route);
        }
      }, 350);
    } catch (e) {
      console.error('[fixed-driver] Failed to init preview map:', e);
      this.previewMapLoading = false;
    }
  }

  private renderRoutePreviewElements(route: FixedRoute): void {
    if (!this.previewMap) return;

    const stops = route.stops || [];
    const validStops = stops.filter((s) => this.hasStopCoords(s));

    this.previewStopMarkers = validStops.map((stop, index) => {
      const isOrigin = index === 0;
      const isDest = index === validStops.length - 1;
      const pos = this.stopPosition(stop);

      try {
        if (typeof google !== 'undefined' && google.maps?.marker?.AdvancedMarkerElement) {
          const marker = new google.maps.marker.AdvancedMarkerElement({
            position: pos,
            map: this.previewMap,
            title: `Stop ${stop.seq}: ${stop.name}`,
            content: this.buildRoutePreviewStopMarker(stop),
            zIndex: isOrigin ? 200 : isDest ? 190 : 100 + Number(stop.seq || 0),
          });

          marker.addListener('click', () => {
            this.onPreviewStopTap(stop);
          });

          return marker;
        }
      } catch (err) {
        console.warn('AdvancedMarkerElement failed, fallback to standard Marker', err);
      }

      // Fallback standard Marker
      const fallbackMarker = new google.maps.Marker({
        position: pos,
        map: this.previewMap,
        title: `Stop ${stop.seq}: ${stop.name}`,
      });
      fallbackMarker.addListener('click', () => {
        this.onPreviewStopTap(stop);
      });
      return fallbackMarker;
    });

    void this.fitRoutePreviewMap(route);
  }

  togglePreviewFullscreen(): void {
    this.previewMapFullscreen = !this.previewMapFullscreen;
    const triggerResize = () => {
      if (this.previewMap && typeof google !== 'undefined' && google.maps?.event) {
        google.maps.event.trigger(this.previewMap, 'resize');
        if (this.selectedRoute) {
          this.fitRoutePreviewMap(this.selectedRoute);
        }
      }
    };
    setTimeout(triggerResize, 60);
    setTimeout(triggerResize, 200);
    setTimeout(triggerResize, 450);
  }

  closePreviewFullscreen(): void {
    if (this.previewMapFullscreen) {
      this.previewMapFullscreen = false;
      const triggerResize = () => {
        if (this.previewMap && typeof google !== 'undefined' && google.maps?.event) {
          google.maps.event.trigger(this.previewMap, 'resize');
          if (this.selectedRoute) {
            this.fitRoutePreviewMap(this.selectedRoute);
          }
        }
      };
      setTimeout(triggerResize, 60);
      setTimeout(triggerResize, 200);
      setTimeout(triggerResize, 450);
    }
  }

  onPreviewStopTap(stop: FixedStop): void {
    if (this.selectedPreviewStop?.id === stop.id) {
      this.clearSelectedPreviewStop();
      return;
    }

    this.selectedPreviewStop = stop;
    this.updatePreviewMarkersSelection(stop.id);

    if (this.previewMap && this.hasStopCoords(stop)) {
      this.previewMap.panTo(this.stopPosition(stop));
      this.previewMap.setZoom(15);
    }
  }

  clearSelectedPreviewStop(): void {
    this.selectedPreviewStop = null;
    this.updatePreviewMarkersSelection(null);
  }

  private updatePreviewMarkersSelection(selectedStopId: number | null): void {
    for (const marker of this.previewStopMarkers) {
      const content = marker.content as HTMLElement;
      if (!content) continue;
      const idAttr = content.getAttribute('data-stop-id');
      if (selectedStopId != null && idAttr && Number(idAttr) === Number(selectedStopId)) {
        content.classList.add('is-selected');
        marker.zIndex = 9999;
      } else {
        content.classList.remove('is-selected');
        marker.zIndex = 100;
      }
    }
  }

  recenterPreviewMap(): void {
    this.clearSelectedPreviewStop();
    if (this.selectedRoute) {
      this.fitRoutePreviewMap(this.selectedRoute);
    }
  }

  private fitRoutePreviewMap(route: FixedRoute): void {
    if (!this.previewMap) return;
    const bounds = new google.maps.LatLngBounds();
    let hasCoords = false;

    if (route.origin_lat != null && route.origin_lng != null) {
      bounds.extend({ lat: Number(route.origin_lat), lng: Number(route.origin_lng) });
      hasCoords = true;
    }

    if (route.dest_lat != null && route.dest_lng != null) {
      bounds.extend({ lat: Number(route.dest_lat), lng: Number(route.dest_lng) });
      hasCoords = true;
    }

    for (const marker of this.previewStopMarkers) {
      if (marker?.position) {
        bounds.extend(marker.position as any);
        hasCoords = true;
      }
    }

    if (hasCoords) {
      const padding = this.previewMapFullscreen
        ? { top: 80, right: 45, bottom: 80, left: 45 }
        : { top: 40, right: 30, bottom: 40, left: 30 };
      this.previewMap.fitBounds(bounds, padding);
    }
  }

  private buildRoutePreviewStopMarker(stop: FixedStop): HTMLElement {
    const el = document.createElement('div');
    el.className = 'fixed-preview-stop-marker';
    el.setAttribute('data-stop-id', String(stop.id));

    el.innerHTML = `
      <div class="preview-stop-name-tag">
        <span class="tag-badge">Stop ${stop.seq}</span>
        <span class="tag-name">${this.escapeHtml(stop.name)}</span>
      </div>
      <div class="preview-stop-pin" style="--pin-color: #12B35B">
        <span class="preview-stop-seq">${stop.seq}</span>
      </div>
    `;
    return el;
  }

  private escapeHtml(str: string): string {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private destroyRoutePreviewMap(resetFullscreen = true): void {
    if (resetFullscreen) {
      this.previewMapFullscreen = false;
    }
    for (const m of this.previewStopMarkers) {
      if (m) {
        if (typeof m.setMap === 'function') {
          m.setMap(null);
        } else {
          m.map = null;
        }
      }
    }
    this.previewStopMarkers = [];
    this.previewMap = null;
    this.selectedPreviewStop = null;
  }
}
