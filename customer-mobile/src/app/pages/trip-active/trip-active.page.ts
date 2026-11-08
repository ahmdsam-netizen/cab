import { CUSTOMER_MAP_STYLE, fitCustomerMap, focusCustomerNavigation } from '../../core/customer-map';
import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ActionSheetController, AlertController, ToastController } from '@ionic/angular';
import { ApiService } from '../../core/api.service';
import { AuthService, PaymentMethod } from '../../core/auth.service';
import { GeoFix, GeolocationService } from '../../core/geolocation.service';
import { PlacesService } from '../../core/places.service';
import {
  RealtimeService,
  TripLocationPayload,
  TripStatusPayload,
} from '../../core/realtime.service';
import {
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
  buildPassengerMarkerElement,
} from '../../core/car-marker.helper';
import { NavigationRouteRenderer, separateNavigationMarkers } from '../../core/navigation-route.helper';
import { PaymentChoice } from '../../shared/payment-method-modal.component';

declare const google: any;
declare const Razorpay: any;

type UpiOrderResponse = {
  payment: { id: number };
  breakdown?: { fare: number; gateway_fee: number; total: number; payment_method: string | null };
  razorpay: {
    key_id: string;
    order_id: string;
    amount_paise: number;
    currency: string;
    /** Set when a gateway fee was priced — checkout is locked to this method. */
    method?: string | null;
  };
};

/** Response from /pay/cash-deposit: the upfront deposit order, or nothing to
 *  charge when the operator's deposit is 0%. */
type CashDepositResponse = {
  deposit_required: boolean;
  cash_balance_due?: number;
  breakdown?: { fare: number; deposit: number; cash_balance_due: number };
  razorpay: { key_id: string; order_id: string; amount_paise: number; currency: string };
};

/** One row of the pre-checkout method chooser, priced for this fare. */
type GatewayMethod = {
  key: string;
  label: string;
  hint: string;
  rate: number;
  fee?: number;
  total?: number;
};

type GatewayMethodsResponse = {
  fee_enabled: boolean;
  fare: number | null;
  methods: GatewayMethod[];
};

type TripDetail = {
  id: number;
  status: string;
  final_fare: number | null;
  estimated_fare?: number | null;
  tip_amount?: number | null;
  payment_method?: PaymentMethod | null;
  service_mode?: 'private' | 'shuttle' | string | null;
  ride_type_name?: string | null;
  vehicle_name?: string | null;
  is_for_other?: boolean;
  booked_for_name?: string | null;
  booked_for_phone?: string | null;
  pickup_lat?: number | null;
  pickup_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  pickup_address?: string | null;
  drop_address?: string | null;
  driver?: {
    id: number;
    name?: string | null;
    phone?: string | null;
    // Driver's last-known location — used to render the marker immediately,
    // before any live websocket update arrives. (decimal → string from Laravel)
    current_lat?: number | string | null;
    current_lng?: number | string | null;
    accepted_payment_methods?: PaymentMethod[] | null;
    // Nested driver profile (vehicle info). The relation is User.driver, so on
    // the trip it reads as trip.driver.driver — confusing but correct.
    driver?: {
      vehicle_brand?: string | null;
      vehicle_model?: string | null;
      vehicle_color?: string | null;
      vehicle_reg_no?: string | null;
    } | null;
  };
};

type TippingConfig = {
  enabled: boolean;        // operator's global tips on/off switch — hide all tip UI when false
  values: number[];        // 3 presets: rupees or % depending on `in_percentage`
  in_percentage: boolean;
};

@Component({
  selector: 'app-trip-active',
  templateUrl: './trip-active.page.html',
  styleUrls: ['./trip-active.page.scss'],
  standalone: false,
})
export class TripActivePage implements OnInit, OnDestroy {
  tripId!: number;
  loading = true;
  trip: TripDetail | null = null;
  // Active start-ride OTP, shown to the booker once the driver is at the pickup.
  // On a for-a-friend trip the same code is also SMSed to the friend; this lets
  // the booker read it off-screen and relay it if the SMS didn't arrive.
  startOtp: string | null = null;
  private startOtpInFlight = false;

  // Shuttle pool boarding code (otp mode) — the rider's own code for THIS trip,
  // fed to the shared full-screen boarding prompt. Private uses startOtp instead.
  shuttleBoardingCode: string | null = null;
  private shuttleCodeInFlight = false;
  driverAccepts: PaymentMethod[] = ['cash', 'razorpay'];
  cityAcceptsUpper: string[] = ['CASH', 'RAZORPAY'];
  // Authoritative list the backend computed (city ∩ driver-effective, honoring
  // the operator's "drivers manage own modes" toggle). Preferred over the local
  // city∩driver fallback when present.
  serverAllowedMethods: PaymentMethod[] | null = null;
  selectedPaymentMethod: PaymentMethod | null = null;
  /** Shared payment-method sheet (Online / GPay / Cash). */
  payModalOpen = false;
  // What the server says is still owed on this trip, and whether it's payable
  // yet. `prepay` means the ride hasn't run — the rider is paying up front.
  // Absent on older backends, where the page falls back to "pay once completed".
  paymentDue: { amount: number; payable: boolean; prepay: boolean } | null = null;
  // Per-city "Vehicle make & model" toggle (default ON). When false, the rider
  // sees only the number plate — the make/model line is hidden.
  showVehicleMakeModel = true;

  // Coupon entered on the payment screen. `couponPreview` is the validated
  // server response; until set, the payable amount equals trip.final_fare.
  couponInput = '';
  couponApplying = false;
  couponError: string | null = null;
  couponPreview: { discount: number; final_amount: number; coupon: { assignment_id: number; title: string } } | null = null;
  driverPosition: { lat: number; lng: number } | null = null;
  // Per-city radius (metres): once the driver is this close to pickup the rider
  // can no longer cancel. 0 = no limit. Sourced from the negotiation payload.
  cancelBlockRadiusM = 0;
  liveConnected = false;
  etaMinutes: number | null = null;
  etaUpdatedAt: number | null = null;

  // Rating state
  ratingScore = 0;
  ratingComment = '';
  ratingBusy = false;
  ratingSubmitted = false;

  // Tipping state — values pulled from /operator/tipping. Once the user taps
  // any preset / submits a custom amount / taps Skip, this card disappears
  // and won't return for this trip (option-A behaviour).
  tipping: TippingConfig | null = null;
  tipBusy = false;
  tipSkipped = false;
  tipCustomOpen = false;
  tipCustomAmount: number | null = null;

  // SOS / share-link state
  sosBusy = false;
  shareBusy = false;

  // Map-dominant layout: let the user collapse the sheet to see more map.
  sheetCollapsed = false;

  // True once a live driver GPS fix has arrived over the websocket. Until then
  // we keep seeding the marker from the driver's last-known location.
  private liveDriverFix = false;

  // Driver-details modal (fare, ETA, phone, vehicle) — opened by tapping the
  // driver marker on the map or the info button on the sheet.
  showDriverModal = false;

  // Cancel overlay state
  showCancelModal = false;
  cancelReasons = {
    waitingLongTime: false,
    unableToContact: false,
    deniedDestination: false,
    deniedPickup: false,
    wrongAddress: false,
    priceNotReasonable: false,
    carConditionBad: false
  };
  cancelCustomReason = '';

  private poll: any = null;
  private shuttleCodePoll: any = null;
  private unsubscribeRealtime: (() => void) | null = null;
  private map: any | null = null;
  private driverMarker: any | null = null;
  private pickupMarker: any | null = null;
  private dropMarker: any | null = null;
  private navRoute = new NavigationRouteRenderer();
  private etaDebounceHandle: any = null;
  private etaInflight = false;
  private readonly etaDebounceMs = 10_000;
  private distanceMatrix: any | null = null;

