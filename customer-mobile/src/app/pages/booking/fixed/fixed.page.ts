import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { interval, Subscription } from 'rxjs';

import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { GeolocationService } from '../../../core/geolocation.service';
import { FixedCustomerLocationService } from '../../../core/fixed-customer-location.service';
import { PaymentOptionsService } from '../../../core/payment-options.service';
import { RealtimeService } from '../../../core/realtime.service';
import { AudioAlertService } from '../../../core/audio-alert.service';
import { PaymentChoice } from '../../../shared/payment-method-modal.component';
import { BookingService, resolveCity } from '../booking.service';
import { City } from '../booking.models';

import { SeatCell } from './seat-grid.component';

declare const Razorpay: any;

interface FixedStop {
  id: number; seq: number; name: string;
  lat?: number; lng?: number;
  is_pickup: boolean; is_drop: boolean;
  is_active: boolean; is_temporarily_unavailable: boolean;
  distance_meters?: number | null;
  walk_minutes?: number | null;
  is_nearest_pickup?: boolean;
}
interface FixedRoute {
  image_url?: string | null;
  id: number; name: string; scope: 'local' | 'outstation';
  origin_name: string; dest_name: string;
  flat_fare: number; luggage_surcharge_amount: number;
  stops: FixedStop[];
  starting_stop?: FixedStop | null;
  distance_to_start?: number | null;
  nearest_pickup_stop?: {
    id: number;
    name: string;
    seq: number;
    lat: number;
    lng: number;
    distance_meters: number;
    walk_minutes: number;
  } | null;
  distance_to_nearest_pickup?: number | null;
}
interface FixedDeparture {
  image_url?: string | null;
  id: number; depart_at: string | null; announced_depart_at: string | null;
  seats_remaining: number; luggage_remaining: number; status: string;
  vehicle_name?: string | null;
}
interface SeatMapResponse {
  layout: { rows: number; cols: number };
  cells: SeatCell[];
}
interface SeatHold {
  id: number;
  seats: number;
  amount: number;
  status?: string;
  expires_at?: string | null;
  seat_labels?: string[];
  board_stop_id?: number | null;
  drop_stop_id?: number | null;
  route_id?: number;
  route_name?: string | null;
  board_stop_name?: string | null;
  drop_stop_name?: string | null;
  original_amount?: number;
  discount_amount?: number;
  extra_luggage_count?: number;
  luggage_surcharge_amount?: number;
  coupon_title?: string | null;
  coupon_editable?: boolean;
}
interface CouponPreview { base_amount: number; discount: number; final_amount: number; coupon?: { title: string } | null; }
interface Reservation { id: number; }

type Step = 'route' | 'departure' | 'details' | 'seats' | 'awaiting_approval' | 'review' | 'done';

/**
 * "Share a seat" — the Fixed flow on the shared shell.
 *
 * Route → departure → board/drop + luggage → seats → driver approval → review/pay → ticket.
 * Every step wears the same StepShell as Book-a-car.
 */