  // Customer's own location stream (so the driver app can render us moving).
  private geoWatchId: string | null = null;
  private geoWatchStarting = false;
  private geoWatchRevision = 0;
  private lastCustomerPostAt = 0;
  private readonly customerPostMinIntervalMs = 5_000;
  private selfMarker: any | null = null;
  selfPosition: { lat: number; lng: number } | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private location: Location,
    private api: ApiService,
    private auth: AuthService,
    private alertCtrl: AlertController,
    private actionSheetCtrl: ActionSheetController,
    private toastCtrl: ToastController,
    private places: PlacesService,
    private realtime: RealtimeService,
    private geo: GeolocationService,
    private zone: NgZone,
  ) {}

  // ── Driver details (shown in the map modal) ──────────────────────
  get driverName(): string {
    return this.trip?.driver?.name || 'Driver assigned';
  }
  get driverPhone(): string | null {
    return this.trip?.driver?.phone || null;
  }
  /** "White Maruti Swift" — whatever vehicle fields are populated. */
  get vehicleSummary(): string | null {
    const v = this.trip?.driver?.driver;
    if (!v) return null;
    const parts = [v.vehicle_color, v.vehicle_brand, v.vehicle_model].filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  get vehicleReg(): string | null {
    return this.trip?.driver?.driver?.vehicle_reg_no || null;
  }

  /** Label for the ETA stat — makes clear whether it counts down to pickup or
   *  to the destination, depending on the trip phase. */
  get etaLabel(): string {
    return this.trip?.status === 'EN_ROUTE_DROP' ? 'ETA to drop' : 'ETA to pickup';
  }

  /** A driver is assigned but we have no position to plot yet (no live fix and
   *  no last-known location). Show a "locating…" hint while the trip is active. */
  get awaitingDriverLocation(): boolean {
    if (!this.trip?.driver || this.driverPosition) return false;
    const s = this.trip.status;
    return s !== 'COMPLETED' && s !== 'CANCELLED';
  }

  get isShuttleTrip(): boolean {
    return this.trip?.service_mode === 'shuttle'
      || (this.trip?.ride_type_name ?? '').toLowerCase().includes('shuttle');
  }

  get tripKindLabel(): string {
    return this.isShuttleTrip ? 'Shuttle' : 'Trip';
  }

  /** Open the details modal. Safe to call from a Google Maps event (which
   *  fires outside Angular) — re-enters the zone so the binding updates. */
  openDriverDetails(): void {
    this.zone.run(() => { this.showDriverModal = true; });
  }

  /** Dial the driver via the OS dialer. */
  callDriver(): void {
    const phone = this.driverPhone;
    if (!phone) return;
    window.open(`tel:${phone}`, '_system');
  }

  /**
   * Floating back button on the map — return to wherever we came from (the
   * ride-detail page, the booking screen, …). Falls back to the Rides list
   * when there's no history to pop (e.g. a deep link).
   */
  back(): void {
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigateByUrl('/customer-tabs/my-trips');
    }
  }

  /**
   * Per-state title + subtitle copy. Replaces the generic enum value with
   * something a customer would actually want to read while watching the trip
   * progress. The ETA chip is still rendered separately when applicable.
   */
  statusCopy(): { title: string; sub: string } {
    const status = this.trip?.status ?? '';
    const shuttle = this.isShuttleTrip;
    switch (status) {
      case 'PAYMENT_PENDING':
        return { title: 'Driver accepted', sub: 'Complete payment or your cash deposit to confirm this booking.' };
      case 'NEGOTIATION':
        return shuttle
          ? { title: 'Finding Shuttle driver', sub: 'We are sending your paid Shuttle request to nearby drivers.' }
          : { title: 'Finding driver', sub: 'We are sending your request to nearby drivers.' };
      case 'CONFIRMED':
        return shuttle
          ? { title: 'Shuttle driver confirmed', sub: 'Connecting…' }
          : { title: 'Driver confirmed', sub: 'Connecting…' };
      case 'ASSIGNED':
      case 'EN_ROUTE_PICKUP':
        return {
          title: shuttle ? 'Shuttle driver is on the way' : 'Driver is on the way',
          sub: this.etaMinutes != null ? `Arriving in ${this.etaMinutes} min` : 'Heading to pickup',
        };
      case 'ARRIVED_PICKUP':
        return { title: shuttle ? 'Shuttle has arrived' : 'Driver has arrived', sub: 'Please come to the pickup point' };
      case 'EN_ROUTE_DROP':
        return {
          title: shuttle ? 'Shuttle ride in progress' : 'Ride in progress',
          sub: this.etaMinutes != null ? `Arriving in ${this.etaMinutes} min` : "Sit back — you're on your way",
        };
      case 'ARRIVED_DROP':
        return shuttle
          ? { title: "You've arrived", sub: 'Your Shuttle was prepaid.' }
          : { title: "You've arrived", sub: 'Please complete payment' };
      case 'COMPLETED':
        return shuttle
          ? { title: 'Shuttle trip complete', sub: 'Thanks for riding.' }
          : { title: 'Trip complete', sub: 'Tap to pay & rate' };
      case 'CANCELLED':
        return shuttle
          ? { title: 'Shuttle cancelled', sub: 'Refund is pending manual Razorpay processing.' }
          : { title: 'Trip cancelled', sub: '' };
      default:
        return { title: status || 'Loading…', sub: '' };
    }
  }

  ngOnInit(): void {
    this.tripId = Number(this.route.snapshot.paramMap.get('tripId'));
    if (!this.tripId) {
      this.router.navigateByUrl('/customer-tabs/go', { replaceUrl: true });
      return;
    }
    this.refresh();
    void this.initMap();
    this.subscribeLive();
    this.loadTippingConfig();
    // Slow polling fallback for status, in case Reverb is down.
    this.poll = setInterval(() => this.refresh(), 15000);
    // The shuttle boarding code pops instantly via the ShuttleBoardingCodeReady
    // live event; this poll is just a fallback if the socket is down.
    this.shuttleCodePoll = setInterval(() => this.syncShuttleBoardingCode(), 15000);
  }

  /**
   * Fetch the operator's tipping presets once. Failure is non-fatal — the
   * tip card just won't appear. We don't block the page on this.
   */
  private loadTippingConfig(): void {
    this.api.get<TippingConfig>('/operator/tipping').subscribe({
      next: (cfg) => { this.tipping = cfg; },
      error: () => { this.tipping = null; },
    });
  }

  ngOnDestroy(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.shuttleCodePoll) clearInterval(this.shuttleCodePoll);
    if (this.unsubscribeRealtime) this.unsubscribeRealtime();
    if (this.etaDebounceHandle) clearTimeout(this.etaDebounceHandle);
    this.navRoute.clear();
    this.stopCustomerLocationStream();
  }

  private subscribeLive(): void {
    this.unsubscribeRealtime = this.realtime.subscribeTracking(
      this.tripId,
      (p) => this.onLocation(p),
      (p) => this.onStatus(p),
      undefined,
      () => this.syncStartOtp()
    );
    this.liveConnected = !!this.unsubscribeRealtime;
  }

  private async initMap(): Promise<void> {
    try {
      await this.places.ensureLoaded();

      // The map container lives behind *ngIf="!loading", so on a fast script
      // load it may not be in the DOM yet. Wait for it to render (up to ~2s).
      let div = document.getElementById('trip-map');
      for (let i = 0; !div && i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        div = document.getElementById('trip-map');
      }
      if (!div || this.map) return;

      this.map = new google.maps.Map(div, {
        ...CUSTOMER_MAP_STYLE,
        center: { lat: 28.6139, lng: 77.209 },
        disableDefaultUI: true,
        // Required for AdvancedMarkerElement to render. DEMO_MAP_ID is
        // Google's public test id; replace with a styled mapId when going to
        // production.
        mapId: 'DEMO_MAP_ID',
      });

      // Draw whatever we already have (markers + route); otherwise just frame.
      if (this.trip) this.updateRouteMarkers();
      else this.fitMap();
      // A live fix / seed may have landed before the map was ready.
      this.ensureDriverMarker();
      this.syncRoute();
    } catch {
      /* maps not available — page still works without it */
    }
  }

  private refresh(): void {
    this.api
      .get<{
        trip_id: number;
        trip?: TripDetail;
        negotiation?: { final_amount: number };
        city_payment_modes?: string[];
        available_payment_methods?: string[];
        payment_due?: { amount: number; payable: boolean; prepay: boolean };
        show_vehicle_make_model?: boolean;
        cancel_block_radius_m?: number;
        driver_location?: { lat: number; lng: number; recorded_at?: string } | null;
      }>(`/trips/${this.tripId}/negotiation`)
      .subscribe({
        next: (res) => {
          this.loading = false;
          if (res?.trip) {
            this.trip = res.trip;
            const driver = res.trip.driver;
            if (driver?.accepted_payment_methods?.length) {
              this.driverAccepts = driver.accepted_payment_methods;
            }
            if (res.city_payment_modes?.length) {
              this.cityAcceptsUpper = res.city_payment_modes;
            }
            if (Array.isArray(res.available_payment_methods)) {
              this.serverAllowedMethods = res.available_payment_methods
                .map((m) => m.toLowerCase())
                .filter((m): m is PaymentMethod => m === 'cash' || m === 'razorpay');
            }
            if (typeof res.show_vehicle_make_model === 'boolean') {
              this.showVehicleMakeModel = res.show_vehicle_make_model;
            }
            if (typeof res.cancel_block_radius_m === 'number') {
              this.cancelBlockRadiusM = res.cancel_block_radius_m;
            }
            if (res.payment_due) {
              this.paymentDue = res.payment_due;
            }
            if (this.selectedPaymentMethod == null && this.trip.payment_method) {
              this.selectedPaymentMethod = this.trip.payment_method;
            }
            this.seedDriver(
              res.driver_location ??
                (this.trip.driver?.current_lat != null && this.trip.driver?.current_lng != null
                  ? { lat: Number(this.trip.driver.current_lat), lng: Number(this.trip.driver.current_lng) }
                  : null)
            );
            this.updateRouteMarkers();
            this.syncCustomerLocationStream();
            this.syncStartOtp();
            // If the first init bailed (slow API → map div wasn't in the DOM
            // yet), retry now that the page has rendered.
            if (!this.map) void this.initMap();
          }
        },
        error: () => {
          this.loading = false;
        },
      });
  }

  /**
   * Methods the customer can actually use on this trip — intersection of:
   *   • the operator payment policy (Operator Settings → Payments)
   *   • driver.accepted_payment_methods (what this driver opted into)
   */
  get availablePaymentMethods(): PaymentMethod[] {
    // Prefer the backend's authoritative list (it already honors the city cap,
    // the driver's modes, and the operator's "drivers manage own modes" toggle).
    // Fall back to the local city ∩ driver computation for older backends.
    if (this.serverAllowedMethods) return this.serverAllowedMethods;
    const cityLower = this.cityAcceptsUpper
      .map((m) => m.toLowerCase())
      .filter((m): m is PaymentMethod => m === 'cash' || m === 'razorpay');
    return cityLower.filter((m) => this.driverAccepts.includes(m));
  }

  get payableAmount(): number | null {
    if (this.couponPreview) return this.couponPreview.final_amount;
    // What the server says is still owed — this already nets off a prepayment,
    // so after a longer-than-quoted ride it's the balance, not the whole fare.
    if (this.paymentDue) return this.paymentDue.amount;
    return this.trip?.final_fare ?? null;
  }

  /** Is there money to collect right now (before the ride, or after it)? */
  get canPayNow(): boolean {
    return this.paymentDue ? this.paymentDue.payable : this.isCompleted();
  }

  /**
   * True while the rider is paying for a ride that hasn't happened yet. Only the
   * wording changes — it's the same charge, taken up front.
   */
  get isPrepaying(): boolean {
    return !!this.paymentDue?.prepay;
  }

  async applyCoupon(): Promise<void> {
    if (this.couponPreview) {
      this.couponPreview = null;
      this.couponInput = '';
      this.couponError = null;
      return;
    }
    const code = (this.couponInput || '').trim();
    if (!code) return;
    this.couponApplying = true;
    this.couponError = null;
    try {
      const res = await this.api
        .post<{
          discount?: number;
          final_amount?: number;
          coupon?: { assignment_id: number; title: string };
          error?: string;
        }>(`/trips/${this.tripId}/coupon-preview`, { coupon_title: code })
        .toPromise();
      if (res?.error) {
        this.couponError = res.error;
        return;
      }
      if (res?.discount != null && res?.final_amount != null && res?.coupon) {
        this.couponPreview = {
          discount: res.discount,
          final_amount: res.final_amount,
          coupon: res.coupon,
        };
      } else {
        this.couponError = 'Could not apply coupon.';
      }
    } catch (e: any) {
      this.couponError = e?.error?.message || 'Could not apply coupon.';
    } finally {
      this.couponApplying = false;
    }
  }

  private updateRouteMarkers(): void {
    if (!this.map || !this.trip) return;
    const t = this.trip;
    if (t.pickup_lat != null && t.pickup_lng != null) {
      const pos = { lat: Number(t.pickup_lat), lng: Number(t.pickup_lng) };
      if (!this.pickupMarker) {
        this.pickupMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: 'Pickup',
          content: buildPassengerMarkerElement({ kind: 'pickup', name: 'Pickup' }),
        });
      } else {
        this.pickupMarker.position = pos;
      }
    }
    if (t.drop_lat != null && t.drop_lng != null) {
      const pos = { lat: Number(t.drop_lat), lng: Number(t.drop_lng) };
      if (!this.dropMarker) {
        this.dropMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: 'Drop',
          content: buildPassengerMarkerElement({ kind: 'drop', name: 'Drop' }),
        });
      } else {
        this.dropMarker.position = pos;
      }
    }

    this.syncRoute();

    this.fitMap();
  }

  private shouldShowRoute(): boolean {
    const s = this.trip?.status;
    return (
      s === 'CONFIRMED' ||
      s === 'ASSIGNED' ||
      s === 'EN_ROUTE_PICKUP' ||
      s === 'ARRIVED_PICKUP' ||
      s === 'EN_ROUTE_DROP' ||
      s === 'ARRIVED_DROP'
    );
  }

  private syncRoute(): void {
    const trip = this.trip;
    if (!this.map || !trip) return;
    this.ensurePassengerMarker();
    const boarded = trip.status === 'EN_ROUTE_DROP' || trip.status === 'ARRIVED_DROP';
    const origin = boarded ? this.driverPosition : this.selfPosition;
    const lat = boarded ? trip.drop_lat : trip.pickup_lat;
    const lng = boarded ? trip.drop_lng : trip.pickup_lng;
    separateNavigationMarkers(this.driverMarker, this.selfMarker);
    if (!this.shouldShowRoute() || !origin || lat == null || lng == null) {
      this.navRoute.clear();
      return;
    }

    const target = { lat: Number(lat), lng: Number(lng) };
    void this.navRoute.render(this.map, origin, target, boarded ? 'drop' : 'pickup');
    this.navRoute.follow(this.map, origin, target, boarded ? this.driverMarker : this.selfMarker);
  }

  private fitMap(): void {
    if (this.navRoute.following) return;
    if (!this.map) return;
    if (this.trip && this.shouldShowRoute()) {
      const boarded = this.trip.status === 'EN_ROUTE_DROP' || this.trip.status === 'ARRIVED_DROP';
      const lat = boarded ? this.trip.drop_lat : this.trip.pickup_lat;
      const lng = boarded ? this.trip.drop_lng : this.trip.pickup_lng;
      if (lat != null && lng != null) {
        focusCustomerNavigation(this.map, { lat: Number(lat), lng: Number(lng) });
        return;
      }
    }
    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const m of [this.pickupMarker, this.dropMarker, this.driverMarker, this.selfMarker]) {
      if (m && m.position) {
        // AdvancedMarkerElement.position is either {lat,lng} or LatLng; extend()
        // accepts both shapes via the LatLngLiteral overload.
        bounds.extend(m.position as any);
        any = true;
      }
    }
    if (any) {
      // The sheet floats over the bottom of the map, so pad the framing to
      // keep pins in the visible band above it.
      const bottomPad = this.isCompleted()
        ? Math.round(window.innerHeight * 0.5)
        : this.sheetCollapsed
          ? 130
          : Math.round(window.innerHeight * 0.4);
      fitCustomerMap(this.map, bounds, { top: 96, right: 56, bottom: bottomPad, left: 56 });
    }
  }

  private onLocation(p: TripLocationPayload): void {
    const loc = p?.location;
    if (!loc || loc.lat == null || loc.lng == null) return;
    // A real live fix arrived — from now on it owns the marker; stop seeding.
    this.liveDriverFix = true;
    // This fires from a websocket callback (outside Angular's zone). Re-enter
    // the zone for the state mutation so the cancel-proximity gate (canCancel /
    // cancelBlockedByProximity) re-evaluates the instant the driver crosses the
    // radius — not only on the next poll tick. Marker plotting can stay outside.
    this.zone.run(() => {
      this.driverPosition = { lat: Number(loc.lat), lng: Number(loc.lng) };
    });
    this.scheduleEtaUpdate();
    this.ensureDriverMarker();
    this.syncRoute();
    if (loc.bearing_deg != null && this.driverMarker) {
      const boarded = this.trip?.status === 'EN_ROUTE_DROP' || this.trip?.status === 'ARRIVED_DROP';
      updateCarMarkerBearing(this.driverMarker, boarded ? 0 : loc.bearing_deg);
    }
  }

  /**
   * Create the driver marker (or move it) from the current driverPosition.
   * Safe to call before the map exists or before a position is known — it
   * no-ops until both are available, so it can be driven by live updates, the
   * initial seed, or the map finishing init.
   */
  private ensureDriverMarker(): void {
    if (!this.map || !this.driverPosition) return;
    if (!this.driverMarker) {
      this.driverMarker = new google.maps.marker.AdvancedMarkerElement({
        position: this.driverPosition,
        map: this.map,
        title: 'Driver',
        content: this.buildDriverMarker(),
        gmpClickable: true,
      });
      // Tapping the driver (marker or its label) opens the details modal.
      this.driverMarker.addListener('click', () => this.openDriverDetails());
      this.fitMap();
    } else {
      if (this.trip?.status !== 'EN_ROUTE_DROP' && this.trip?.status !== 'ARRIVED_DROP') {
        this.driverMarker.position = this.driverPosition;
      }
      const markerUrl = (this.trip?.driver as any)?.vehicle?.map_marker_url
        || (this.trip?.driver as any)?.map_marker_url
        || (this.trip as any)?.map_marker_url
        || null;
      if (markerUrl) {
        updateCarMarkerImage(this.driverMarker, markerUrl);
      }
    }
  }

  /**
   * Passenger map marker: person avatar with pulse ring and Passenger label.
   * Ensures the passenger icon is always visible on the live screen.
   */
  private ensurePassengerMarker(): void {
    if (!this.map || !this.trip) return;

    // Once boarded (OTP verified, en route to drop), hide customer icon because they are inside driver's car
    const s = this.trip.status;
    const isBoarded = s === 'EN_ROUTE_DROP' || s === 'ARRIVED_DROP';
    if (isBoarded || !this.shouldShowRoute()) {
      if (this.selfMarker) {
        this.selfMarker.map = null;
        this.selfMarker = null;
      }
      return;
    }

    const pos = this.selfPosition;
    if (!pos) return;

    if (!this.selfMarker) {
      this.selfMarker = new google.maps.marker.AdvancedMarkerElement({
        position: pos,
        map: this.map,
        title: 'Passenger',
        content: buildPassengerMarkerElement({
          kind: 'pickup',
          name: '',
          avatarUrl: this.auth.resolveAvatarUrl(this.auth.getUser()),
        }),
        zIndex: 4,
      });
      this.fitMap();
    } else {
      if (!this.selfMarker.map) this.selfMarker.map = this.map;
    }
  }

  /**
   * Seed the driver marker from the last-known location returned by the API
   * (freshest driver_locations ping). Used to show the driver from the
   * confirmation screen onward, before live trip streaming begins. Keeps
   * updating on each poll until a real live fix takes over (liveDriverFix).
   */
  private seedDriver(loc: { lat: number; lng: number } | null | undefined): void {
    if (this.liveDriverFix) return; // a live fix now owns the marker
    if (!loc) return;
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    this.driverPosition = { lat, lng };
    this.ensureDriverMarker();
    this.scheduleEtaUpdate();
  }

  /**
   * Driver map marker: top-down vector vehicle.
   */
  private buildDriverMarker(): HTMLElement {
    const el = buildReusableCarMarkerElement({
      bearing: 0,
      markerUrl: (this.trip?.driver as any)?.vehicle?.map_marker_url || (this.trip?.driver as any)?.map_marker_url || (this.trip as any)?.map_marker_url,
    });
    el.addEventListener('click', () => this.openDriverDetails());
    return el;
  }

  // ─────────────────────────────────────────────────────────────────
  // Marker content builders for AdvancedMarkerElement
  // ─────────────────────────────────────────────────────────────────

  private buildPin(letter: string, color: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'width:28px',
      'height:36px',
      'display:flex',
      'align-items:flex-start',
      'justify-content:center',
      'padding-top:4px',
      'font-weight:700',
      'font-size:13px',
      'color:#fff',
      `background:${color}`,
      'border-radius:50% 50% 50% 0',
      'transform:rotate(-45deg) translate(0,-14px)',
      'border:2px solid #fff',
      'box-shadow:0 1px 4px rgba(0,0,0,0.4)',
    ].join(';');
    const inner = document.createElement('span');
    inner.textContent = letter;
    inner.style.cssText = 'transform:rotate(45deg);';
    el.appendChild(inner);
    return el;
  }

  private buildDot(color: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'width:16px',
      'height:16px',
      'border-radius:50%',
      `background:${color}`,
      'border:2px solid #fff',
      'box-shadow:0 1px 4px rgba(0,0,0,0.4)',
    ].join(';');
    return el;
  }

  /**
   * Throttled ETA refresh. Only runs while the driver is en-route to pickup
   * (ASSIGNED / EN_ROUTE_PICKUP). After ARRIVED_PICKUP we stop estimating.
   *
   * Leading edge: compute immediately when we don't have an ETA yet so it
   * appears right away. Afterwards, throttle to once per interval — crucially
   * WITHOUT resetting a pending timer, so a steady stream of live fixes (every
   * few seconds) can't keep deferring the computation forever.
   */
  private scheduleEtaUpdate(): void {
    if (!this.shouldComputeEta()) return;
    if (!this.driverPosition) return;
    if (this.etaMinutes == null && !this.etaInflight) {
      void this.refreshEta();
      return;
    }
    if (this.etaDebounceHandle) return; // already scheduled — let it fire
    this.etaDebounceHandle = setTimeout(() => {
      this.etaDebounceHandle = null;
      void this.refreshEta();
    }, this.etaDebounceMs);
  }

  private shouldComputeEta(): boolean {
    const s = this.trip?.status;
    return s === 'ASSIGNED' || s === 'EN_ROUTE_PICKUP' || s === 'EN_ROUTE_DROP';
  }

  /** Where the ETA counts down to in the current phase: the pickup while the
   *  driver heads to the customer, the drop-off once the ride is underway. */
  private etaTarget(): { lat: number; lng: number } | null {
    const t = this.trip;
    if (!t) return null;
    if (t.status === 'EN_ROUTE_DROP') {
      if (t.drop_lat == null || t.drop_lng == null) return null;
      return { lat: Number(t.drop_lat), lng: Number(t.drop_lng) };
    }
    if (t.pickup_lat == null || t.pickup_lng == null) return null;
    return { lat: Number(t.pickup_lat), lng: Number(t.pickup_lng) };
  }

  private async refreshEta(): Promise<void> {
    if (this.etaInflight) return;
    if (!this.shouldComputeEta()) return;
    if (!this.driverPosition) return;
    const destination = this.etaTarget();
    if (!destination) return;

    const origin = { lat: this.driverPosition.lat, lng: this.driverPosition.lng };

    // Always have a straight-line estimate ready so the ETA is never blank —
    // the Distance Matrix API may not be enabled on the Maps key.
    const fallback = this.straightLineEtaMin(origin, destination);

    try {
      await this.places.ensureLoaded();
      if (!this.distanceMatrix && typeof google !== 'undefined' && google.maps?.DistanceMatrixService) {
        this.distanceMatrix = new google.maps.DistanceMatrixService();
      }
      if (!this.distanceMatrix) {
        this.applyEta(fallback);
        return;
      }

      this.etaInflight = true;
      this.distanceMatrix.getDistanceMatrix(
        { origins: [origin], destinations: [destination], travelMode: 'DRIVING' },
        (response: any, status: string) => {
          this.etaInflight = false;
          const el = status === 'OK' ? response?.rows?.[0]?.elements?.[0] : null;
          if (el && el.status === 'OK' && el.duration?.value) {
            this.applyEta(Math.max(1, Math.round(el.duration.value / 60)));
          } else {
            // Distance Matrix denied/failed — fall back to the straight-line estimate.
            this.applyEta(fallback);
          }
        }
      );
    } catch {
      this.etaInflight = false;
      this.applyEta(fallback);
    }
  }

  /** Rough ETA in minutes from a straight-line (haversine) distance at an
   *  assumed urban driving speed. Fallback when Distance Matrix is unavailable. */
  private straightLineEtaMin(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): number {
    const R = 6371; // km
    const dLat = ((to.lat - from.lat) * Math.PI) / 180;
    const dLng = ((to.lng - from.lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((from.lat * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    const km = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const avgKmh = 22; // conservative city average
    return Math.max(1, Math.round((km / avgKmh) * 60));
  }

  /** Set the ETA inside Angular's zone — these callbacks fire from Google Maps
   *  / websocket handlers outside the zone, so a bare assignment wouldn't
   *  refresh the view. */
  private applyEta(min: number): void {
    this.zone.run(() => {
      this.etaMinutes = min;
      this.etaUpdatedAt = Date.now();
    });
  }

  private onStatus(p: TripStatusPayload): void {
    if (!this.trip) return;
    const changed = this.trip.status !== p.status;
    this.trip = { ...this.trip, status: p.status };

    if (changed) {
      // The ETA target flips between pickup and drop across phases — drop any
      // stale value, then recompute for the new phase (or leave it cleared if
      // ETA no longer applies, e.g. ARRIVED_PICKUP / ARRIVED_DROP).
      this.etaMinutes = null;
      if (this.etaDebounceHandle) {
        clearTimeout(this.etaDebounceHandle);
        this.etaDebounceHandle = null;
      }
      if (this.shouldComputeEta()) this.scheduleEtaUpdate();
    }

    this.syncCustomerLocationStream();
    this.syncStartOtp();
    this.syncRoute();
  }

  /**
   * Fetch the live start-ride OTP while the driver waits at the pickup, clear it
   * otherwise. Owner-only endpoint — returns the code only after the driver has
   * requested it, so the booker sees it appear the moment the driver taps Start.
   */
  /** The code fed to the shared full-screen prompt — shuttle vs private source. */
  get boardingPromptCode(): string | null {
    return this.isShuttleTrip ? this.shuttleBoardingCode : this.startOtp;
  }

  /**
   * A shuttle rider's boarding code can appear at any point during the ride (the
   * driver boards each passenger in turn), so we poll it while the ride is live —
   * unlike the private start-code which is tied to ARRIVED_PICKUP.
   */
  private syncShuttleBoardingCode(): void {
    const active = ['ASSIGNED', 'EN_ROUTE_PICKUP', 'ARRIVED_PICKUP', 'EN_ROUTE_DROP', 'ARRIVED_DROP'];
    if (!this.tripId || !this.isShuttleTrip || !active.includes(this.trip?.status ?? '')) {
      this.shuttleBoardingCode = null;
      return;
    }
    if (this.shuttleCodeInFlight) return;
    this.shuttleCodeInFlight = true;
    this.api.get<{ booking?: { boarding_code?: string | null } }>(`/shuttle/trips/${this.tripId}/my-booking`).subscribe({
      next: (res) => {
        this.shuttleCodeInFlight = false;
        this.shuttleBoardingCode = res?.booking?.boarding_code ?? null;
      },
      error: () => { this.shuttleCodeInFlight = false; },
    });
  }

  private syncStartOtp(): void {
    // Shuttle pools carry their own per-rider code, not the private start-OTP.
    if (this.isShuttleTrip) {
      this.startOtp = null;
      this.syncShuttleBoardingCode();
      return;
    }
    if (this.trip?.status !== 'ARRIVED_PICKUP') {
      this.startOtp = null;
      return;
    }
    if (this.startOtpInFlight) return;
    this.startOtpInFlight = true;
    this.api.get<{ start_otp: string | null }>(`/trips/${this.tripId}/start-otp`).subscribe({
      next: (res) => {
        this.startOtpInFlight = false;
        // Guard against a late response arriving after the trip moved on.
        const code = this.trip?.status === 'ARRIVED_PICKUP' ? (res?.start_otp ?? null) : null;
        // When the code first appears, make sure the booker can actually see it
        // even if they'd collapsed the sheet to watch the map.
        if (code && !this.startOtp) this.sheetCollapsed = false;
        this.startOtp = code;
      },
      error: () => {
        this.startOtpInFlight = false;
      },
    });
  }

  /** Per-cell digits for the start-code display. */
  get otpDigits(): string[] {
    return this.startOtp ? this.startOtp.split('') : [];
  }

  // ─────────────────────────────────────────────────────────────────
  // Customer-side location stream (drives the driver app's customer marker)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Start streaming our GPS while the trip is in any state where the driver
   * needs to see us; stop afterwards. Idempotent — safe to call repeatedly.
   */
  private syncCustomerLocationStream(): void {
    const s = this.trip?.status;
    const shouldStream =
      s === 'CONFIRMED' ||
      s === 'ASSIGNED' ||
      s === 'EN_ROUTE_PICKUP' ||
      s === 'ARRIVED_PICKUP' ||
      s === 'EN_ROUTE_DROP' ||
      s === 'ARRIVED_DROP';
    if (shouldStream) this.startCustomerLocationStream();
    else this.stopCustomerLocationStream();
  }

  private async startCustomerLocationStream(): Promise<void> {
    if (this.geoWatchId !== null || this.geoWatchStarting) return;
    this.geoWatchStarting = true;
    const revision = ++this.geoWatchRevision;
    this.selfPosition ??= this.geo.recentPosition();
    this.syncRoute();
    const initialPosition = this.selfPosition;
    void this.geo.getCurrentFix().then(fix => {
      if (fix && revision === this.geoWatchRevision && this.selfPosition === initialPosition) {
        this.onOwnPosition(fix);
      }
    });
    try {
      const watchId = await this.geo.watchPosition(
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
        fix => {
          if (fix && revision === this.geoWatchRevision) this.onOwnPosition(fix);
        },
      );
      if (revision === this.geoWatchRevision) this.geoWatchId = watchId;
      else await this.geo.clearWatch(watchId);
    } finally {
      if (revision === this.geoWatchRevision) this.geoWatchStarting = false;
    }
  }

  private async stopCustomerLocationStream(): Promise<void> {
    ++this.geoWatchRevision;
    this.geoWatchStarting = false;
    const watchId = this.geoWatchId;
    this.geoWatchId = null;
    if (watchId !== null) await this.geo.clearWatch(watchId);
  }

  private onOwnPosition(fix: GeoFix): void {
    const p = { lat: fix.lat, lng: fix.lng };
    this.selfPosition = p;

    // Render/move our own marker every tick so the customer can visually
    // confirm where they are relative to the driver.
    if (this.map) {
      this.syncRoute();
    }

    // Throttle the network POST to one per 5s, independent of the marker render.
    const now = Date.now();
    if (now - this.lastCustomerPostAt < this.customerPostMinIntervalMs) return;
    this.lastCustomerPostAt = now;

    const body = {
      lat: fix.lat,
      lng: fix.lng,
      accuracy_m: fix.accuracy,
    };

    this.api.post(`/trips/${this.tripId}/customer-location`, body).subscribe({
      next: () => {},
      error: (err: any) => {
        // 409 = trip is no longer in an active state — stop streaming.
        if (err?.status === 409) this.stopCustomerLocationStream();
        // 429 = throttled; backoff bumps the next-allowed timestamp.
        if (err?.status === 429) this.lastCustomerPostAt = now + 2_000;
      },
    });
  }

  canCancel(): boolean {
    if (!this.trip) return false;
    // EN_ROUTE_PICKUP is included so the rider can still bail while the driver
    // is approaching — the proximity gate removes the option once close.
    if (!['CONFIRMED', 'ASSIGNED', 'EN_ROUTE_PICKUP'].includes(this.trip.status)) return false;
    return !this.driverWithinCancelBlock();
  }

  /** True only when cancellation was hidden specifically because the driver is
   *  now within the city's cancel-block radius — drives the inline hint. */
  cancelBlockedByProximity(): boolean {
    if (!this.trip) return false;
    if (!['CONFIRMED', 'ASSIGNED', 'EN_ROUTE_PICKUP'].includes(this.trip.status)) return false;
    return this.driverWithinCancelBlock();
  }

  /** Driver within the configured radius of pickup. Fails OPEN (false) when the
   *  gate is off or we can't measure — the server enforces the real rule. */
  private driverWithinCancelBlock(): boolean {
    const r = this.cancelBlockRadiusM;
    if (!r || r <= 0) return false; // gate disabled for this city/product
    const pickup = this.pickupLatLng();
    if (!pickup || !this.driverPosition) return false; // can't measure → allow
    return this.metersBetween(this.driverPosition, pickup) <= r;
  }

  private pickupLatLng(): { lat: number; lng: number } | null {
    const t = this.trip;
    if (!t || t.pickup_lat == null || t.pickup_lng == null) return null;
    return { lat: Number(t.pickup_lat), lng: Number(t.pickup_lng) };
  }

  /** Great-circle distance between two lat/lng points, in metres. */
  private metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6371000; // m
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  isCompleted(): boolean {
    return this.trip?.status === 'COMPLETED';
  }

  /**
   * Minimise the floating sheet to just the status + driver header so the
   * customer can see almost the entire map. No-op once the trip is complete
   * (that view needs the payment / rating content visible).
   */
  toggleSheet(): void {
    if (this.isCompleted()) return;
    this.sheetCollapsed = !this.sheetCollapsed;
    // Re-frame the map after the sheet finishes resizing so pins stay visible.
    setTimeout(() => this.fitMap(), 280);
  }

  // ── Tipping ──────────────────────────────────────────────────────

  /** Show the tip card only on completed trips, with config loaded, where
   *  the user hasn't already tipped or skipped this trip. */
  get showTipCard(): boolean {
    return (
      this.isCompleted() &&
      !!this.tipping &&
      this.tipping.enabled &&
      !this.tipSkipped &&
      (this.trip?.tip_amount ?? null) === null
    );
  }

  /** Display label for a preset value — "₹20" or "20%" depending on flag. */
  tipLabel(value: number): string {
    return this.tipping?.in_percentage ? `${value}%` : `₹${value}`;
  }

  /** Resolve a preset (rupee or percent) into actual rupees to send. */
  private tipAmountFor(value: number): number {
    if (!this.tipping?.in_percentage) return value;
    const fare = this.trip?.final_fare ?? 0;
    return Math.max(1, Math.round((fare * value) / 100));
  }

  pickTipPreset(value: number): void {
    const amount = this.tipAmountFor(value);
    this.submitTip(amount);
  }

  openCustomTip(): void {
    this.tipCustomAmount = null;
    this.tipCustomOpen = true;
  }

  submitCustomTip(): void {
    const amt = Number(this.tipCustomAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    this.tipCustomOpen = false;
    // In percentage mode the entry is a % of fare; convert to rupees so the
    // server always receives absolute rupees (same as the presets).
    this.submitTip(this.tipAmountFor(amt));
  }

  skipTip(): void {
    this.tipSkipped = true;
  }

  private submitTip(amount: number): void {
    if (this.tipBusy) return;
    this.tipBusy = true;
    this.api.post<{ trip: TripDetail }>(`/trips/${this.tripId}/tip`, { amount }).subscribe({
      next: async (res) => {
        if (this.trip && res.trip?.tip_amount != null) {
          this.trip.tip_amount = res.trip.tip_amount;
        }
        const t = await this.toastCtrl.create({
          message: `Tip of ₹${amount} added. Thank you!`,
          duration: 2000,
          color: 'success',
        });
        await t.present();
        this.tipBusy = false;
      },
      error: async (err) => {
        const t = await this.toastCtrl.create({
          message: err?.error?.message || 'Could not add tip.',
          duration: 2500,
          color: 'danger',
        });
        await t.present();
        this.tipBusy = false;
      },
    });
  }

  cancel(): void {
    this.cancelReasons = {
      waitingLongTime: false,
      unableToContact: false,
      deniedDestination: false,
      deniedPickup: false,
      wrongAddress: false,
      priceNotReasonable: false,
      carConditionBad: false
    };
    this.cancelCustomReason = '';
    this.showCancelModal = true;
  }

  async submitCancellation(): Promise<void> {
    const selected: string[] = [];
    if (this.cancelReasons.waitingLongTime) selected.push('Waiting for long time');
    if (this.cancelReasons.unableToContact) selected.push('Unable to contact driver');
    if (this.cancelReasons.deniedDestination) selected.push('Driver denied to go to destination');
    if (this.cancelReasons.deniedPickup) selected.push('Driver denied to come to pickup');
    if (this.cancelReasons.wrongAddress) selected.push('Wrong address shown');
    if (this.cancelReasons.priceNotReasonable) selected.push('The Price is not reasonable');
    if (this.cancelReasons.carConditionBad) selected.push('Car condition is not good');

    let reasonStr = selected.join(', ');
    if (this.cancelCustomReason?.trim()) {
      reasonStr += (reasonStr ? '. Other: ' : '') + this.cancelCustomReason.trim();
    }

    if (!reasonStr) {
      const t = await this.toastCtrl.create({
        message: 'Please select a reason or write one below.',
        duration: 2000,
        color: 'warning'
      });
      await t.present();
      return;
    }

    try {
      this.loading = true;
      await this.api.post(`/trips/${this.tripId}/cancel`, { reason: reasonStr }).toPromise();
      this.showCancelModal = false;
      const t = await this.toastCtrl.create({
        message: this.isShuttleTrip ? 'Shuttle cancelled. Refund is pending manual Razorpay processing.' : 'Trip cancelled successfully.',
        duration: 2400,
        color: 'success'
      });
      await t.present();
      this.router.navigateByUrl('/customer-tabs/go', { replaceUrl: true });
    } catch (e: any) {
      this.loading = false;
      const t = await this.toastCtrl.create({
        message: e?.error?.message || 'Could not cancel.',
        duration: 2500,
        color: 'danger',
      });
      await t.present();
    }
  }

  async pay(): Promise<void> {
    // The shared sheet renders only the operator's enabled methods
    // (Online / GPay / Cash) and shows the cash deposit split.
    this.payModalOpen = true;
  }

  /** Chosen from the shared payment sheet. Online/GPay run the Razorpay flow
   *  (GPay locked to UPI); Cash runs the upfront-deposit flow. */
  onPrivatePayMethod(method: PaymentChoice): void {
    this.payModalOpen = false;
    if (method === 'cash') {
      if (this.isCompleted()) {
        this.api.post(`/trips/${this.tripId}/pay/cash`, {}).subscribe({
          next: () => this.refresh(),
          error: (err) => { this.toastCtrl.create({ message: err?.error?.message || 'Could not record cash payment.', duration: 2500 }).then(t => t.present()); },
        });
        return;
      }
      void this.doPayCashDeposit();
      return;
    }
    void this.doPayRazorpay(method === 'gpay' ? 'upi' : undefined);
  }

  /** Cash = pay the upfront deposit online now (the rest is cash to the driver
   *  at trip end). A 0% operator deposit needs no online charge at all. */
  private async doPayCashDeposit(): Promise<void> {
    let res: CashDepositResponse;
    try {
      res = (await this.api
        .post<CashDepositResponse>(`/trips/${this.tripId}/pay/cash-deposit`, {
          coupon_title: this.couponPreview?.coupon.title ?? null,
        })
        .toPromise()) as CashDepositResponse;
    } catch (e: any) {
      const t = await this.toastCtrl.create({ message: e?.error?.message || 'Could not start the cash deposit.', duration: 2500, color: 'danger' });
      await t.present();
      return;
    }

    // No upfront deposit — pure cash ride, nothing to charge online.
    if (!res?.deposit_required) {
      const t = await this.toastCtrl.create({ message: 'Booked — pay the driver in cash at drop-off.', duration: 2500, color: 'success' });
      await t.present();
      this.refresh();
      return;
    }

    if (typeof Razorpay === 'undefined') {
      const t = await this.toastCtrl.create({ message: 'Payment library not loaded. Check your connection.', duration: 2500, color: 'danger' });
      await t.present();
      return;
    }
    const user = this.auth.getUser();
    const rzp = new Razorpay({
      key: res.razorpay.key_id,
      order_id: res.razorpay.order_id,
      amount: res.razorpay.amount_paise,
      currency: res.razorpay.currency,
      name: 'DreamCabs',
      description: `Trip #${this.tripId} deposit`,
      prefill: { name: user?.name || '', email: user?.email || '', contact: user?.phone || '' },
      theme: { color: '#000000' },
      handler: (resp: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
        this.verifyUpiPayment(resp);
      },
      modal: {
        ondismiss: async () => {
          const t = await this.toastCtrl.create({ message: 'Deposit cancelled.', duration: 2000, color: 'warning' });
          await t.present();
        },
      },
    });
    rzp.on('payment.failed', async (resp: any) => {
      const t = await this.toastCtrl.create({ message: resp?.error?.description || 'Deposit failed.', duration: 3000, color: 'danger' });
      await t.present();
    });
    rzp.open();
  }

  /**
   * Asks the customer how they want to pay, showing what each option costs.
   *
   * Only appears when the platform charges the gateway fee on to the customer —
   * the rate differs by method (UPI and ordinary cards are cheaper than Amex or
   * EMI), and Razorpay needs the order's amount fixed before its checkout opens,
   * so the choice can't wait until the payment screen.
   *
   * Returns the chosen method key, `null` when there's no fee to price (skip the
   * chooser entirely), or 'cancelled' when the customer backed out.
   */
  private async chooseGatewayMethod(): Promise<string | null | 'cancelled'> {
    let config: GatewayMethodsResponse;
    try {
      const fare = this.couponPreview?.final_amount ?? this.trip?.final_fare ?? null;
      const query = fare !== null ? `?fare=${encodeURIComponent(String(fare))}` : '';
      config = (await this.api
        .get<GatewayMethodsResponse>(`/payments/methods${query}`)
        .toPromise()) as GatewayMethodsResponse;
    } catch {
      // The chooser is an enhancement, not a gate — if it can't load, fall back
      // to letting Razorpay price whatever the customer picks at its own screen.
      return null;
    }

    if (!config?.fee_enabled || !(config.methods?.length)) {
      return null;
    }

    const alert = await this.alertCtrl.create({
      header: 'How would you like to pay?',
      subHeader: 'The payment fee depends on the method you choose.',
      inputs: config.methods.map((m, i) => ({
        type: 'radio' as const,
        label: m.fee !== undefined ? `${m.label} — ₹${m.fee.toFixed(2)} fee` : m.label,
        value: m.key,
        checked: i === 0,
      })),
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', role: 'confirm' },
      ],
    });
    await alert.present();

    const { role, data } = await alert.onWillDismiss();
    if (role === 'cancel') {
      return 'cancelled';
    }

    return (data?.values as string) || config.methods[0].key;
  }

  /**
   * Razorpay's checkout takes a map of which methods to offer. Our keys are
   * coarser than theirs — 'premium_card' and 'international' are still cards —
   * so they collapse back to the checkout's own vocabulary here.
   */
  private checkoutMethodFlags(method: string): Record<string, boolean> {
    const target = ['premium_card', 'international'].includes(method) ? 'card'
      : method === 'emi' ? 'emi'
      : method;

    return {
      upi: target === 'upi',
      card: target === 'card',
      netbanking: target === 'netbanking',
      wallet: target === 'wallet',
      emi: target === 'emi',
      paylater: target === 'emi',
    };
  }

  private async doPayRazorpay(forcedMethod?: string): Promise<void> {
    if (typeof Razorpay === 'undefined') {
      const t = await this.toastCtrl.create({
        message: 'Payment library not loaded. Check your connection.',
        duration: 2500,
        color: 'danger',
      });
      await t.present();
      return;
    }

    // GPay locks to UPI outright. Otherwise Razorpay fixes an order's amount
    // before checkout opens, and the fee it charges us depends on how the
    // customer pays — so the instrument is picked here, priced, and then locked
    // at checkout. chooseGatewayMethod returns null when the fee is switched off
    // (no chooser shown) or 'cancelled' when the customer backed out.
    const method = forcedMethod ?? (await this.chooseGatewayMethod());
    if (method === 'cancelled') {
      return;
    }

    let order: UpiOrderResponse;
    try {
      order = (await this.api
        .post<UpiOrderResponse>(`/trips/${this.tripId}/pay/razorpay`, {
          coupon_title: this.couponPreview?.coupon.title ?? null,
          payment_method: method,
        })
        .toPromise()) as UpiOrderResponse;
    } catch (e: any) {
      const t = await this.toastCtrl.create({
        message: e?.error?.message || 'Could not start payment.',
        duration: 2500,
        color: 'danger',
      });
      await t.present();
      return;
    }

    const user = this.auth.getUser();
    const rzp = new Razorpay({
      key: order.razorpay.key_id,
      order_id: order.razorpay.order_id,
      amount: order.razorpay.amount_paise,
      currency: order.razorpay.currency,
      name: 'DreamCabs',
      description: `Trip #${this.tripId}`,
      prefill: {
        name: user?.name || '',
        email: user?.email || '',
        contact: user?.phone || '',
        ...(method === 'upi' ? { method: 'upi' } : {}),
      },
      theme: { color: '#000000' },
      ...(method === 'upi'
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
        : (order.razorpay.method ? { method: this.checkoutMethodFlags(order.razorpay.method) } : {})),
      handler: (resp: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        this.verifyUpiPayment(resp);
      },
      modal: {
        ondismiss: async () => {
          const t = await this.toastCtrl.create({
            message: 'Payment cancelled.',
            duration: 2000,
            color: 'warning',
          });
          await t.present();
        },
      },
    });

    rzp.on('payment.failed', async (resp: any) => {
      const t = await this.toastCtrl.create({
        message: resp?.error?.description || 'Payment failed.',
        duration: 3000,
        color: 'danger',
      });
      await t.present();
    });

    rzp.open();
  }

  private async verifyUpiPayment(resp: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }): Promise<void> {
    try {
      await this.api.post(`/trips/${this.tripId}/pay/razorpay/verify`, resp).toPromise();
      const t = await this.toastCtrl.create({
        message: 'Payment successful.',
        duration: 2000,
        color: 'success',
      });
      await t.present();
      this.refresh();
    } catch (e: any) {
      const t = await this.toastCtrl.create({
        message: e?.error?.message || 'Payment verification failed.',
        duration: 3000,
        color: 'danger',
      });
      await t.present();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Rating (post-trip)
  // ─────────────────────────────────────────────────────────────────

  setRating(score: number): void {
    if (this.ratingSubmitted || this.ratingBusy) return;
    this.ratingScore = score;
  }

  async submitRating(): Promise<void> {
    if (this.ratingScore < 1 || this.ratingScore > 5) {
      const t = await this.toastCtrl.create({
        message: 'Pick a star rating first.',
        duration: 2000,
        color: 'warning',
      });
      await t.present();
      return;
    }
    this.ratingBusy = true;
    try {
      await this.api
        .post(`/trips/${this.tripId}/rating`, {
          score: this.ratingScore,
          comment: this.ratingComment.trim() || null,
        })
        .toPromise();
      this.ratingSubmitted = true;
      const t = await this.toastCtrl.create({
        message: 'Thanks for the rating!',
        duration: 2000,
        color: 'success',
      });
      await t.present();
    } catch (e: any) {
      const msg = e?.error?.message || 'Could not submit rating.';
      // 409 already-rated should still feel like success on the next render.
      if (e?.status === 409) {
        this.ratingSubmitted = true;
      }
      const t = await this.toastCtrl.create({ message: msg, duration: 2500, color: 'danger' });
      await t.present();
    } finally {
      this.ratingBusy = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SOS
  // ─────────────────────────────────────────────────────────────────

  canSOS(): boolean {
    const s = this.trip?.status;
    if (!s) return false;
    return s !== 'COMPLETED' && s !== 'CANCELLED';
  }

  async triggerSOS(): Promise<void> {
    if (this.sosBusy) return;
    const a = await this.alertCtrl.create({
      header: 'Send SOS?',
      message: 'Admins will be alerted with your trip and current location.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Send SOS',
          role: 'destructive',
          handler: () => {
            void this.doTriggerSOS();
          },
        },
      ],
    });
    await a.present();
  }

  private async doTriggerSOS(): Promise<void> {
    this.sosBusy = true;
    const payload: { lat?: number; lng?: number } = {};
    try {
      const pos = await this.getCurrentPosition();
      if (pos) {
        payload.lat = pos.lat;
        payload.lng = pos.lng;
      }
    } catch {
      // best-effort; backend accepts no coords
    }
    try {
      await this.api.post(`/trips/${this.tripId}/sos`, payload).toPromise();
      const t = await this.toastCtrl.create({
        message: 'SOS sent. Help is on the way.',
        duration: 3000,
        color: 'success',
      });
      await t.present();
    } catch (e: any) {
      const t = await this.toastCtrl.create({
        message: e?.error?.message || 'Could not send SOS.',
        duration: 3000,
        color: 'danger',
      });
      await t.present();
    } finally {
      this.sosBusy = false;
    }
  }

  private getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
    return this.geo.getCurrentPosition();
  }

  // ─────────────────────────────────────────────────────────────────
  // Share trip link
  // ─────────────────────────────────────────────────────────────────

  canShare(): boolean {
    return this.canSOS();
  }

  async shareTrip(): Promise<void> {
    if (this.shareBusy) return;
    this.shareBusy = true;
    try {
      const res: any = await this.api
        .post(`/trips/${this.tripId}/share-link`, {})
        .toPromise();
      const token = res?.token;
      if (!token) throw new Error('No token returned');

      const shareUrl = this.buildShareUrl(token);
      const text = `Track my trip: ${shareUrl}`;

      const nav = (typeof navigator !== 'undefined' ? (navigator as any) : null);
      if (nav?.share) {
        try {
          await nav.share({ title: 'My DreamCabs trip', text, url: shareUrl });
          return;
        } catch {
          // user cancelled or share failed — fall through to clipboard
        }
      }

      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(shareUrl);
        const t = await this.toastCtrl.create({
          message: 'Link copied to clipboard.',
          duration: 2500,
          color: 'success',
        });
        await t.present();
      } else {
        const a = await this.alertCtrl.create({
          header: 'Share this link',
          message: shareUrl,
          buttons: ['OK'],
        });
        await a.present();
      }
    } catch (e: any) {
      const t = await this.toastCtrl.create({
        message: e?.error?.message || 'Could not generate share link.',
        duration: 2500,
        color: 'danger',
      });
      await t.present();
    } finally {
      this.shareBusy = false;
    }
  }

  /** Whether this ride was booked for a friend whose number we have. */
  canTextFriend(): boolean {
    return !!(this.trip?.is_for_other && this.trip?.booked_for_phone)
      && !['CANCELLED', 'COMPLETED'].includes(this.trip?.status ?? '');
  }

  /** Generate the live-tracking link and open a text to the friend's number. */
  async textTrackingToFriend(): Promise<void> {
    if (this.shareBusy || !this.trip?.booked_for_phone) return;
    this.shareBusy = true;
    try {
      const res: any = await this.api.post(`/trips/${this.tripId}/share-link`, {}).toPromise();
      const token = res?.token;
      if (!token) throw new Error('No token returned');
      const shareUrl = this.buildShareUrl(token);
      const name = this.trip.booked_for_name || 'there';
      const body = encodeURIComponent(`Hi ${name}, your DreamCabs ride is on the way — track it live: ${shareUrl}`);
      window.location.href = `sms:${this.trip.booked_for_phone}?body=${body}`;
    } catch (e: any) {
      const t = await this.toastCtrl.create({
        message: e?.error?.message || 'Could not create the tracking link.',
        duration: 2500,
        color: 'danger',
      });
      await t.present();
    } finally {
      this.shareBusy = false;
    }
  }

  private buildShareUrl(token: string): string {
    // The backend exposes `GET /trips/share/{token}` returning JSON. Until a
    // dedicated public web view exists, point to the API endpoint.
    return `${this.api.baseUrl()}/trips/share/${token}`;
  }
}