@Component({
  selector: 'app-fixed-book',
  templateUrl: './fixed.page.html',
  styleUrls: ['./fixed.page.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FixedBookPage implements OnInit, OnDestroy {
  step: Step = 'route';
  readonly total = 5;

  cityId: number | null = null;
  cities: City[] = [];
  selectedCity: City | null = null;
  search = '';
  searchMode: 'destination' | 'origin' | 'stop' = 'destination';
  get searchPlaceholder(): string {
    return `Search by ${this.searchMode}`;
  }
  private searchTimer?: ReturnType<typeof setTimeout>;
  private routesSub?: Subscription;
  private routesRequestId = 0;
  private locationSub?: Subscription;
  locationAccuracy: number | null = null;
  locating = false;
  locationMessage = '';
  radiusFilterActive = true;
  routeScope: 'all' | 'local' | 'outstation' = 'all';

  get scopedRoutes(): FixedRoute[] {
    return this.routeScope === 'all' ? this.routes : this.routes.filter(route => route.scope === this.routeScope);
  }

  setRouteScope(scope: 'all' | 'local' | 'outstation'): void {
    this.routeScope = scope;
    this.cdr.markForCheck();
  }

  get nearbyRoutesCount(): number {
    if (!this.userCoords) return this.scopedRoutes.length;
    return this.scopedRoutes.filter(
      (r) => r.distance_to_start != null && r.distance_to_start <= 1000,
    ).length;
  }

  get selectedCityName(): string {
    return this.selectedCity?.name || (this.cityId ? `City #${this.cityId}` : 'All Cities');
  }

  routes: FixedRoute[] = [];
  route: FixedRoute | null = null;

  departures: FixedDeparture[] = [];
  departure: FixedDeparture | null = null;

  boardStopId: number | null = null;
  dropStopId: number | null = null;
  luggage = 0;

  seatMap: SeatMapResponse | null = null;
  selected: string[] = [];

  couponTitle = '';
  coupon: CouponPreview | null = null;
  couponError: string | null = null;
  couponBusy = false;
  couponEditorOpen = false;
  cancellingHold = false;

  paymentMethod: 'gpay' | 'all' = 'gpay';

  // Driver approval & active hold state
  hold: SeatHold | null = null;
  approvalCountdown = 60;
  private approvalTimerSub?: Subscription;
  private approvalPollSub?: Subscription;
  private unsubscribeHoldChannel: (() => void) | null = null;
  private unsubscribeCustomerHoldChannel: (() => void) | null = null;
  private isCheckingTimeout = false;
  approvalStatusMessage = '';
  private nextApprovalCheckAt = 0;

  // Payment method chooser (Online / UPI / Cash). Cash pays only the upfront
  // deposit online; the rest is cash to the driver at drop-off.
  paymentModalOpen = false;
  payMethod: PaymentChoice = 'online';
  cashDepositPercent = 0;

  reservation: Reservation | null = null;
  boardingCode = '';

  userCoords: { lat: number; lng: number } | null = null;
  nearestPickupStop: FixedStop | null = null;

  loading = false;
  busy = false;
  error: string | null = null;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private booking: BookingService,
    private router: Router,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private cdr: ChangeDetectorRef,
    private paymentOptions: PaymentOptionsService,
    private geo: GeolocationService,
    private fixedLocation: FixedCustomerLocationService,
    private realtime: RealtimeService,
    private audioAlert: AudioAlertService,
    private activatedRoute: ActivatedRoute,
  ) {}

  private requestedHomeRouteId: number | null = null;

  ionViewWillEnter(): void {
    const id = Number(this.activatedRoute.snapshot.queryParamMap.get('routeId'));
    this.requestedHomeRouteId = Number.isSafeInteger(id) && id > 0 ? id : null;
    if (!this.loading && this.routes.length) this.openRequestedHomeRoute();
  }

  private openRequestedHomeRoute(): void {
    if (!this.requestedHomeRouteId) return;
    const id = this.requestedHomeRouteId;
    this.requestedHomeRouteId = null;
    // An existing seat hold keeps priority over starting another booking.
    if (this.hold) return;
    const route = this.routes.find(item => item.id === id);
    if (route) this.pickRoute(route);
    else this.error = 'This route is no longer available here. Please choose another route.';
  }

  async ngOnInit(): Promise<void> {
    this.cityId = this.booking.trip.cityId;
    this.locationSub = this.fixedLocation.fix$.subscribe(fix => {
      if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
      const firstFix = !this.userCoords;
      this.userCoords = { lat: fix.lat, lng: fix.lng };
      this.locationAccuracy = fix.accuracy;
      this.locationMessage = '';
      this.annotateRoutesWithProximity();
      this.sortRoutesByProximity();
      this.recalculateNearbyStops();
      // Fetch the closest server results too, rather than only sorting the initial unlocated catalogue.
      if (firstFix && this.cities.length) this.loadRoutes();
      this.cdr.markForCheck();
    });
    void this.fixedLocation.start();
    void this.initUserLocation();
    await this.loadCities();
    this.loadRoutes();
    this.checkActiveHold();
    // Know the operator's cash deposit split so the ticket can show it.
    void this.paymentOptions.load().then((m) => {
      this.cashDepositPercent = m.cash_deposit_percent || 0;
      this.cdr.markForCheck();
    });
  }

  private async initUserLocation(): Promise<void> {
    this.locating = true;
    this.locationMessage = '';
    this.cdr.markForCheck();
    try {
      const pos = await this.geo.getCurrentPosition();
      if (pos?.lat != null && pos?.lng != null) {
        // A watch may already have delivered a newer fix while this request was pending.
        if (!this.userCoords) this.userCoords = { lat: pos.lat, lng: pos.lng };
        if (this.cityId == null && this.cities.length) {
          const resolved = resolveCity(this.cities, pos.lat, pos.lng);
          if (resolved) {
            this.cityId = resolved.id;
            this.selectedCity = resolved;
            this.booking.setCity(resolved.id);
          }
        }
        this.recalculateNearbyStops();
        this.annotateRoutesWithProximity();
        this.sortRoutesByProximity();
        if (!this.loading && this.routes.length) {
          this.loadRoutes();
        }
        this.cdr.markForCheck();
      }
    } catch {
      // Permission denied or browser location fallback
    } finally {
      this.locating = false;
      if (!this.userCoords) this.locationMessage = 'Could not get your location. Allow location access in your browser or phone settings, then try again.';
      this.cdr.markForCheck();
    }
  }

  async refreshLocation(): Promise<void> {
    if (this.locating) return;
    this.locating = true;
    this.locationMessage = '';
    this.cdr.markForCheck();
    // An explicit retry must replace a previous reading, while the background watch stays active.
    const fix = await this.geo.getCurrentFix();
    this.locating = false;
    if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng)) {
      this.userCoords = { lat: fix.lat, lng: fix.lng };
      this.locationAccuracy = fix.accuracy;
      this.locationMessage = '';
      this.annotateRoutesWithProximity();
      this.sortRoutesByProximity();
      this.recalculateNearbyStops();
      this.loadRoutes();
      this.cdr.markForCheck();
      return;
    }
    this.locationMessage = 'Could not get a fresh location. Allow location access in your browser or phone settings, then try again.';
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.stopApprovalWaiting();
    clearTimeout(this.searchTimer);
    this.routesSub?.unsubscribe();
    this.locationSub?.unsubscribe();
  }

  async loadCities(): Promise<void> {
    try {
      this.cities = await this.booking.cities().catch(() => [] as City[]);
      if (this.cityId != null && this.cityId > 0) {
        this.selectedCity = this.cities.find((c) => c.id === this.cityId) || null;
      } else if (this.userCoords) {
        const resolved = resolveCity(this.cities, this.userCoords.lat, this.userCoords.lng);
        if (resolved) {
          this.cityId = resolved.id;
          this.selectedCity = resolved;
          this.booking.setCity(resolved.id);
        }
      } else {
        this.selectedCity = null;
      }
      this.cdr.markForCheck();
    } catch {
      this.cities = [];
    }
  }

  cityModalOpen = false;

  openCityFilter(): void {
    if (!this.cities.length) {
      void this.loadCities();
    }
    this.cityModalOpen = true;
    this.cdr.markForCheck();
  }

  onCityModalSelect(cityId: number | null): void {
    this.cityModalOpen = false;
    this.selectCity(cityId);
  }

  onCityModalDismiss(): void {
    this.cityModalOpen = false;
    this.cdr.markForCheck();
  }

  selectCity(cityId: number | null): void {
    this.cityId = cityId;
    this.booking.setCity(cityId);
    this.selectedCity = cityId ? (this.cities.find((c) => c.id === cityId) || null) : null;
    this.route = null;
    this.departure = null;
    this.boardStopId = null;
    this.dropStopId = null;
    this.search = '';
    this.radiusFilterActive = true;
    this.loadRoutes();
    this.cdr.markForCheck();
  }

  // ---- shell inputs -----------------------------------------------------

  get stepIndex(): number {
    return { route: 1, departure: 2, details: 3, seats: 4, awaiting_approval: 4, review: 5, done: 5 }[this.step];
  }

  // ---- step 1: route ----------------------------------------------------

  retryRoutes(): void {
    this.loadRoutes();
  }

  private loadRoutes(): void {
    clearTimeout(this.searchTimer);
    this.routesSub?.unsubscribe();
    const requestId = ++this.routesRequestId;
    this.loading = true;
    this.error = null;
    const params = new URLSearchParams();
    if (this.search.trim()) {
      params.set('q', this.search.trim());
      params.set('search_by', this.searchMode);
    }
    if (this.routeScope !== 'all') params.set('scope', this.routeScope);
    if (this.cityId != null && this.cityId > 0) {
      params.set('city_id', String(this.cityId));
    }
    if (this.userCoords) {
      params.set('lat', String(this.userCoords.lat));
      params.set('lng', String(this.userCoords.lng));
    }
    const qStr = params.toString() ? '?' + params.toString() : '';
    this.routesSub = this.api.get<{ data: FixedRoute[] }>('/fixed/routes' + qStr).subscribe({
      next: (res) => {
        if (requestId !== this.routesRequestId) return;
        this.routes = res?.data ?? [];
        this.annotateRoutesWithProximity();
        this.sortRoutesByProximity();
        this.loading = false;
        this.openRequestedHomeRoute();
        this.cdr.markForCheck();
      },
      error: () => {
        if (requestId !== this.routesRequestId) return;
        this.routes = []; this.loading = false;
        this.error = 'Could not load routes. Please try again.';
        this.cdr.markForCheck();
      },
    });
  }

  private sortRoutesByProximity(): void {
    this.routes.sort((a, b) => {
      const distA = a.distance_to_start ?? Infinity;
      const distB = b.distance_to_start ?? Infinity;
      return distA - distB;
    });
  }

  calculateDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }

  formatDistance(meters?: number | null): string {
    if (meters == null || isNaN(meters)) return '';
    if (meters < 1000) return `${meters} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  getWalkMinutes(meters?: number | null): number {
    if (meters == null || isNaN(meters)) return 0;
    return Math.max(1, Math.round(meters / 75));
  }

  private annotateRoutesWithProximity(): void {
    for (const r of this.routes) {
      // Select by route order, never by proximity or a later stop's availability.
      r.starting_stop = r.stops?.length
        ? r.stops.reduce((first, stop) => stop.seq < first.seq ? stop : first)
        : null;
      r.distance_to_start = null;
      if (!this.userCoords) continue;
      r.nearest_pickup_stop = null;
      r.distance_to_nearest_pickup = null;
      for (const stop of r.stops || []) stop.is_nearest_pickup = false;
      if (!r.stops?.length) continue;
      let minD = Infinity;
      let nearest: any = null;
      for (const s of r.stops) {
        s.distance_meters = null;
        s.walk_minutes = null;
        if (s.lat != null && s.lng != null && s.lat !== 0 && s.lng !== 0) {
          const d = this.calculateDistanceMeters(this.userCoords.lat, this.userCoords.lng, s.lat, s.lng);
          s.distance_meters = d;
          s.walk_minutes = this.getWalkMinutes(d);
          if (s.is_pickup && s.is_active && !s.is_temporarily_unavailable && d < minD) {
            minD = d;
            nearest = {
              id: s.id,
              name: s.name,
              seq: s.seq,
              lat: s.lat,
              lng: s.lng,
              distance_meters: d,
              walk_minutes: s.walk_minutes,
            };
          }
        }
      }
      r.distance_to_start = r.starting_stop?.distance_meters ?? null;
      if (nearest) {
        r.nearest_pickup_stop = nearest;
        r.distance_to_nearest_pickup = minD;
        for (const s of r.stops) {
          s.is_nearest_pickup = s.id === nearest.id;
        }
      }
    }
  }

  recalculateNearbyStops(): void {
    if (!this.route?.stops?.length) return;
    let minD = Infinity;
    let bestStop: FixedStop | null = null;

    for (const s of this.route.stops) {
      if (this.userCoords && s.lat != null && s.lng != null && s.lat !== 0 && s.lng !== 0) {
        const d = this.calculateDistanceMeters(this.userCoords.lat, this.userCoords.lng, s.lat, s.lng);
        s.distance_meters = d;
        s.walk_minutes = this.getWalkMinutes(d);
        if (s.is_pickup && s.is_active && !s.is_temporarily_unavailable && d < minD) {
          minD = d;
          bestStop = s;
        }
      } else if (s.is_nearest_pickup && (!bestStop || (s.distance_meters != null && s.distance_meters < minD))) {
        bestStop = s;
        if (s.distance_meters != null) minD = s.distance_meters;
      }
    }

    for (const s of this.route.stops) {
      s.is_nearest_pickup = bestStop ? s.id === bestStop.id : false;
    }

    this.nearestPickupStop = bestStop;
  }

  get isNearestStopFar(): boolean {
    return !!(this.nearestPickupStop?.distance_meters && this.nearestPickupStop.distance_meters > 3000);
  }

  get visibleRoutes(): FixedRoute[] {
    const q = this.search.trim().toLowerCase();
    if (q) return this.scopedRoutes;

    // Nearby routes must start within 1 km of the customer.
    if (this.radiusFilterActive && this.userCoords) {
      return this.scopedRoutes.filter(
        (r) => r.distance_to_start != null && r.distance_to_start <= 1000,
      );
    }

    return this.scopedRoutes;
  }

  setRadiusFilter(active: boolean): void {
    this.radiusFilterActive = active;
    this.cdr.markForCheck();
  }

  onSearchChange(value: string): void {
    this.search = value;
    this.routesSub?.unsubscribe();
    ++this.routesRequestId;
    clearTimeout(this.searchTimer);
    this.routes = [];
    this.loading = true;
    this.searchTimer = setTimeout(() => this.loadRoutes(), 300);
    this.cdr.markForCheck();
  }

  onSearchModeChange(): void {
    if (!this.search.trim()) return;
    this.routesSub?.unsubscribe();
    ++this.routesRequestId;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.loadRoutes(), 300);
    this.cdr.markForCheck();
  }

  clearSearch(): void {
    this.search = '';
    this.loadRoutes();
    this.cdr.markForCheck();
  }

  pickRoute(route: FixedRoute): void {
    this.route = route;
    this.boardStopId = null;
    this.dropStopId = null;
    this.selected = [];
    this.recalculateNearbyStops();
    this.step = 'departure';
    this.loadDepartures(route);
    this.cdr.markForCheck();
  }

  // ---- step 2: departure -----------------------------------------------

  private loadDepartures(route: FixedRoute): void {
    this.loading = true;
    this.api.get<{ data: FixedDeparture[] }>(`/fixed/routes/${route.id}/departures`).subscribe({
      next: (res) => { this.departures = res?.data ?? []; this.loading = false; this.cdr.markForCheck(); },
      error: () => { this.departures = []; this.loading = false; this.cdr.markForCheck(); },
    });
  }

  departLabel(d: FixedDeparture): string {
    const t = d.announced_depart_at || d.depart_at;
    if (!t) return 'Boarding now';
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return 'Scheduled'; }
  }

  pickDeparture(d: FixedDeparture): void {
    this.departure = d;
    this.step = 'details';
    this.recalculateNearbyStops();
    if (!this.boardStopId && this.nearestPickupStop) {
      this.boardStopId = this.nearestPickupStop.id;
    }
    this.cdr.markForCheck();
  }

  // ---- step 3: stops + luggage -----------------------------------------

  get boardStops(): FixedStop[] {
    return (this.route?.stops ?? []).filter((s) => s.is_pickup && s.is_active && !s.is_temporarily_unavailable);
  }
  get dropStops(): FixedStop[] {
    const board = this.route?.stops.find((s) => s.id === this.boardStopId);
    return (this.route?.stops ?? []).filter((s) =>
      s.is_drop && s.is_active && !s.is_temporarily_unavailable && (!board || s.seq > board.seq));
  }

  getStopName(id: number | null): string {
    return this.route?.stops?.find((s) => s.id === id)?.name
      || (id === this.hold?.board_stop_id ? this.hold?.board_stop_name : null)
      || (id === this.hold?.drop_stop_id ? this.hold?.drop_stop_name : null)
      || 'Stop';
  }

  pickBoard(id: number): void {
    this.boardStopId = id;
    // A drop earlier than the new board makes no sense — clear it.
    const board = this.route?.stops.find((s) => s.id === id);
    const drop = this.route?.stops.find((s) => s.id === this.dropStopId);
    if (board && drop && drop.seq <= board.seq) this.dropStopId = null;
    this.cdr.markForCheck();
  }
  pickDrop(id: number): void { this.dropStopId = id; this.cdr.markForCheck(); }

  get luggageMax(): number {
    return Math.max(0, this.departure?.luggage_remaining ?? 0);
  }
  addLuggage(n: number): void {
    this.luggage = Math.min(this.luggageMax, Math.max(0, this.luggage + n));
    this.coupon = null;
    this.cdr.markForCheck();
  }

  get detailsReady(): boolean {
    return !!this.boardStopId && !!this.dropStopId;
  }

  goToSeats(): void {
    this.step = 'seats';
    this.loadSeatMap();
    this.cdr.markForCheck();
  }

  // ---- step 4: seats ----------------------------------------------------

  private loadSeatMap(): void {
    if (!this.departure) return;
    this.loading = true;
    this.error = null;
    this.api.get<SeatMapResponse>(`/fixed/departures/${this.departure.id}/seat-map`).subscribe({
      next: (res) => {
        this.seatMap = res;
        // Drop any seats that were grabbed by someone else since we last looked.
        this.selected = this.selected.filter((l) => res.cells.some((c) => c.label === l && c.status === 'AVAILABLE'));
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => { this.seatMap = null; this.error = err?.error?.message || 'Could not load seats.'; this.loading = false; this.cdr.markForCheck(); },
    });
  }

  get maxSeats(): number {
    return Math.max(1, this.departure?.seats_remaining ?? 1);
  }

  /** The seat grid emits a label; toggle it in/out of the selection. */
  toggleLabel(label: string): void {
    const i = this.selected.indexOf(label);
    if (i >= 0) {
      this.selected = this.selected.filter((_, idx) => idx !== i);
    } else {
      if (this.selected.length >= this.maxSeats) {
        void this.toast(`You can pick up to ${this.maxSeats} seat${this.maxSeats > 1 ? 's' : ''}.`, 'danger');
        return;
      }
      this.selected = [...this.selected, label];
    }
    this.coupon = null;
    this.cdr.markForCheck();
  }

  /** Re-pull the map so seats others just booked show as taken. */
  refreshSeats(): void {
    this.loadSeatMap();
  }

  /** Does this departure actually have seats to pick? */
  get hasSeats(): boolean {
    return (this.seatMap?.cells ?? []).some((c) => c.kind === 'seat');
  }

  /** How many are still free — shown so the rider knows what's left. */
  get seatsFree(): number {
    return (this.seatMap?.cells ?? []).filter((c) => c.kind === 'seat' && c.status === 'AVAILABLE').length;
  }

  /** Book Seats: requests hold and triggers driver accept/reject workflow. */
  bookSeats(): void {
    if (this.busy || !this.selected.length) return;
    this.requestSeatHold('online');
  }

  private requestSeatHold(method: PaymentChoice = 'online'): void {
    if (this.busy || !this.selected.length) return;
    this.busy = true;
    this.error = null;
    this.hold = null;
    this.cdr.markForCheck();

    const payload = { ...this.payload(false), payment_method: method === 'cash' ? 'cash' : 'razorpay' };
    this.api.post<{ hold: SeatHold }>('/fixed/seat-holds', payload, { 'Idempotency-Key': this.uuid() }).subscribe({
      next: (res) => {
        this.busy = false;
        this.hold = res?.hold ?? null;
        if (!this.hold) {
          void this.toast('Could not hold seats. Try again.', 'danger');
          this.cdr.markForCheck();
          return;
        }

        if (this.hold.status === 'PENDING_DRIVER_APPROVAL') {
          this.step = 'awaiting_approval';
          this.startApprovalWaiting(this.hold);
        } else if (this.hold.status === 'ACCEPTED' || this.hold.status === 'HELD') {
          this.step = 'review';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.busy = false;
        void this.toast(err?.error?.message || 'Could not hold seats.', 'danger');
        this.cdr.markForCheck();
      },
    });
  }

  checkActiveHold(): void {
    this.api.get<{ hold: SeatHold | null }>('/fixed/active-hold').subscribe({
      next: (res) => {
        const active = res?.hold;
        if (!active) return;
        const now = Date.now();
        const expiresAt = active.expires_at ? new Date(active.expires_at).getTime() : 0;
        if (expiresAt <= now) return;

        this.hold = active;
        this.luggage = active.extra_luggage_count ?? 0;
        if (active.board_stop_id) this.boardStopId = active.board_stop_id;
        if (active.drop_stop_id) this.dropStopId = active.drop_stop_id;
        if (active.seat_labels && active.seat_labels.length) {
          this.selected = active.seat_labels;
        }

        if (active.status === 'PENDING_DRIVER_APPROVAL') {
          this.step = 'awaiting_approval';
          this.startApprovalWaiting(active);
        } else if (active.status === 'ACCEPTED' || active.status === 'HELD') {
          this.step = 'review';
        }
        this.cdr.markForCheck();
      },
      error: () => {},
    });
  }

  private startApprovalWaiting(hold: SeatHold): void {
    this.stopApprovalWaiting();
    this.updateApprovalCountdown();

    this.approvalTimerSub = interval(1000).subscribe(() => {
      this.updateApprovalCountdown();
    });

    this.unsubscribeHoldChannel = this.realtime.subscribeFixedHold(
      hold.id,
      (payload) => this.onHoldAccepted(payload),
      (payload) => this.onHoldRejected(payload),
    );

    const user = this.auth.getUser();
    if (user?.id) {
      this.unsubscribeCustomerHoldChannel = this.realtime.subscribeCustomerFixedHoldEvents(
        user.id,
        (payload) => {
          if (payload.hold_id === this.hold?.id) {
            this.onHoldAccepted(payload);
          }
        },
        (payload) => {
          if (payload.hold_id === this.hold?.id) {
            this.onHoldRejected(payload);
          }
        },
      );
    }

    this.approvalPollSub = interval(2500).subscribe(() => {
      if (!this.hold) return;
      this.api.get<{ hold: SeatHold }>(`/fixed/seat-holds/${this.hold.id}`).subscribe({
        next: (res) => {
          const h = res?.hold;
          if (!h) return;
          if (h.status === 'ACCEPTED') {
            this.onHoldAccepted(h);
          } else if (h.status === 'REJECTED') {
            this.onHoldRejected(h);
          }
        },
        error: () => {},
      });
    });
  }

  private onHoldAccepted(payload: any): void {
    if (this.step !== 'awaiting_approval') return;
    this.stopApprovalWaiting();
    this.audioAlert.playDriverAccepted();
    if (this.hold) {
      this.hold.status = 'ACCEPTED';
      if (payload.expires_at) this.hold.expires_at = payload.expires_at;
    }
    this.step = 'review';
    void this.toast('Driver accepted your request! Please complete payment within 5 minutes.', 'success');
    this.cdr.markForCheck();
  }

  private async onHoldRejected(payload?: any): Promise<void> {
    if (this.step !== 'awaiting_approval') return;
    this.stopApprovalWaiting();
    this.audioAlert.playDriverDeclined();
    this.hold = null;
    this.step = 'seats';
    this.loadSeatMap();
    const alert = await this.alertCtrl.create({
      header: 'Request Declined',
      message: 'The driver is unable to accept passenger requests at this stop. Your seats have been released at ₹0 charge.',
      buttons: ['OK'],
    });
    await alert.present();
    this.cdr.markForCheck();
  }

  getCircleDashOffset(countdown: number, totalSeconds = 60): number {
    const circumference = 263.89; // 2 * PI * 42
    const validTotal = totalSeconds > 0 ? totalSeconds : 60;
    const remaining = Math.max(0, Math.min(countdown, validTotal));
    // Circle fills as time passes (0% at 60s to 100% at 0s)
    const fillRatio = (validTotal - remaining) / validTotal;
    return circumference * (1 - fillRatio);
  }

  private updateApprovalCountdown(): void {
    if (!this.hold?.expires_at) {
      this.approvalCountdown = 60;
      this.cdr.markForCheck();
      return;
    }
    const diff = Math.floor((new Date(this.hold.expires_at).getTime() - Date.now()) / 1000);
    if (diff <= 0) {
      this.approvalCountdown = 0;
      if (!this.isCheckingTimeout) {
        void this.handleApprovalTimeout();
      }
    } else {
      this.approvalCountdown = diff;
    }
    this.cdr.markForCheck();
  }

  private async handleApprovalTimeout(): Promise<void> {
    if (this.isCheckingTimeout || Date.now() < this.nextApprovalCheckAt || this.step !== 'awaiting_approval' || !this.hold) {
      return;
    }
    this.isCheckingTimeout = true;
    this.nextApprovalCheckAt = Date.now() + 5000;
    const targetHoldId = this.hold.id;

    try {
      const res = await this.api.get<{ hold?: SeatHold }>(`/fixed/seat-holds/${targetHoldId}`).toPromise();
      if (this.step !== 'awaiting_approval' || this.hold?.id !== targetHoldId) {
        return;
      }
      const h = res?.hold;
      if (!h || h.id !== targetHoldId) throw new Error('Hold status unavailable');
      this.approvalStatusMessage = '';
      if (h?.status === 'ACCEPTED') {
        this.onHoldAccepted(h);
        this.cdr.markForCheck();
        return;
      }
      if (h?.status === 'REJECTED') {
        this.onHoldRejected(h);
        this.cdr.markForCheck();
        return;
      }
      if (h?.status === 'PENDING_DRIVER_APPROVAL' && h.expires_at) {
        const remaining = Math.floor((new Date(h.expires_at).getTime() - Date.now()) / 1000);
        if (remaining > 0) {
          this.hold.expires_at = h.expires_at;
          this.approvalCountdown = remaining;
          this.cdr.markForCheck();
          return;
        }
      }
      if (h.status !== 'EXPIRED') {
        this.approvalStatusMessage = 'Confirming your request status. Retrying automatically.';
        this.cdr.markForCheck();
        return;
      }
    } catch {
      if (this.step !== 'awaiting_approval' || this.hold?.id !== targetHoldId) {
        return;
      }
      this.approvalStatusMessage = 'Unable to check your request. Reconnecting automatically.';
      this.cdr.markForCheck();
      return;
    } finally {
      this.isCheckingTimeout = false;
    }

    if (this.step !== 'awaiting_approval' || this.hold?.id !== targetHoldId) {
      return;
    }

    this.stopApprovalWaiting();
    this.hold = null;
    this.step = 'seats';
    this.loadSeatMap();
    const alert = await this.alertCtrl.create({
      header: 'Driver Unavailable',
      message: 'The driver did not respond within the allocated time. Your seat hold has expired at ₹0 charge.',
      buttons: ['OK'],
    });
    await alert.present();
    this.cdr.markForCheck();
  }

  private stopApprovalWaiting(): void {
    this.isCheckingTimeout = false;
    this.nextApprovalCheckAt = 0;
    this.approvalStatusMessage = '';
    this.approvalTimerSub?.unsubscribe();
    this.approvalTimerSub = undefined;
    this.approvalPollSub?.unsubscribe();
    this.approvalPollSub = undefined;
    this.unsubscribeHoldChannel?.();
    this.unsubscribeHoldChannel = null;
    this.unsubscribeCustomerHoldChannel?.();
    this.unsubscribeCustomerHoldChannel = null;
  }

  cancelAwaitingApproval(): void {
    this.stopApprovalWaiting();
    if (this.hold) {
      this.release(this.hold);
      this.hold = null;
    }
    this.step = 'seats';
    this.loadSeatMap();
    this.cdr.markForCheck();
  }

  cancelReviewRide(): void {
    if (this.busy || this.cancellingHold) return;
    if (!this.hold) { this.resetBookingAndReturnHome(); return; }
    const hold = this.hold;
    this.cancellingHold = true;
    this.error = null;
    this.cdr.markForCheck();
    this.api.post<{ hold: SeatHold }>(`/fixed/seat-holds/${hold.id}/release`, {}).subscribe({
      next: (res) => {
        if (!['RELEASED', 'EXPIRED'].includes(res?.hold?.status || '')) {
          this.cancellingHold = false;
          this.error = 'Your seats could not be released. Please refresh your booking status and try again.';
          this.cdr.markForCheck();
          return;
        }
        this.stopApprovalWaiting();
        this.resetBookingAndReturnHome();
      },
      error: (err) => {
        this.cancellingHold = false;
        this.error = err?.error?.message || 'Could not cancel your seat request. Please try again.';
        this.cdr.markForCheck();
      },
    });
  }

  private resetBookingAndReturnHome(replaceUrl = false): void {
    this.error = null;
    this.busy = false;
    this.couponBusy = false;
    this.cancellingHold = false;
    this.hold = null;
    this.selected = [];
    this.route = null;
    this.departure = null;
    this.seatMap = null;
    this.boardStopId = null;
    this.dropStopId = null;
    this.luggage = 0;
    this.removeCoupon();
    this.couponEditorOpen = false;
    this.paymentModalOpen = false;
    this.step = 'route';
    this.cdr.markForCheck();
    if (replaceUrl) void this.router.navigate(['/customer-tabs/go'], { replaceUrl: true });
    else void this.router.navigate(['/customer-tabs/go']);
  }

  onHoldExpired(): void {
    if (this.step !== 'review' || !this.hold) return;
    if (this.hold.expires_at && new Date(this.hold.expires_at).getTime() > Date.now()) return;
    this.stopApprovalWaiting();
    this.resetBookingAndReturnHome(true);
    void this.toast('Your seat hold expired. Please start a new booking.', 'danger');
  }

  // ---- step 5: review + pay --------------------------------------------

  get seatFare(): number {
    if (this.hold && !this.route) return Math.max(0, (this.hold.original_amount ?? this.hold.amount) - this.luggageTotal);
    const base = (this.route?.flat_fare ?? 0) * this.selected.length;
    const deltas = this.selected.reduce((sum, l) => sum + (this.seatMap?.cells.find((c) => c.label === l)?.price_delta ?? 0), 0);
    return base + deltas;
  }
  get luggageTotal(): number {
    if (this.hold && !this.route) return Number(this.hold.luggage_surcharge_amount ?? 0);
    return this.luggage * (this.route?.luggage_surcharge_amount ?? 0);
  }
  get grossTotal(): number {
    return this.seatFare + this.luggageTotal;
  }
  get finalTotal(): number {
    if (this.hold) return Number(this.hold.amount);
    return this.coupon ? this.coupon.final_amount : this.grossTotal;
  }

  applyCoupon(): void {
    if (this.hold) { this.updateHeldCoupon(this.couponTitle.trim()); return; }
    if (this.couponBusy || !this.departure || !this.selected.length || !this.couponTitle.trim()) return;
    this.couponError = null;
    this.couponBusy = true;
    const payload = this.payload(true);
    const stillMatches = () => JSON.stringify(payload) === JSON.stringify(this.payload(true)) && !this.hold;
    this.api.post<CouponPreview>('/fixed/coupon-preview', payload).subscribe({
      next: (res) => { this.couponBusy = false; if (stillMatches()) { this.coupon = res; this.couponEditorOpen = false; } this.cdr.markForCheck(); },
      error: (err) => { this.couponBusy = false; if (stillMatches()) { this.coupon = null; this.couponError = err?.error?.message || 'Coupon could not be applied.'; } this.cdr.markForCheck(); },
    });
  }
  removeCoupon(): void {
    if (this.hold) { this.updateHeldCoupon(null); return; }
    this.couponTitle = ''; this.coupon = null; this.couponError = null;
  }

  get canEditHeldCoupon(): boolean {
    return !!this.hold && this.hold.status === 'ACCEPTED' && this.hold.coupon_editable !== false;
  }

  private updateHeldCoupon(code: string | null): void {
    if (!this.hold || !this.canEditHeldCoupon || this.couponBusy || this.busy || this.cancellingHold || code === '') return;
    const id = this.hold.id;
    this.couponBusy = true;
    this.couponError = null;
    this.cdr.markForCheck();
    this.api.post<{ hold: SeatHold }>(`/fixed/seat-holds/${id}/coupon`, { coupon_title: code }).subscribe({
      next: (res) => {
        this.couponBusy = false;
        if (this.hold?.id === id && res?.hold?.id === id) {
          this.hold = res.hold;
          this.coupon = null;
          this.couponTitle = res.hold.coupon_title || '';
          this.couponEditorOpen = false;
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.couponBusy = false;
        if (this.hold?.id === id) this.couponError = err?.status === 404
          ? 'Coupon updates are temporarily unavailable. Please try again later.'
          : err?.error?.message || 'Could not update the coupon. Your current fare is unchanged.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Opens the shared payment sheet so the rider picks Online / UPI / Cash. */
  pay(): void {
    if (this.busy || this.couponBusy || this.cancellingHold || !this.selected.length || !this.hold || !['ACCEPTED', 'HELD'].includes(this.hold.status || '')) return;
    this.paymentModalOpen = true;
    this.cdr.markForCheck();
  }

  /** Chosen from the shared payment sheet */
  onPayMethod(method: PaymentChoice): void {
    this.paymentModalOpen = false;
    this.payMethod = method;
    if (this.hold && (this.hold.status === 'ACCEPTED' || this.hold.status === 'HELD')) {
      if (method === 'cash') {
        this.confirmCashPayment(this.hold);
      } else {
        void this.startRazorpay(this.hold);
      }
    } else {
      this.createHoldAndPay(method);
    }
  }

  private createHoldAndPay(method: PaymentChoice): void {
    if (this.busy || !this.selected.length) return;
    this.busy = true;
    this.error = null;
    this.cdr.markForCheck();

    const payload = { ...this.payload(false), payment_method: method === 'cash' ? 'cash' : 'razorpay' };
    this.api.post<{ hold: SeatHold }>('/fixed/seat-holds', payload, { 'Idempotency-Key': this.uuid() }).subscribe({
      next: (res) => {
        const hold = res?.hold ?? null;
        if (!hold) { this.busy = false; void this.toast('Could not hold seats. Try again.', 'danger'); this.cdr.markForCheck(); return; }
        this.hold = hold;
        if (hold.status === 'PENDING_DRIVER_APPROVAL') {
          this.busy = false;
          this.step = 'awaiting_approval';
          this.startApprovalWaiting(hold);
          this.cdr.markForCheck();
        } else if (method === 'cash') {
          this.confirmCashPayment(hold);
        } else {
          void this.startRazorpay(hold);
        }
      },
      error: (err) => { this.busy = false; void this.toast(err?.error?.message || 'Could not hold seats.', 'danger'); this.cdr.markForCheck(); },
    });
  }

  private confirmCashPayment(hold: SeatHold): void {
    this.busy = true;
    this.cdr.markForCheck();
    void this.startRazorpay(hold);
  }

  /** For a cash ticket: the upfront deposit charged online now (rest is cash). */
  get cashDeposit(): number {
    if (this.payMethod !== 'cash' || this.cashDepositPercent <= 0) return 0;
    return Math.round(this.finalTotal * this.cashDepositPercent / 100);
  }
  get cashBalance(): number {
    return Math.max(0, this.finalTotal - this.cashDeposit);
  }
  get payMethodLabel(): string {
    return this.payMethod === 'cash' ? 'Cash' : this.payMethod === 'gpay' ? 'UPI / GPay' : 'Online';
  }

  private async startRazorpay(hold: SeatHold): Promise<void> {
    let order: { payment_required?: boolean; reservation?: Reservation; razorpay: { key_id: string; order_id: string; amount_paise: number; currency: string } };
    try {
      order = (await this.api
        .post<any>(`/fixed/seat-holds/${hold.id}/razorpay-order`, { payment_method: this.payMethod === 'cash' ? 'cash' : 'razorpay' }, { 'Idempotency-Key': this.uuid() })
        .toPromise());
    } catch (err: any) {
      this.busy = false;
      await this.toast(err?.error?.message || 'Could not start payment.', 'danger');
      this.cdr.markForCheck();
      return;
    }

    if (order.payment_required === false) {
      this.busy = false;
      this.reservation = order.reservation ?? null;
      this.step = 'done';
      this.cdr.markForCheck();
      return;
    }
    // A delayed order response must not reopen checkout after the timer returned Home.
    if (this.hold?.id !== hold.id || this.step !== 'review') return;
    if (typeof Razorpay === 'undefined') {
      this.busy = false;
      await this.toast('Payment library not loaded. Check your connection.', 'danger');
      this.cdr.markForCheck();
      return;
    }
    const user = this.auth.getUser();
    const rzpOptions: any = {
      key: order.razorpay.key_id,
      order_id: order.razorpay.order_id,
      amount: order.razorpay.amount_paise,
      currency: order.razorpay.currency,
      name: 'DreamCabs',
      description: `Fixed booking #${hold.id}`,
      prefill: {
        name: user?.name || '',
        email: user?.email || '',
        contact: user?.phone || '',
        ...(this.payMethod === 'gpay' ? { method: 'upi' } : {}),
      },
      ...(this.payMethod === 'gpay'
        ? {
            method: {
              upi: true,
              card: false,
              netbanking: false,
              wallet: false,
              emi: false,
              paylater: false,
            },
            upi: {
              flow: 'intent',
            },
            config: {
              display: {
                blocks: {
                  upi: {
                    name: 'Pay via Google Pay / UPI',
                    instruments: [
                      {
                        method: 'upi',
                        flows: ['intent'],
                        apps: ['google_pay', 'phonepe', 'paytm', 'bhim'],
                      },
                    ],
                  },
                },
                sequence: ['block.upi'],
                preferences: { show_default_blocks: false },
              },
            },
          }
        : {}),
      theme: { color: '#12B35B' },
      handler: (resp: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) =>
        this.confirmPayment(hold, resp),
      modal: {
        ondismiss: async () => {
          this.busy = false;
          this.release(hold);
          await this.toast('Payment cancelled. Your seat hold was released.', 'danger');
          this.cdr.markForCheck();
        },
      },
    };

    const rzp = new Razorpay(rzpOptions);
    rzp.on('payment.failed', async (resp: any) => {
      this.busy = false;
      await this.toast(resp?.error?.description || 'Payment failed.', 'danger');
      this.cdr.markForCheck();
    });
    rzp.open();
  }

  private confirmPayment(
    hold: SeatHold,
    payment: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string },
  ): void {
    this.api.post<{ reservation: Reservation; boarding_otp?: string }>(
      `/fixed/seat-holds/${hold.id}/confirm-payment`,
      { board_stop_id: hold.board_stop_id ?? this.boardStopId, drop_stop_id: hold.drop_stop_id ?? this.dropStopId, booking_channel: 'advance', ...payment },
      { 'Idempotency-Key': this.uuid() },
    ).subscribe({
      next: (res) => {
        this.busy = false;
        this.reservation = res?.reservation ?? null;
        this.boardingCode = res?.boarding_otp ?? '';
        this.step = 'done';
        this.cdr.markForCheck();
      },
      error: (err) => { this.busy = false; void this.toast(err?.error?.message || 'Payment confirmation failed.', 'danger'); this.cdr.markForCheck(); },
    });
  }

  private release(hold: SeatHold): void {
    this.api.post(`/fixed/seat-holds/${hold.id}/release`, {}).subscribe({ next: () => {}, error: () => {} });
  }

  // ---- done -------------------------------------------------------------

  viewBooking(): void {
    const bookingId = (this.reservation as any)?.id;
    this.booking.reset();
    if (bookingId) {
      void this.router.navigate(['/customer-tabs/fixed-rides', bookingId]);
    } else {
      void this.router.navigateByUrl('/customer-tabs/fixed-rides?active=1');
    }
  }

  // ---- nav --------------------------------------------------------------

  back(): void {
    this.error = null;
    switch (this.step) {
      case 'departure': this.step = 'route'; break;
      case 'details': this.step = 'departure'; break;
      case 'seats': this.step = 'details'; break;
      case 'awaiting_approval': this.cancelAwaitingApproval(); break;
      case 'review':
        if (this.hold) { this.release(this.hold); this.hold = null; }
        this.step = 'seats';
        this.loadSeatMap();
        break;
      default: void this.router.navigate(['/customer-tabs/go']);
    }
    this.cdr.markForCheck();
  }

  trackByRoute = (_: number, r: FixedRoute): number => r.id;
  trackByDep = (_: number, d: FixedDeparture): number => d.id;
  trackByStop = (_: number, s: FixedStop): number => s.id;

  // ---- plumbing ---------------------------------------------------------

  private payload(requireCoupon: boolean): Record<string, unknown> {
    const p: Record<string, unknown> = {
      route_departure_id: this.departure?.id,
      board_stop_id: this.boardStopId,
      drop_stop_id: this.dropStopId,
      seat_labels: this.selected,
      seats: this.selected.length || 1,
      has_extra_luggage: this.luggage > 0,
      extra_luggage_count: this.luggage,
    };
    const c = this.couponTitle.trim();
    if (c || requireCoupon) p['coupon_title'] = c;
    return p;
  }

  private uuid(): string {
    try { return (crypto as any).randomUUID(); }
    catch { return `fixed-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; }
  }

  private async toast(message: string, color: 'success' | 'danger'): Promise<void> {
    const t = await this.toastCtrl.create({ message, duration: 2600, color });
    await t.present();
  }
}
