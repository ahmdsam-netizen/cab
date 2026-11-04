import { CUSTOMER_MAP_STYLE, fitCustomerMap } from '../../core/customer-map';
import { NavigationRouteRenderer } from '../../core/navigation-route.helper';
import { Component, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ModalController, ToastController } from '@ionic/angular';
import { Subject, debounceTime, switchMap } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ModeSelectModalComponent, AssistantMode } from '../../shared/mode-select-modal/mode-select-modal.component';
import { PaymentChoice } from '../../shared/payment-method-modal.component';
import { AuthService, AuthUser } from '../../core/auth.service';
import {
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
  buildPassengerMarkerElement,
} from '../../core/car-marker.helper';
import { GeolocationService, LatLng, GeoFix } from '../../core/geolocation.service';
import { PlacesService, PlaceSuggestion } from '../../core/places.service';
import { RealtimeService, DispatchRingExpandedPayload } from '../../core/realtime.service';
import { environment } from '../../../environments/environment';
import { Capacitor } from '@capacitor/core';
import { Contacts } from '@capacitor-community/contacts';

declare const google: any;
declare const Razorpay: any;

type SavedPlace = {
  id: number;
  label: string;
  address: string;
  lat: number;
  lng: number;
  icon: string | null;
};

type RideType = { id: number; name: string; description?: string | null };
type VehicleType = { id: number; name: string; description?: string | null; image_path?: string | null; image_url?: string | null; map_marker_url?: string | null; images?: any; };

type City = {
  id: number;
  name: string;
  country_code?: string | null;
  center_lat?: number | null;
  center_lng?: number | null;
  boundary_polygon?: { lat: number; lng: number }[] | null;
  // Uppercase CASH / RAZORPAY values mirroring the city_settings storage.
  allowed_payment_modes?: string[] | null;
};

type EstimateResponse = {
  available?: boolean;
  booking_enabled?: boolean;
  mode?: string;
  message?: string;
  city_vehicle_type_id?: number;
  vehicle_type_id?: number;
  vehicle_name?: string;
  vehicle_type_name?: string;
  currency?: string;
  distance_km?: number;
  time_min?: number;
  estimated_fare?: number;
  toll_amount?: number;
  commission_percent?: number;
  fare_breakdown?: {
    base_fare?: number;
    distance_component?: number;
    time_component?: number;
    pickup_component?: number;
    surge_multiplier?: number;
    // Area/region pricing line — present only when the city + rule allow showing it.
    region_fare_name?: string | null;
    region_fare_factor?: number | null;
    region_fare_amount?: number | null;
    subtotal_before_tax?: number;
    tax_percent?: number;
    tax_amount?: number;
    // Toll passed through from Google; 0 when the route has none.
    toll_amount?: number;
  };
  // The payment-gateway fee, quoted before the customer picks how they'll pay.
  // `fee`/`total` assume the default method (UPI); `max_fee` is the ceiling if
  // they pay by Amex, EMI or an international card. Absent or `enabled:false`
  // when the operator hasn't turned the fee on — then the fare is the total.
  gateway_fee?: {
    enabled?: boolean;
    fee?: number;
    total?: number;
    rate?: number;
    max_fee?: number;
    max_total?: number;
    varies?: boolean;
  };
};

type ShuttleBooking = {
  id: number;
  trip_id?: number | null;
  fare_amount?: number;
  currency?: string;
  status?: string;
  payment_status?: string;
};

type ActiveFixedRide = {
  id: number;
  status: string;
  trip_id?: number | null;
};

type ShuttleBookingResponse = {
  booking?: ShuttleBooking;
  message?: string;
};

type ShuttleRazorpayOrder = {
  booking?: ShuttleBooking;
  razorpay: { key_id: string; order_id: string; amount_paise: number; currency: string };
};

type NearbyDriver = {
  driver_id: number;
  name?: string | null;
  avatar_path?: string | null;
  rating_avg?: number;
  rating_count?: number;
  image_url?: string | null;
  map_marker_url?: string | null;
  vehicle?: {
    type?: string | null;
    brand?: string | null;
    model?: string | null;
    color?: string | null;
    reg_no?: string | null;
    image_url?: string | null;
    map_marker_url?: string | null;
  } | null;
  lat: number;
  lng: number;
  bearing_deg?: number | null;
  // Road distance from Google Distance Matrix. Falls back to the backend's
  // haversine value until the Matrix call resolves (or if it fails).
  distance_km: number;
  eta_min?: number | null;
};

type DriverOffer = {
  id?: number;
  from_role: 'customer' | 'driver';
  amount: number;
  status: string;
  from_user_id?: number;
  driver_name?: string;
  created_at?: string;
};

/**
 * Flow:
 *   idle    → pick pickup on map (auto from geolocation)
 *   route   → type destination
 *   preview → fare auto-calculated, driver list shown, customer picks a driver
 *   waiting → trip created + driver selected; waiting for driver to ACCEPT
 *   bids    → driver countered; customer accepts/rejects the counter
 *   map-select → focused mode for map-based location selection
 */
// Booking flow: Pickup → Drop → Find Driver → (name your price) → negotiate.
// Payment is no longer chosen here — it's handled at the end of the trip.
type RideState =
  | 'idle'
  | 'pickup'
  | 'drop'
  | 'ride-list'
  | 'find-driver'
  | 'offer'
  | 'waiting'
  | 'bids'
  | 'map-select'
  | 'saved-select';

@Component({
  selector: 'app-customer-book',
  templateUrl: './customer-book.page.html',
  styleUrls: ['./customer-book.page.scss'],
  standalone: false,
})
export class CustomerBookPage implements OnDestroy {
  get currentUser(): AuthUser | null {
    return this.auth.getUser();
  }

  state: RideState = 'idle';
  loading = false;
  error: string | null = null;

  rideTypes: RideType[] = [];
  selectedRideTypeId: number | null = null;

  // Vehicle catalog (Sedan / SUV / Hatchback / Van / Motorcycle). Pricing
  // rules are keyed by vehicle_type_id + product_kind, so this is what the
  // booking + estimate calls actually send.
  vehicleTypes: VehicleType[] = [];
  selectedVehicleTypeId: number | null = null;

  cities: City[] = [];
  selectedCity: City | null = null;
  private productsCityId: number | null = null;

  /**
   * Ride products are loaded from the `city_ride_products` table — what the
   * operator enabled for the active city (Local / Rental / Out Station …).
   * No more hardcoded list; only the icon mapping stays in the client since
   * the DB stores banners, not Ionicon names.
   */
  productKinds: {
    kind: 'local' | 'outstation' | 'rental' | 'fixed' | 'shuttle';
    scope: 'local' | 'outstation' | null;
    mode: 'private' | 'fixed' | 'shuttle' | null;
    label: string;
    image_url: string | null;
    icon: string;
  }[] = [];
  selectedProductKind: 'local' | 'outstation' | 'rental' = 'local';
  selectedServiceMode: 'private' | 'shuttle' = 'private';

  /**
   * Two-step picker: the customer first chooses a scope (Local / Outstation),
   * then a mode (Private / Fixed / Shuttle) within it. `scopeOptions` is the
   * grouped catalogue; `selectedScope` is the step-1 choice (null = show scopes).
   */
  scopeOptions: {
    scope: 'local' | 'outstation';
    label: string;
    icon: string;
    modes: {
      kind: 'local' | 'outstation' | 'rental' | 'fixed' | 'shuttle';
      scope: 'local' | 'outstation' | null;
      mode: 'private' | 'fixed' | 'shuttle' | null;
      label: string;
      image_url: string | null;
      icon: string;
    }[];
  }[] = [];
  selectedScope: 'local' | 'outstation' | null = null;

  // Outstation packages (One Way / Round Trip …) for the picked ride type.
  outstationPackages: { id: number; name: string }[] = [];
  selectedPackageId: number | null = null;
  // Set when the destination falls outside the selected city's polygon and we
  // auto-switch to Outstation. The banner above the driver list shows this.
  outsideServiceAreaNotice: string | null = null;

  pickup: { lat: number; lng: number; address: string } | null = null;
  drop: { lat: number; lng: number; address: string; place_id?: string } | null = null;

  pickupQuery = '';
  toQuery = '';
  toQuery$ = new Subject<string>();
  activeSearchField: 'pickup' | 'drop' = 'drop';
  suggestions: PlaceSuggestion[] = [];

  // Customer's saved places (Home, Work, …) surfaced as one-tap chips on the
  // pickup and drop steps. Loaded once per view-enter.
  savedPlaces: SavedPlace[] = [];

  selectedPaymentMode: 'cash' | 'razorpay' = 'cash';
  /** Shared payment-method sheet (Online / GPay / Cash) for the Shuttle flow. */
  shuttlePaymentModalOpen = false;

  estimate: EstimateResponse | null = null;

  // "Name your own price" — the fare the customer types in for drivers on the
  // price step. Starts EMPTY; the customer types any amount at or above the
  // configured negotiation floor (minFare). The send button stays disabled
  // until a valid amount is entered.
  offerAmount: number | null = null;
  // Negotiation floor delivered as min_amount; the backend rejects anything below it.
  minFare = 0;

  // Review Ride modal — opened from the preview sheet so the customer can see
  // the fare breakdown before picking a driver.
  showReviewModal = false;

  // "Book a ride for a friend / family" — toggled on the offer step. The booker
  // still owns + pays the trip; these identify the actual rider for the driver.
  bookingForOther = false;
  bookedForName = '';
  bookedForCountryCode = '91';
  bookedForPhone = '';

  // Driver list shown on the preview sheet (the customer picks one of these).
  drivers: NearbyDriver[] = [];
  loadingDrivers = false;
  private driversPollHandle: any = null;

  pickupError: string | null = null;
  dropError: string | null = null;
  vehicleError: string | null = null;

  tripId: number | null = null;
  selectedDriverId: number | null = null;
  searchSecondsLeft = 60;
  private searchTimer: any = null;
  // True when the chosen driver hasn't responded within the timeout. UI
  // surfaces a "Find another driver" CTA so the customer can cancel and pick
  // someone else without a fee (pricing rule's cancel grace covers it).
  showFindAnother = false;
  private findAnotherTimeoutHandle: any = null;

  // Real route metrics from Google DirectionsService. When present we pass
  // them to the backend so the estimate reflects the actual driven distance
  // rather than haversine.
  routeDistanceKm: number | null = null;
  routeTimeMin: number | null = null;
  // Toll for the drawn route, read from Google's Routes API when it provides one
  // (else null → no toll). Sent to the server, which applies it only if the
  // booked vehicle has tolls turned on. We never invent a number.
  tollAmount: number | null = null;

  driverOffers: DriverOffer[] = [];
  private unsubscribeRealtime: (() => void) | null = null;
  private pollHandle: any = null;

  private map: any | null = null;
  private pickupMarker: any | null = null;
  private bookingCamera = new NavigationRouteRenderer();
  private followBookingLocation = true;
  private dropMarker: any | null = null;
  // Live "you" dot that follows the device as it moves (home-screen tracking).
  private selfMarker: any | null = null;
  private geoWatchId: string | null = null;
  private selfPosition: LatLng | null = null;
  // Polylines drawn by Route.createPolylines() — kept so we can detach them
  // from the map when the customer picks a new destination.
  private routePolylines: any[] = [];
  mapsReady = false;
  mapsError: string | null = null;

  // Map markers for nearby drivers (Uber-style icons sliding around).
  private nearbyDriverMarkers = new Map<number, any>();
  private nearbyPollHandle: any = null;

  // Dispatch search-ring (expanding circle on the map while we're waiting
  // for a driver to accept). Each DispatchRingExpanded broadcast bumps the
  // radius; the Circle's radius is animated smoothly via a brief tween.
  private searchCircle: any | null = null;
  private searchCircleTween: any = null;

  // Lazily-built Google Distance Matrix client used to replace the backend's
  // haversine driver→pickup distance with the actual road distance + ETA as
  // each ring of drivers arrives. One service instance reused across hops.
  private distanceMatrix: any = null;
  dispatchRing: { hop: number; max_hops: number; radius_m: number; eligible: number; hop_interval_sec?: number } | null = null;

  // True while the discovery-only search is running (hop 1 to max_hops).
  // Flips to false when the final hop arrives. Drives the "Search drivers"
  // button state and the "Searching…" UI hint.
  searching = false;

  // Route signature (pickup|drop) of the last discovery search, so re-entering
  // the find-driver step without changing the route doesn't restart it.
  private lastSearchKey: string | null = null;

  // Customer's counter-back price typed in the bids sheet — re-broadcasts a new
  // offer to every driver so bargaining can continue.
  counterOfferAmount: number | null = null;

  // "Schedule for later" — on the fare step the customer can book a future ride
  // instead of searching now. scheduledAt holds the chosen ISO time; the server
  // parks it and the alarm-time worker dispatches near pickup.
  scheduleMode: 'now' | 'later' = 'now';
  scheduledAt: string | null = null;
  minScheduleAt = new Date().toISOString();

  // Home skeleton-loading — a full-screen skeleton covers the whole home
  // (map + top bar + sheet) on cold start until BOTH the map and the home
  // data are ready, then it fades out and the live screen reveals.
  activeFixedRides: ActiveFixedRide[] = [];

  homeLoading = true;
  private homeLoadStart = Date.now();
  private productsReady = false;
  private mapReady = false;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private router: Router,
    private geo: GeolocationService,
    private places: PlacesService,
    private realtime: RealtimeService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private modalCtrl: ModalController
  ) {
    this.toQuery$
      .pipe(
        debounceTime(250),
        switchMap((q) => this.places.autocompleteSearch(q, this.pickup ?? undefined))
      )
      .subscribe({
        next: (results) => (this.suggestions = results),
        error: () => (this.suggestions = []),
      });

    // Safety: never let the full-screen skeleton stick if the map or data is
    // slow/unavailable (e.g. a pending location-permission prompt).
    setTimeout(() => this.finishHomeLoading(), 6000);
  }

  ionViewWillEnter(): void {
    this.loadRideTypes();
    this.loadVehicleTypes();
    this.loadCities();
    this.loadSavedPlaces();
    this.loadActiveFixedRides();
  }

  ionViewDidEnter(): void {
    void this.initMap();
    // Greet the customer with the AI mode chooser (Voice / Self), once per app
    // session — the entry point for the in-app AI voice assistant.
    void this.maybeShowModePrompt();
  }

  /**
   * App-open mode chooser — "Continue with Voice" (the AI voice assistant) or
   * "Continue as Self" (manual). Shown once per app session; the picked mode is
   * remembered so the AI feature can wire in later.
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
      componentProps: { current: this.readMode() },
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<{ mode?: AssistantMode }>();
    if (data?.mode) {
      try { localStorage.setItem('dc_customer_mode', data.mode); } catch { /* ignore */ }
    }
  }

  /** The customer's last-picked mode, if any (used to highlight it on reopen). */
  private readMode(): AssistantMode | null {
    try {
      const m = localStorage.getItem('dc_customer_mode');
      return m === 'voice' || m === 'self' ? m : null;
    } catch {
      return null;
    }
  }

  ionViewWillLeave(): void {
    this.bookingCamera.clear();
    // Stop following the device while the page isn't visible (saves battery);
    // initMap() restarts the stream when the view re-enters.
    void this.stopSelfLocationStream();
  }

  ngOnDestroy(): void {
    this.bookingCamera.clear();
    this.cleanupSearch();
    this.stopNearbyDriversPoll();
    this.stopDriverListPoll();
    void this.stopSelfLocationStream();
  }

  // ─────────────────────────────────────────────────────────────────
  // Lookups + initial state
  // ─────────────────────────────────────────────────────────────────

  private loadActiveFixedRides(): void {
    this.api.get<{ data: ActiveFixedRide[] }>("/fixed/bookings").subscribe({
      next: (res) => {
        const rows = res?.data || [];
        this.activeFixedRides = rows
          .filter((ride) => !["DROPPED", "COMPLETED", "CANCELLED", "NO_SHOW"].includes(ride.status))
          .slice(0, 1);
      },
      error: () => {
        this.activeFixedRides = [];
      },
    });
  }

  viewActiveFixedRide(): void {
    this.router.navigateByUrl("/customer-tabs/fixed-rides?active=1");
  }

  private loadRideTypes(): void {
    this.api.get<{ data: RideType[] }>('/pricing/ride-types').subscribe({
      next: (res) => {
        this.rideTypes = res.data || [];
        if (this.rideTypes.length && this.selectedRideTypeId == null) {
          this.selectedRideTypeId = this.rideTypes[0].id;
        }
      },
      error: () => {
        this.rideTypes = [];
      },
    });
  }

  private loadVehicleTypes(): void {
    const q = this.selectedCity?.id ? `?city_id=${this.selectedCity.id}` : '';
    this.api.get<{ data: VehicleType[] }>(`/pricing/vehicle-types${q}`).subscribe({
      next: (res) => {
        this.vehicleTypes = res.data || [];
        // Default to "All" (selectedVehicleTypeId stays null). The customer
        // picks a specific type on the find-driver step if they want one.
      },
      error: () => (this.vehicleTypes = []),
    });
  }

  /**
   * Customer picked a ride type on the find-driver step. `null` = "All" (search
   * every vehicle type). Re-prices the estimate for the chosen type and re-runs
   * the driver search so the list only shows drivers who can serve it.
   */
  async selectRideVehicle(id: number | null): Promise<void> {
    if (this.selectedVehicleTypeId === id) return;
    this.selectedVehicleTypeId = id;
    this.vehicleError = null;
    await this.fetchEstimate();
    // On the ride-list step (step 3) we only re-price; the search starts when
    // the customer taps "Find drivers". If they're already on the driver-search
    // step, re-run it so the list matches the newly chosen type.
    if (this.state === 'find-driver') {
      await this.discoverDrivers();
    }
  }

  openReviewModal(): void {
    // Payment method is chosen on the trip-active payment page, so the
    // review modal opens unconditionally here.
    this.vehicleError = null;
    this.showReviewModal = true;
  }

  closeReviewModal(): void {
    this.showReviewModal = false;
  }

  private loadSavedPlaces(): void {
    this.api.get<{ data: SavedPlace[] }>('/me/saved-locations').subscribe({
      next: (res) => (this.savedPlaces = res.data || []),
      error: () => (this.savedPlaces = []),
    });
  }

  private loadCities(): void {
    this.api.get<{ data: City[] }>('/pricing/cities').subscribe({
      next: (res) => {
        this.cities = res.data || [];
        // Do not pick an arbitrary first city. Ride options must follow the
        // current pickup/live location, so wait until pickup is known and then
        // resolve the city from that point.
        this.resolveCityForPickup();
      },
      error: () => {
        this.cities = [];
        this.selectedCity = null;
        this.clearRideProducts();
        this.productsReady = true;
        this.maybeFinishHome();
      },
    });
  }

  private resolveCityForPickup(): void {
    if (!this.pickup || !this.cities.length) return;

    const containing = this.cities.find((c) => {
      const polygon = c.boundary_polygon;
      return Array.isArray(polygon) && polygon.length >= 3
        ? this.pointInPolygon(this.pickup!.lat, this.pickup!.lng, polygon)
        : false;
    });

    // If no city has a polygon, fall back to the nearest configured city centre.
    // If at least one polygon exists and pickup is outside all of them, keep the
    // city unresolved so products stay hidden for an unsupported pickup area.
    const anyPolygon = this.cities.some((c) => Array.isArray(c.boundary_polygon) && c.boundary_polygon.length >= 3);
    const resolved = containing ?? (!anyPolygon ? this.nearestCityToPickup() : null);

    if (!resolved) {
      this.selectedCity = null;
      this.clearRideProducts();
      this.productsReady = true;
      this.maybeFinishHome();
      return;
    }

    if (resolved.id !== this.selectedCity?.id || resolved.id !== this.productsCityId) {
      this.selectedCity = resolved;
      this.productsReady = false;
      this.clearRideProducts();
      this.loadRideProducts(resolved.id);
      this.loadVehicleTypes();
    }
  }

  private nearestCityToPickup(): City | null {
    if (!this.pickup) return null;
    let best: City | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const city of this.cities) {
      if (city.center_lat == null || city.center_lng == null) continue;
      const km = this.distanceKm(this.pickup.lat, this.pickup.lng, Number(city.center_lat), Number(city.center_lng));
      if (km < bestKm) {
        bestKm = km;
        best = city;
      }
    }
    return best;
  }

  private clearRideProducts(): void {
    this.productKinds = [];
    this.scopeOptions = [];
    this.selectedScope = null;
    this.productsCityId = null;
  }

  /**
   * Fetch the city's enabled ride products — what powers the chips on the
   * idle screen. The DB holds the labels, descriptions and banners; the
   * client only contributes the Ionicon name (the DB stores banners, not
   * icon names).
   */
  private loadRideProducts(cityId: number): void {
    type ApiProduct = {
      kind: 'local' | 'outstation' | 'rental' | 'fixed' | 'shuttle';
      scope?: 'local' | 'outstation' | null;
      mode?: 'private' | 'fixed' | 'shuttle' | null;
      name: string;
      image_url: string | null;
    };
    type ApiScope = {
      scope: 'local' | 'outstation';
      name: string;
      modes: ApiProduct[];
    };
    this.api
      .get<{ data: ApiProduct[]; scopes?: ApiScope[] }>(`/pricing/cities/${cityId}/products`)
      .subscribe({
      next: (res) => {
        this.productsCityId = cityId;
        const rows = res?.data ?? [];
        this.productKinds = rows.map((p) => ({
          kind: p.kind,
          scope: p.scope ?? null,
          mode: p.mode ?? null,
          label: p.name,
          image_url: p.image_url,
          icon: this.iconForKind(p.kind),
        }));

        // Grouped tree for the two-step picker.
        this.scopeOptions = (res?.scopes ?? []).map((s) => ({
          scope: s.scope,
          label: s.name || (s.scope === 'outstation' ? 'Outstation' : 'Local'),
          icon: s.scope === 'outstation' ? 'airplane-outline' : 'location-outline',
          modes: (s.modes ?? []).map((m) => ({
            kind: m.kind,
            scope: m.scope ?? s.scope,
            mode: m.mode ?? null,
            label: m.name,
            image_url: m.image_url,
            icon: this.iconForKind(m.mode ?? m.kind),
          })),
        }));
        // Always start on the scope step (Local / Outstation) — the customer
        // picks a scope first, then its modes. Only drop a stale selection if
        // that scope no longer exists for this city.
        if (this.selectedScope && !this.scopeOptions.some((o) => o.scope === this.selectedScope)) {
          this.selectedScope = null;
        }

        // Snap the private selection to the first private product available.
        const firstPrivate = this.productKinds.find(
          (p) => p.kind === 'local' || p.kind === 'outstation' || p.kind === 'rental',
        );
        if (!this.productKinds.some((p) => p.kind === this.selectedProductKind) && firstPrivate) {
          this.selectedProductKind = firstPrivate.kind as 'local' | 'outstation' | 'rental';
        }
        this.productsReady = true;
        this.maybeFinishHome();
      },
      error: () => {
        this.clearRideProducts();
        this.productsReady = true;
        this.maybeFinishHome();
      },
    });
  }

  /**
   * The full-screen home skeleton stays until BOTH the map and the home data
   * (products) are ready, so the user never sees a half-loaded screen.
   */
  private maybeFinishHome(): void {
    if (this.productsReady && this.mapReady) this.finishHomeLoading();
  }

  /**
   * Hide the home skeleton once data is ready, keeping it visible for a short
   * minimum so it never flashes; the real content then reveals with animation.
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

  private iconForKind(kind: string): string {
    if (kind === 'outstation') return 'airplane-outline';
    if (kind === 'rental') return 'time-outline';
    if (kind === 'shuttle') return 'bus-outline';
    if (kind === 'fixed') return 'git-branch-outline';
    return 'car-outline';
  }

  private async initMap(): Promise<void> {
    try {
      await this.places.ensureLoaded();
      const div = document.getElementById('ride-map');
      if (!div) return;

      const fix = await this.geo.getCurrentPosition();
      const start = fix ?? { lat: 28.6139, lng: 77.209 };
      this.bookingCamera.clear();
      this.followBookingLocation = true;
      this.map = new google.maps.Map(div, {
        ...CUSTOMER_MAP_STYLE,
        center: start,
        disableDefaultUI: true,
        clickableIcons: false,
        // Required for AdvancedMarkerElement to render. DEMO_MAP_ID is
        // Google's public test id; replace with a styled mapId from the
        // Cloud Console when going to production.
        mapId: 'DEMO_MAP_ID',
      });
      this.map.addListener('dragstart', () => this.pauseBookingFollow());

      this.pickupMarker = new google.maps.marker.AdvancedMarkerElement({
        position: start,
        map: this.map,
        title: 'Pickup',
        gmpDraggable: true,
        content: this.buildPin('A', '#1f8b4c'),
      });

      // AdvancedMarkerElement fires a native DOM-style 'dragend' but exposes
      // the final position via .position (not the legacy ev.latLng helpers).
      this.pickupMarker.addListener('dragend', () => {
        const p = this.pickupMarker?.position;
        if (!p) return;
        const lat = typeof (p as any).lat === 'function' ? (p as any).lat() : (p as any).lat;
        const lng = typeof (p as any).lng === 'function' ? (p as any).lng() : (p as any).lng;
        void this.updatePickupTo(lat, lng);
      });

      this.map.addListener('click', (ev: any) => {
        if (this.state !== 'idle') return;
        const lat = ev.latLng.lat();
        const lng = ev.latLng.lng();
        this.pickupMarker.position = { lat, lng };
        void this.updatePickupTo(lat, lng);
      });

      const address = (await this.places.reverseGeocode(start.lat, start.lng)) ?? 'Current location';
      this.pickup = { lat: start.lat, lng: start.lng, address };
      this.resolveCityForPickup();
      this.mapsReady = true;

      if (this.selfMarker) this.selfMarker.map = null;
      this.selfMarker = null;
      if (fix) this.onSelfPosition(fix);
      void this.startSelfLocationStream();

      this.startNearbyDriversPoll();
      this.mapReady = true;
      this.maybeFinishHome();
    } catch (e) {
      this.mapsError = (e as Error)?.message || 'Could not load map.';
      // Don't trap the user behind the skeleton if the map fails to load.
      this.mapReady = true;
      this.maybeFinishHome();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Nearby drivers shown on the map (visual only)
  // ─────────────────────────────────────────────────────────────────

  private startNearbyDriversPoll(): void {
    if (this.nearbyPollHandle) return;
    void this.refreshNearbyDrivers();
    this.nearbyPollHandle = setInterval(() => this.refreshNearbyDrivers(), 5000);
  }

  private stopNearbyDriversPoll(): void {
    if (this.nearbyPollHandle) {
      clearInterval(this.nearbyPollHandle);
      this.nearbyPollHandle = null;
    }
    this.clearNearbyDriverMarkers();
  }

  private async refreshNearbyDrivers(): Promise<void> {
    if (!this.map || !this.pickup) return;
    try {
      const lat = this.pickup.lat;
      const lng = this.pickup.lng;
      const res: any = await this.api
        .get(`/drivers/nearby?lat=${lat}&lng=${lng}&radius_km=8&limit=30`)
        .toPromise();
      const drivers: { id: number; lat: number; lng: number; bearing_deg?: number | null }[] =
        res?.data ?? [];
      this.renderNearbyDrivers(drivers);
    } catch {
      // Silent — endpoint may not be available in dev.
    }
  }

  private renderNearbyDrivers(
    drivers: { id: number; lat: number; lng: number; bearing_deg?: number | null; map_marker_url?: string | null; vehicle?: any }[]
  ): void {
    if (!this.map) return;
    const seen = new Set<number>();
    for (const d of drivers) {
      seen.add(d.id);
      const pos = { lat: d.lat, lng: d.lng };
      const existing = this.nearbyDriverMarkers.get(d.id);
      if (existing) {
        existing.position = pos;
        if (d.bearing_deg != null) {
          updateCarMarkerBearing(existing, d.bearing_deg);
        }
        const markerUrl = d.map_marker_url || d.vehicle?.map_marker_url;
        if (markerUrl) {
          updateCarMarkerImage(existing, markerUrl);
        }
      } else {
        const marker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: 'Driver nearby',
          content: buildReusableCarMarkerElement({
            bearing: d.bearing_deg ?? 0,
            markerUrl: d.map_marker_url || d.vehicle?.map_marker_url,
          }),
          zIndex: 1,
        });
        this.nearbyDriverMarkers.set(d.id, marker);
      }
    }
    for (const [id, marker] of this.nearbyDriverMarkers) {
      if (!seen.has(id)) {
        marker.map = null;
        this.nearbyDriverMarkers.delete(id);
      }
    }
  }

  private clearNearbyDriverMarkers(): void {
    for (const marker of this.nearbyDriverMarkers.values()) {
      marker.map = null;
    }
    this.nearbyDriverMarkers.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // Live self-location ("you" dot follows the device on the home map)
  // ─────────────────────────────────────────────────────────────────

  /** Start streaming our GPS and move the "you" dot on every fix. Idempotent. */
  private async startSelfLocationStream(): Promise<void> {
    if (this.geoWatchId !== null) return;
    this.geoWatchId = await this.geo.watchPosition(
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
      (fix, err) => {
        if (err) {
          void this.stopSelfLocationStream();
          return;
        }
        if (fix) this.onSelfPosition(fix);
      },
    );
  }

  private async stopSelfLocationStream(): Promise<void> {
    if (this.geoWatchId !== null) {
      await this.geo.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }
  }

  /** Move (or create) the live "you" dot to the latest GPS fix. */
  private onSelfPosition(fix: GeoFix): void {
    const p = { lat: fix.lat, lng: fix.lng };
    this.selfPosition = p;
    if (!this.map) return;
    if (!this.selfMarker) {
      this.selfMarker = new google.maps.marker.AdvancedMarkerElement({
        position: p,
        map: this.map,
        title: 'You',
        content: buildPassengerMarkerElement({
          kind: 'pickup',
          avatarUrl: this.auth.resolveAvatarUrl(this.auth.getUser()),
        }),
        zIndex: 2,
      });
    }
    if (this.followBookingLocation && this.state === 'idle' && !this.drop) {
      this.bookingCamera.follow(this.map, p, null, this.selfMarker);
    } else {
      this.bookingCamera.clear();
      this.selfMarker.position = p;
    }
  }

  private pauseBookingFollow(): void {
    this.followBookingLocation = false;
    this.bookingCamera.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // Marker content builders — used by AdvancedMarkerElement
  // ─────────────────────────────────────────────────────────────────

  /** Letter pin (A = pickup, B = drop). Returns a styled DOM element. */
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

  /** Direction arrow used for nearby driver pins. CSS rotation = bearing°. */
  private buildArrow(bearingDeg: number, color: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;';
    const arrow = document.createElement('div');
    arrow.style.cssText = [
      `transform:rotate(${bearingDeg}deg)`,
      'width:0',
      'height:0',
      'border-left:6px solid transparent',
      'border-right:6px solid transparent',
      `border-bottom:14px solid ${color}`,
      'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
    ].join(';');
    wrap.appendChild(arrow);
    return wrap;
  }

  private async updatePickupTo(lat: number, lng: number): Promise<void> {
    this.pauseBookingFollow();
    const address = (await this.places.reverseGeocode(lat, lng)) ?? 'Selected location';
    this.pickup = { lat, lng, address };
    this.resolveCityForPickup();
    if (this.map) this.map.panTo({ lat, lng });
    if (this.drop) {
      await this.showRouteOnMap();
      await this.onRouteReady();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Geofence helpers
  // ─────────────────────────────────────────────────────────────────

  /** Ray-casting point-in-polygon (matches DynamicPricingService on the backend). */
  private pointInPolygon(lat: number, lng: number, polygon: { lat: number; lng: number }[]): boolean {
    if (!polygon || polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lng;
      const yi = polygon[i].lat;
      const xj = polygon[j].lng;
      const yj = polygon[j].lat;
      const intersect =
        yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  private distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const earthKm = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
      * Math.sin(dLng / 2) ** 2;
    return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Check whether the drop point lies inside the resolved city's polygon.
   * If a polygon isn't configured we conservatively treat the destination as
   * in-area (the backend stays the source of truth via the booking 422).
   */
  private isDropInsideServiceArea(): boolean {
    if (!this.drop || !this.selectedCity?.boundary_polygon) return true;
    return this.pointInPolygon(this.drop.lat, this.drop.lng, this.selectedCity.boundary_polygon);
  }

  // ─────────────────────────────────────────────────────────────────
  // State transitions
  // ─────────────────────────────────────────────────────────────────

  async centerMapToCurrentLocation(): Promise<void> {
    try {
      const pos = await this.geo.getCurrentPosition();
      if (pos) {
        if (this.pickupMarker) {
          this.pickupMarker.position = pos;
        }
        await this.updatePickupTo(pos.lat, pos.lng);
      }
    } catch {
      // Ignored
    }
  }

  /**
   * Pan the map back to the live "you" dot. Unlike centerMapToCurrentLocation,
   * this only moves the camera — it does NOT change the pickup. Uses the latest
   * watched position, falling back to a fresh fix if the stream hasn't ticked.
   */
  async recenterOnMe(): Promise<void> {
    let p = this.selfPosition;
    if (!p) p = await this.geo.getCurrentPosition();
    if (p && this.map) {
      this.map.panTo(p);
      if (this.map.getZoom && this.map.getZoom() < 15) this.map.setZoom(16);
    }
  }

  // Step 1 — pickup. Seed the pickup field with the detected current location.
  goPickup(): void {
    this.state = 'pickup';
    this.suggestions = [];
    this.pickupQuery = this.pickup?.address || '';
    this.activeSearchField = 'pickup';
    this.pickupError = null;
    this.dropError = null;
  }

  // Step 1 → 2 — validate pickup, move to the destination step.
  goDrop(): void {
    this.pickupError = null;
    if (!this.pickup) {
      this.pickupError = 'Pickup location is required';
      return;
    }
    this.state = 'drop';
    this.suggestions = [];
    this.toQuery = this.drop?.address || '';
    this.activeSearchField = 'drop';
    this.dropError = null;
    // If a destination is already chosen, show the black path right away.
    if (this.pickup && this.drop) void this.showRouteOnMap();
  }

  // Step 2 → 3 — validate drop, draw the route + price it, then show the ride
  // list so the customer picks a ride type BEFORE we search for drivers.
  goRideList(): void {
    this.dropError = null;
    if (!this.pickup) {
      this.goPickup();
      return;
    }
    if (!this.drop) {
      this.dropError = 'Please select a destination';
      return;
    }
    this.suggestions = [];
    this.state = 'ride-list';
    // Draw the road path, then price it off the real driven distance. The
    // estimate reflects the selected ride type and seeds the "name your price"
    // base fare. No driver search yet — that's step 4.
    void this.showRouteOnMap().then(() => this.fetchEstimate());
  }

  // Step 3 → 4 — start the expanding-circle driver search for the chosen ride
  // type so the customer sees who's around before naming a price.
  goFindDriver(): void {
    if (!this.pickup || !this.drop) {
      this.state = 'ride-list';
      return;
    }
    this.suggestions = [];
    this.state = 'find-driver';
    void this.discoverDrivers();
  }

  /**
   * Kick off the expanding-circle driver discovery for the current route so the
   * customer can SEE who's around before naming a price. Reuses searchDrivers()
   * (discovery mode: it finds + reveals drivers but never notifies them). Skips
   * the restart when the route hasn't changed since the last search.
   */
  private async discoverDrivers(): Promise<void> {
    if (!this.pickup || !this.drop) return;
    if (!this.estimate?.estimated_fare) return; // estimate not ready yet
    const key = `${this.pickup.lat},${this.pickup.lng}|${this.drop.lat},${this.drop.lng}|${this.selectedVehicleTypeId ?? 'all'}`;
    if (key === this.lastSearchKey && this.tripId && this.drivers.length) {
      return; // same route already searched — keep the list we already have
    }
    this.lastSearchKey = key;
    // Tear down any prior search subscription so the next search binds to the
    // NEW trip's channel (route changed → fresh trip), not the old one.
    if (this.unsubscribeRealtime) {
      this.unsubscribeRealtime();
      this.unsubscribeRealtime = null;
    }
    // Force a fresh trip for the new route. An un-offered prior search trip has
    // no customer offer, so it stays invisible to drivers and is harmless.
    this.tripId = null;
    await this.searchDrivers();
  }

  // Step 3 → 4 (Ride → Fare). The customer types their own price. The text box
  // starts EMPTY; minFare is filled from the backend negotiation config once we
  // have a trip id for this route.
  async goOffer(): Promise<void> {
    if (this.isShuttleSelected) {
      await this.createShuttleBooking();
      return;
    }
    this.offerAmount = null;
    this.error = null;
    this.minFare = 0;
    this.state = 'offer';
    this.loading = true;

    try {
      if (!this.tripId) {
        await this.createTrip();
      }
      await this.fetchNegotiationConfig();
    } catch (e: any) {
      this.error = e?.error?.message || e?.message || null;
    } finally {
      this.loading = false;
    }
  }

  /**
   * One-shot read of the route's negotiation config (min_amount) so the
   * below-floor validation is correct as soon as the customer reaches the price
   * step. Needs a trip; discovery creates one.
   */
  private async fetchNegotiationConfig(): Promise<void> {
    if (!this.tripId) return;
    const res = await this.api
      .get<{
        negotiation_config?: { min_amount?: number; floor_percent?: number; estimated_fare?: number };
      }>(`/trips/${this.tripId}/negotiation`)
      .toPromise();
    this.captureNegotiationConfig(res?.negotiation_config);
  }

  // "Send to drivers" — fire the customer's typed price into the dispatch ring.
  // The disabled send button is the primary guard; this re-checks the floor as
  // a backstop and refuses to send anything below minFare.
  async sendOffer(): Promise<void> {
    const amount = Number(this.offerAmount);
    if (!this.offerAmount || amount < this.minFare) {
      this.error = `You can't offer below ₹${this.minFare} — the minimum allowed offer is ₹${this.minFare}.`;
      return;
    }
    if (!amount || amount <= 0) {
      this.error = 'Enter a fare to offer.';
      return;
    }
    if (this.scheduleMode === 'later') {
      if (!this.scheduledAt) {
        this.error = 'Pick a date & time for your ride.';
        return;
      }
      await this.scheduleRide(amount);
      return;
    }
    await this.requestAutoDispatch(amount);
  }

  setScheduleMode(mode: 'now' | 'later'): void {
    this.scheduleMode = mode;
    this.error = null;
    if (mode === 'now') {
      this.scheduledAt = null;
    } else if (!this.minScheduleAt) {
      this.minScheduleAt = new Date().toISOString();
    }
  }

  /**
   * Book a future ride: create the trip with scheduled_at + record the customer's
   * offer, then confirm and send the customer to their Scheduled rides list. The
   * backend parks it and dispatches near pickup time (per the city's mode).
   */
  async scheduleRide(amount: number): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      if (!this.tripId) {
        await this.createTrip();
      }
      if (!this.tripId) throw new Error('Trip creation failed.');

      await this.api
        .post(`/trips/${this.tripId}/negotiation/customer-offer`, { amount })
        .toPromise();

      const toast = await this.toastCtrl.create({
        message: "Ride scheduled! We'll find you a driver near pickup time.",
        duration: 2600,
        color: 'success',
      });
      await toast.present();

      this.resetAfterSchedule();
      this.router.navigateByUrl('/customer-tabs/scheduled-rides');
    } catch (e: any) {
      this.error = e?.error?.message || e?.message || 'Could not schedule the ride.';
    } finally {
      this.loading = false;
    }
  }

  private resetAfterSchedule(): void {
    this.state = 'idle';
    this.tripId = null;
    this.scheduledAt = null;
    this.scheduleMode = 'now';
    this.offerAmount = null;
    this.lastSearchKey = null;
  }

  closeSheet(): void {
    if (this.state === 'waiting' || this.state === 'bids') return;
    this.state = 'idle';
  }

  onSearchInput(ev: any, field: 'pickup' | 'drop'): void {
    this.activeSearchField = field;
    const val = ev?.target?.value ?? '';
    if (field === 'pickup') {
      this.pickupQuery = val;
      this.pickupError = null;
    } else {
      this.toQuery = val;
      this.dropError = null;
    }
    this.toQuery$.next(val);
  }

  swapLocations(): void {
    if (!this.pickup || !this.drop) return;
    const temp = { ...this.pickup };
    this.pickup = { lat: this.drop.lat, lng: this.drop.lng, address: this.drop.address };
    this.drop = { lat: temp.lat, lng: temp.lng, address: temp.address, place_id: undefined };
    
    this.toQuery = this.drop.address;
    this.pickupQuery = this.pickup.address;
    this.resolveCityForPickup();
    
    void this.showRouteOnMap();
    if (this.state === 'find-driver') {
      void this.onRouteReady();
    }
  }

  async pickSuggestion(s: PlaceSuggestion): Promise<void> {
    this.loading = true;
    try {
      const detail = await this.places.getPlaceDetail(s.place_id);
      if (!detail) return;
      
      if (this.activeSearchField === 'pickup') {
         this.pickup = {
           lat: detail.lat,
           lng: detail.lng,
           address: detail.description
         };
         this.pickupQuery = detail.description;
         this.pickupError = null;
         this.resolveCityForPickup();
      } else {
         this.drop = {
           lat: detail.lat,
           lng: detail.lng,
           address: detail.description,
           place_id: detail.place_id,
         };
         this.toQuery = detail.description;
         this.dropError = null;
      }
      this.suggestions = [];
      // Draw the black path as soon as both ends are known (e.g. on the drop
      // step) so the customer sees the route before reaching step 3.
      if (this.pickup && this.drop) void this.showRouteOnMap();
    } finally {
      this.loading = false;
    }
  }

  /** Ionicon name for a saved place — uses its stored icon, else maps the label. */
  savedIcon(p: SavedPlace): string {
    if (p.icon) return p.icon;
    const l = (p.label || '').toLowerCase();
    if (l === 'home') return 'home';
    if (l === 'work' || l === 'office') return 'briefcase';
    return 'location';
  }

  /**
   * Open the full saved-locations list for the given step. We remember which
   * field opened it via activeSearchField so picking a place returns to the
   * exact step ('pickup' / 'drop') the customer came from.
   */
  openSavedPicker(field: 'pickup' | 'drop'): void {
    this.activeSearchField = field;
    this.suggestions = [];
    this.state = 'saved-select';
  }

  /** Pick a saved place from the picker, then return to the step it was opened from. */
  pickSavedPlaceAndReturn(p: SavedPlace): void {
    const field = this.activeSearchField;
    this.pickSavedPlace(p, field);
    // The 'pickup' / 'drop' field values map 1:1 to their step states.
    this.state = field;
  }

  /** One-tap fill of pickup/drop from a saved place — mirrors pickSuggestion. */
  pickSavedPlace(p: SavedPlace, field: 'pickup' | 'drop'): void {
    if (field === 'pickup') {
      this.pickup = { lat: p.lat, lng: p.lng, address: p.address };
      this.pickupQuery = p.address;
      this.pickupError = null;
      this.resolveCityForPickup();
    } else {
      this.drop = { lat: p.lat, lng: p.lng, address: p.address, place_id: undefined };
      this.toQuery = p.address;
      this.dropError = null;
    }
    this.suggestions = [];
    if (this.pickup && this.drop) void this.showRouteOnMap();
  }

  async setPickupCurrentLocation(): Promise<void> {
    const pos = await this.geo.getCurrentPosition();
    if (pos) {
      if (this.pickupMarker) {
        this.pickupMarker.position = pos;
      }
      await this.updatePickupTo(pos.lat, pos.lng);
      this.pickupQuery = this.pickup?.address || '';
      this.pickupError = null;
    }
  }

  setLocationOnMap(): void {
    this.state = 'map-select';
    const loc = this.activeSearchField === 'pickup' ? this.pickup : this.drop;
    if (loc && this.map) {
      this.map.panTo({ lat: loc.lat, lng: loc.lng });
    }
  }

  async confirmMapLocation(): Promise<void> {
    if (!this.map) return;
    this.loading = true;
    try {
      const center = this.map.getCenter();
      const lat = center.lat();
      const lng = center.lng();
      const address = await this.places.reverseGeocode(lat, lng) ?? 'Selected on map';
      
      if (this.activeSearchField === 'pickup') {
        this.pickup = { lat, lng, address };
        this.pickupQuery = address;
        this.pickupError = null;
        if (this.pickupMarker) {
          this.pickupMarker.position = { lat, lng };
        }
      } else {
        this.drop = { lat, lng, address, place_id: undefined };
        this.toQuery = address;
        this.dropError = null;
      }
      this.state = this.activeSearchField === 'pickup' ? 'pickup' : 'drop';
      if (this.pickup && this.drop) void this.showRouteOnMap();
    } catch {
      // Ignored
    } finally {
      this.loading = false;
    }
  }

  cancelMapSelection(): void {
    this.state = this.activeSearchField === 'pickup' ? 'pickup' : 'drop';
  }

  /**
   * Product card tap. Fixed opens the dedicated fixed-booking flow. Dynamic
   * Shuttle stays disabled until its roadmap API/app flow is implemented.
   * Private products (local/outstation/rental) stay in this metered flow.
   */
  onSelectProduct(p: { kind: string; scope: 'local' | 'outstation' | null; mode: 'private' | 'fixed' | 'shuttle' | null }): void {
    const isFixed = p.mode === 'fixed' || p.kind === 'fixed';
    const isShuttle = p.mode === 'shuttle' || p.kind === 'shuttle';
    if (isFixed) {
      const cityId = this.selectedCity?.id;
      if (!cityId) return;
      void this.router.navigate(['/fixed-book'], {
        queryParams: { city_id: cityId, scope: p.scope ?? '', mode: p.mode ?? p.kind },
      });
      return;
    }
    if (isShuttle) {
      this.selectShuttleProduct(p.scope === 'outstation' ? 'outstation' : 'local');
      return;
    }
    this.selectProductKind(p.kind as 'local' | 'outstation' | 'rental');
  }

  private async showPlannedShuttleToast(): Promise<void> {
    const toast = await this.toastCtrl.create({
      message: 'Dynamic Shuttle is planned and not active yet.',
      duration: 2200,
      position: 'bottom',
    });
    await toast.present();
  }

  /** The modes available under the scope the customer picked in step 1. */
  get currentModes() {
    return this.scopeOptions.find((o) => o.scope === this.selectedScope)?.modes ?? [];
  }

  /** Step 1: pick a scope (Local / Outstation); preselect its private mode if any. */
  isSelectedMode(p: { kind: string; scope: 'local' | 'outstation' | null; mode: 'private' | 'fixed' | 'shuttle' | null }): boolean {
    if (p.mode === 'shuttle' || p.kind === 'shuttle') {
      return this.selectedServiceMode === 'shuttle' && p.scope === this.selectedScope;
    }
    return this.selectedServiceMode === 'private' && p.mode === 'private' && p.scope === this.selectedProductKind;
  }

  get isShuttleSelected(): boolean {
    return this.selectedServiceMode === 'shuttle';
  }

  /** Fare shown in the shared payment sheet for a Shuttle booking. */
  get shuttlePayableAmount(): number {
    return Number(this.estimate?.estimated_fare ?? 0);
  }

  get shuttleQuoteNotice(): string {
    if (!this.isShuttleSelected) return '';
    if (!this.estimate) return 'Select a Shuttle vehicle to preview the fare.';
    if (this.estimate.available === false) return this.estimate.message || 'Shuttle is not available for this vehicle yet.';
    return 'Confirm to create a Shuttle booking and pay with Razorpay.';
  }

  get rideListContinueLabel(): string {
    return this.isShuttleSelected ? 'Confirm Shuttle' : 'Set your fare';
  }

  /**
   * The payment fee to show on the quote, or null when there's nothing to say —
   * the operator has it switched off, or the quote predates the field. Null is
   * the signal to render the fare alone, exactly as before the fee existed.
   */
  get gatewayFee(): number | null {
    const g = this.estimate?.gateway_fee;
    return g?.enabled && (g.fee ?? 0) > 0 ? (g.fee ?? 0) : null;
  }

  /** Fare + fee — what the customer will actually be charged paying by UPI. */
  get gatewayTotal(): number | null {
    const g = this.estimate?.gateway_fee;
    return this.gatewayFee === null ? null : (g?.total ?? null);
  }

  /**
   * The caveat under the fee line. The exact fee isn't knowable until checkout,
   * where the customer picks a method, so we name the assumption rather than
   * quietly quoting the cheapest case.
   */
  get gatewayFeeNote(): string {
    const g = this.estimate?.gateway_fee;
    if (this.gatewayFee === null) return '';
    if (!g?.varies) return 'Charged by the payment provider.';
    return `Paying by UPI or card. Up to ₹${(g.max_fee ?? 0).toFixed(2)} on Amex, EMI or international cards.`;
  }

  pickScope(scope: 'local' | 'outstation'): void {
    this.selectedScope = scope;
    const opt = this.scopeOptions.find((o) => o.scope === scope);
    if (opt?.modes.some((m) => m.mode === 'private')) {
      this.selectProductKind(scope);
    }
  }

  /** Back to step 1 (scope chooser). */
  clearScope(): void {
    this.selectedScope = null;
  }

  selectProductKind(kind: 'local' | 'outstation' | 'rental'): void {
    this.selectedServiceMode = 'private';
    this.selectedProductKind = kind;
    // Keep the two-step picker in sync when the kind changes programmatically
    // (e.g. the auto-switch to Outstation when a drop falls outside the area).
    // 'rental' is a legacy outstation-style kind, so it maps to the Outstation scope.
    this.selectedScope = kind === 'outstation' || kind === 'rental' ? 'outstation' : 'local';
    // User accepted the suggested kind — drop the banner.
    if (this.outsideServiceAreaNotice && kind !== 'local') {
      this.outsideServiceAreaNotice = null;
    }
    if (kind === 'outstation') {
      void this.loadOutstationPackages();
    } else {
      this.outstationPackages = [];
      this.selectedPackageId = null;
      void this.fetchEstimate();
    }
  }

  selectShuttleProduct(scope: 'local' | 'outstation'): void {
    this.selectedServiceMode = 'shuttle';
    this.selectedScope = scope;
    this.selectedProductKind = scope;
    this.outstationPackages = [];
    this.selectedPackageId = null;
    this.tripId = null;
    this.drivers = [];
    void this.fetchEstimate();
  }

  selectRideType(id: number): void {
    this.selectedRideTypeId = id;
    void this.refreshDriverList();
    if (this.selectedProductKind === 'outstation') {
      void this.loadOutstationPackages();
    } else {
      void this.fetchEstimate();
    }
  }

  selectPaymentMode(mode: 'cash' | 'razorpay'): void {
    this.selectedPaymentMode = mode;
    this.tripId = null;
  }

  selectPackage(id: number): void {
    this.selectedPackageId = id;
    void this.fetchEstimate();
  }

  /** Loads the outstation packages for the current city + ride type. */
  private async loadOutstationPackages(): Promise<void> {
    const cityId = this.selectedCity?.id;
    if (!cityId || this.selectedRideTypeId == null) {
      this.outstationPackages = [];
      this.selectedPackageId = null;
      await this.fetchEstimate();
      return;
    }
    try {
      const res = await this.api
        .get<{ data: { id: number; name: string }[] }>(
          `/pricing/outstation-packages?city_id=${cityId}&ride_type_id=${this.selectedRideTypeId}`,
        )
        .toPromise();
      this.outstationPackages = res?.data ?? [];
      if (!this.outstationPackages.some((p) => p.id === this.selectedPackageId)) {
        this.selectedPackageId = this.outstationPackages[0]?.id ?? null;
      }
    } catch {
      this.outstationPackages = [];
      this.selectedPackageId = null;
    }
    await this.fetchEstimate();
  }

  /**
   * Single entry point called whenever pickup+drop are both known. Runs the
   * service-area check, auto-calculates the fare, and (re)loads the list of
   * drivers the customer can pick from.
   */
  private async onRouteReady(): Promise<void> {
    if (!this.pickup || !this.drop) return;

    if (!this.isDropInsideServiceArea()) {
      this.outsideServiceAreaNotice =
        'You have selected a location outside this service area. Switching to Outstation.';
      this.selectedProductKind = 'outstation';
      // Keep the two-step picker in sync (set inline rather than via
      // selectProductKind, which would clear the notice we just set).
      this.selectedScope = 'outstation';
    } else {
      this.outsideServiceAreaNotice = null;
    }

    await this.fetchEstimate();
    await this.refreshDriverList();
  }

  // ─────────────────────────────────────────────────────────────────
  // Map drawing
  // ─────────────────────────────────────────────────────────────────

  private async showRouteOnMap(): Promise<void> {
    if (!this.map || !this.pickup || !this.drop) return;

    if (this.dropMarker) this.dropMarker.map = null;
    this.dropMarker = new google.maps.marker.AdvancedMarkerElement({
      position: { lat: this.drop.lat, lng: this.drop.lng },
      map: this.map,
      title: 'Drop',
      content: this.buildPin('B', '#c0392b'),
    });

    // Clear any polylines from a previous destination
    for (const pl of this.routePolylines) pl.setMap?.(null);
    this.routePolylines = [];
    this.routeDistanceKm = null;
    this.routeTimeMin = null;
    this.tollAmount = null;

    const origin = { lat: this.pickup.lat, lng: this.pickup.lng };
    const destination = { lat: this.drop.lat, lng: this.drop.lng };

    // 1) New Routes API — exact road geometry + real driven distance. Needs
    //    the "Routes API (New)" enabled on the Maps key.
    try {
      const { Route } = await (google.maps as any).importLibrary('routes');
      const { routes } = await Route.computeRoutes({
        // origin/destination accept a plain LatLngLiteral ({lat,lng}).
        origin,
        destination,
        travelMode: google.maps.TravelMode.DRIVING,
        // 'travelAdvisory' + extraComputations TOLLS ask Google for the toll on
        // this route. Google only fills it in where it has toll prices (it does
        // not for many regions), so a blank simply leaves the toll at null.
        fields: ['legs', 'path', 'distanceMeters', 'durationMillis', 'travelAdvisory'],
        extraComputations: ['TOLLS'],
        routeModifiers: { vehicleInfo: { emissionType: 'GASOLINE' } },
      });
      const route = routes?.[0];
      if (route) {
        const distMeters = route.distanceMeters ?? route.legs?.[0]?.distanceMeters;
        this.routeDistanceKm = typeof distMeters === 'number' ? distMeters / 1000 : null;
        const ms = route.durationMillis ?? route.legs?.[0]?.durationMillis;
        this.routeTimeMin = typeof ms === 'number' ? ms / 60000 : null;
        this.tollAmount = this.readGoogleToll(route);
        console.log('[route] computed via Routes API (no polyline rendered) — km=', this.routeDistanceKm, 'toll=', this.tollAmount);
        this.frameRoute(origin, destination);
        return;
      }
    } catch (e) {
      console.warn('[route] Routes API unavailable — trying DirectionsService', e);
    }

    // 2) Legacy DirectionsService — also follows roads; needs "Directions API".
    try {
      const svc = new google.maps.DirectionsService();
      const res: any = await svc.route({
        origin,
        destination,
        travelMode: google.maps.TravelMode.DRIVING,
      });
      const r = res?.routes?.[0];
      if (r) {
        const leg = r.legs?.[0];
        this.routeDistanceKm = leg?.distance?.value != null ? leg.distance.value / 1000 : null;
        this.routeTimeMin = leg?.duration?.value != null ? leg.duration.value / 60 : null;
        console.log('[route] computed via DirectionsService (no polyline rendered) — km=', this.routeDistanceKm);
        this.frameRoute(origin, destination);
        return;
      }
    } catch (e) {
      console.warn('[route] DirectionsService unavailable — framing without polyline', e);
    }

    // 3) Fallback — frame route without drawing polyline
    this.frameRoute(origin, destination);
  }

  /**
   * Pull the toll for a route out of Google's Routes API response, in rupees.
   * `travelAdvisory.tollInfo.estimatedPrice` is an array of Money objects (one
   * per currency: { currencyCode, units, nanos }); we take the INR one (or the
   * only one). Returns null when Google reports no toll for the route — which is
   * the common case in regions Google doesn't price tolls for.
   */
  private readGoogleToll(route: any): number | null {
    const prices = route?.travelAdvisory?.tollInfo?.estimatedPrice;
    if (!Array.isArray(prices) || !prices.length) return null;
    const money = prices.find((p: any) => p?.currencyCode === 'INR') ?? prices[0];
    if (!money) return null;
    const rupees = Number(money.units ?? 0) + Number(money.nanos ?? 0) / 1e9;
    return Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) / 100 : null;
  }

  /** Fit the map so the whole pickup→drop route is visible. */
  private frameRoute(a: { lat: number; lng: number }, b: { lat: number; lng: number }): void {
    if (!this.map) return;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(a);
    bounds.extend(b);
    fitCustomerMap(this.map, bounds, 90);
  }

  /**
   * Best-effort extraction of seconds from whatever shape the new Routes API
   * returns for `duration` — has been seen as `{seconds: number}`, ISO
   * "1234s" strings, or plain numbers depending on the runtime.
   */
  private parseDurationSeconds(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const m = /^(\d+(?:\.\d+)?)s?$/.exec(value);
      return m ? Number(m[1]) : null;
    }
    if (typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const s = v['seconds'];
      if (typeof s === 'number') return s;
      if (typeof s === 'string') return Number(s);
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Pricing
  // ─────────────────────────────────────────────────────────────────

  private async fetchEstimate(): Promise<void> {
    if (!this.pickup || !this.drop) return;
    const cityId = this.selectedCity?.id;
    if (!cityId) return;

    try {
      if (this.isShuttleSelected) {
        const res = await this.api
          .post<EstimateResponse>('/shuttle/quote', {
            city_id: cityId,
            vehicle_type_id: this.selectedVehicleTypeId,
            scope: this.selectedScope || (this.selectedProductKind === 'outstation' ? 'outstation' : 'local'),
            pickup_lat: this.pickup.lat,
            pickup_lng: this.pickup.lng,
            drop_lat: this.drop.lat,
            drop_lng: this.drop.lng,
            route_distance_km: this.routeDistanceKm,
            route_time_min: this.routeTimeMin,
            toll_amount: this.tollAmount,
          })
          .toPromise();
        this.estimate = res ?? null;
        return;
      }

      // The customer no longer picks a vehicle — the server resolves the
      // city's default vehicle for the fare baseline. ride_type_id is only
      // sent for outstation/rental so an outstation rate card is used.
      const res = await this.api
        .post<EstimateResponse>('/pricing/estimate', {
          city_id: cityId,
          // null = "All" → server prices the city's default vehicle.
          vehicle_type_id: this.selectedVehicleTypeId,
          ride_type_id:
            this.selectedProductKind !== 'local' ? this.selectedRideTypeId : null,
          outstation_package_id:
            this.selectedProductKind === 'outstation' ? this.selectedPackageId : null,
          pickup_lat: this.pickup.lat,
          pickup_lng: this.pickup.lng,
          drop_lat: this.drop.lat,
          drop_lng: this.drop.lng,
          route_distance_km: this.routeDistanceKm,
          route_time_min: this.routeTimeMin,
          toll_amount: this.tollAmount,
        })
        .toPromise();
      this.estimate = res ?? null;
    } catch (e: any) {
      this.estimate = this.isShuttleSelected && e?.error ? e.error : null;
    }
  }

  private async createShuttleBooking(): Promise<void> {
    if (!this.pickup || !this.drop) {
      this.state = "ride-list";
      return;
    }
    const cityId = this.selectedCity?.id;
    if (!cityId) {
      this.error = "Pickup is outside the service area.";
      return;
    }
    if (this.estimate?.available === false) {
      this.error = this.estimate.message || "Shuttle is not available for this vehicle yet.";
      return;
    }

    // Pick a payment method first (Online / GPay / Cash), then book + pay.
    this.error = null;
    this.shuttlePaymentModalOpen = true;
  }

  /** Chosen from the shared payment sheet — book the shuttle seat tagged with
   *  the method (cash charges only the deposit online), then run its payment. */
  onShuttlePayMethod(method: PaymentChoice): void {
    this.shuttlePaymentModalOpen = false;
    void this.bookAndPayShuttle(method);
  }

  private async bookAndPayShuttle(method: PaymentChoice): Promise<void> {
    if (!this.pickup || !this.drop) { this.state = "ride-list"; return; }
    const cityId = this.selectedCity?.id;
    if (!cityId) { this.error = "Pickup is outside the service area."; return; }

    this.loading = true;
    this.error = null;
    try {
      const res = await this.api
        .post<ShuttleBookingResponse>("/shuttle/bookings", {
          city_vehicle_type_id: this.estimate?.city_vehicle_type_id ?? null,
          city_id: cityId,
          vehicle_type_id: this.selectedVehicleTypeId,
          scope: this.selectedScope || (this.selectedProductKind === 'outstation' ? 'outstation' : 'local'),
          pickup_address: this.pickup.address,
          pickup_lat: this.pickup.lat,
          pickup_lng: this.pickup.lng,
          drop_address: this.drop.address,
          drop_lat: this.drop.lat,
          drop_lng: this.drop.lng,
          route_distance_km: this.routeDistanceKm,
          route_time_min: this.routeTimeMin,
          toll_amount: this.tollAmount,
          payment_method: method === 'cash' ? 'cash' : 'razorpay',
        }, { "Idempotency-Key": this.uuid("shuttle") })
        .toPromise();

      if (!res?.booking?.id) {
        throw new Error("Shuttle booking was created but the booking id was missing.");
      }
      await this.api.post(`/shuttle/bookings/${res.booking.id}/request-driver`, {}).toPromise();
      await this.router.navigateByUrl('/customer-tabs/shuttle-rides');
    } catch (e: any) {
      this.error = e?.error?.message || e?.message || "Could not create Shuttle booking.";
    } finally {
      this.loading = false;
    }
  }

  private async startShuttleRazorpayPayment(booking: ShuttleBooking, method: PaymentChoice = 'online'): Promise<void> {
    if (typeof Razorpay === "undefined") {
      this.error = "Payment library not loaded. Check your connection.";
      return;
    }

    let order: ShuttleRazorpayOrder;
    try {
      order = (await this.api
        .post<ShuttleRazorpayOrder>("/shuttle/bookings/" + booking.id + "/razorpay-order", {}, { "Idempotency-Key": this.uuid("shuttle-pay") })
        .toPromise()) as ShuttleRazorpayOrder;
    } catch (e: any) {
      this.error = e?.error?.message || "Could not start Shuttle payment.";
      return;
    }

    const user = this.auth.getUser();
    const rzp = new Razorpay({
      key: order.razorpay.key_id,
      order_id: order.razorpay.order_id,
      amount: order.razorpay.amount_paise,
      currency: order.razorpay.currency,
      name: "DreamCabs",
      description: "Shuttle booking " + booking.id,
      prefill: {
        name: user?.name || "",
        email: user?.email || "",
        contact: user?.phone || "",
        // GPay → open Razorpay straight on UPI (still lets the user switch).
        ...(method === 'gpay' ? { method: 'upi' } : {}),
      },
      ...(method === 'gpay'
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
      theme: { color: "#000000" },
      handler: (resp: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        void this.confirmShuttlePayment(booking, resp);
      },
      modal: {
        ondismiss: async () => {
          const toast = await this.toastCtrl.create({
            message: "Payment cancelled. Your Shuttle booking is still pending payment.",
            duration: 3000,
            color: "warning",
          });
          await toast.present();
        },
      },
    });

    rzp.on("payment.failed", async (resp: any) => {
      const toast = await this.toastCtrl.create({
        message: resp?.error?.description || "Payment failed.",
        duration: 3000,
        color: "danger",
      });
      await toast.present();
    });

    rzp.open();
  }

  private async confirmShuttlePayment(booking: ShuttleBooking, payment: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const res = await this.api
        .post<ShuttleBookingResponse>("/shuttle/bookings/" + booking.id + "/confirm-payment", payment, { "Idempotency-Key": this.uuid("shuttle-confirm") })
        .toPromise();
      const toast = await this.toastCtrl.create({
        message: res?.message || "Shuttle booking payment confirmed.",
        duration: 2200,
        color: "success",
      });
      await toast.present();

      const tripId = res?.booking?.trip_id;
      if (tripId) {
        await this.router.navigateByUrl(`/customer-tabs/trip/${tripId}`, { replaceUrl: true });
        return;
      }

      this.resetToIdle();
    } catch (e: any) {
      this.error = e?.error?.message || "Payment verification failed.";
    } finally {
      this.loading = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Driver list (preview sheet) — customer picks one of these
  // ─────────────────────────────────────────────────────────────────

  /**
   * Loads the candidate driver list for this booking. The /trips/{id}/nearby-drivers
   * endpoint needs a trip, so we create one lazily here (idempotent: re-uses
   * tripId if it already exists from a previous load).
   */
  private async refreshDriverList(): Promise<void> {
    if (!this.pickup || !this.drop) return;
    this.loadingDrivers = true;
    try {
      if (!this.tripId) {
        await this.createTrip();
      }
      if (!this.tripId) return;

      const res = await this.api
        .get<{ data: NearbyDriver[] }>(`/trips/${this.tripId}/nearby-drivers?radius_km=8&limit=20`)
        .toPromise();
      this.drivers = res?.data ?? [];
    } catch (e: any) {
      this.drivers = [];
      this.error = e?.error?.message || null;
    } finally {
      this.loadingDrivers = false;
    }
  }

  private startDriverListPoll(): void {
    if (this.driversPollHandle) return;
    this.driversPollHandle = setInterval(() => this.refreshDriverList(), 6000);
  }

  private stopDriverListPoll(): void {
    if (this.driversPollHandle) {
      clearInterval(this.driversPollHandle);
      this.driversPollHandle = null;
    }
  }

  private async createTrip(): Promise<void> {
    if (!this.pickup || !this.drop) return;
    const cityId = this.selectedCity?.id;
    if (!cityId) throw new Error('Pickup is outside the service area.');

    const tripRes = await this.api
      .post<{ trip: { id: number } }>('/trips', {
        city_id: cityId,
        // Vehicle type the customer chose on the find-driver step. null = "All"
        // → the trip stays open to any-vehicle drivers; a specific id makes the
        // search (and the driver list) match only that vehicle type.
        vehicle_type_id: this.selectedVehicleTypeId,
        ride_type_id:
          this.selectedProductKind !== 'local' ? this.selectedRideTypeId : null,
        outstation_package_id:
          this.selectedProductKind === 'outstation' ? this.selectedPackageId : null,
        pickup_address: this.pickup.address,
        pickup_lat: this.pickup.lat,
        pickup_lng: this.pickup.lng,
        drop_address: this.drop.address,
        drop_lat: this.drop.lat,
        drop_lng: this.drop.lng,
        route_distance_km: this.routeDistanceKm,
        route_time_min: this.routeTimeMin,
        // Set when the customer chose "schedule for later"; null = ride now.
        scheduled_at: this.scheduledAt,
        // Payment mode is chosen at the END of the trip now, not at booking.
        // Coupons are redeemed on the post-trip payment screen, not here.
        payment_method: null,
        // "Book a ride for a friend / family" — the booker still owns + pays the
        // trip; these tell the driver who to pick up + call.
        is_for_other: this.bookingForOther,
        booked_for_name: this.bookingForOther ? (this.bookedForName.trim() || null) : null,
        booked_for_phone: this.bookingForOther && this.bookedForPhone
          ? '+' + this.bookedForCountryCode + this.bookedForPhone.replace(/\D/g, '')
          : null,
      })
      .toPromise();
    this.tripId = tripRes?.trip?.id ?? null;
  }

  // ----- "Book for a friend / family" helpers -------------------------------

  /** Keep the friend's phone box digits-only and capped at 10. */
  onBookedForPhoneInput(): void {
    this.bookedForPhone = (this.bookedForPhone || '').replace(/\D/g, '').slice(0, 10);
  }

  /** Split a raw contact number into a dial code + local 10-digit number. */
  private splitFriendPhone(raw: string): { code: string; local: string } {
    let p = (raw || '').replace(/[\s\-()]/g, '');
    if (p.startsWith('+91')) return { code: '91', local: p.slice(3).replace(/\D/g, '').slice(-10) };
    if (p.startsWith('0')) p = p.slice(1);
    if (p.length > 10 && p.startsWith('91')) return { code: '91', local: p.slice(2).slice(-10) };
    return { code: this.bookedForCountryCode || '91', local: p.replace(/\D/g, '').slice(-10) };
  }

  /**
   * Open the phone's native contact picker to fill the friend's name + number.
   * The plugin rejects unless the Contacts permission is granted (Android and
   * iOS alike), so request it first and explain instead of a generic failure.
   */
  async pickBookedForContact(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      await this.contactPickerToast('Picking from contacts only works in the installed app — please type the details manually.');
      return;
    }
    try {
      const status = await Contacts.requestPermissions();
      if (status.contacts !== 'granted' && status.contacts !== 'limited') {
        await this.contactPickerToast('Contacts permission is blocked. Allow Contacts for this app in your phone Settings, then try again.');
        return;
      }
      const res = await Contacts.pickContact({ projection: { name: true, phones: true } });
      const c = res?.contact;
      if (!c) return; // cancelled
      const rawPhone = c.phones?.find((p) => p.number)?.number ?? '';
      const { code, local } = this.splitFriendPhone(rawPhone);
      this.bookingForOther = true;
      this.bookedForName = c.name?.display ?? this.bookedForName;
      this.bookedForCountryCode = code;
      this.bookedForPhone = local;
    } catch {
      await this.contactPickerToast('Could not open the contacts picker on this device.');
    }
  }

  private async contactPickerToast(message: string): Promise<void> {
    const t = await this.toastCtrl.create({ message, duration: 3000, color: 'warning' });
    await t.present();
  }


  /**
   * Auto-dispatch: POST /customer-offer instead of locking to one specific
   * driver. Backend fires DispatchHopJob which expands the search radius
   * each `hop_interval_sec` and broadcasts DispatchRingExpanded events for
   * the map circle animation. First driver in the ring to accept wins.
   */
  async requestAutoDispatch(amount: number): Promise<void> {
    if (!amount || amount <= 0) {
      this.error = 'Enter a fare to offer.';
      return;
    }

    this.loading = true;
    this.error = null;
    try {
      if (!this.tripId) {
        await this.createTrip();
      }
      if (!this.tripId) throw new Error('Trip creation failed.');

      // Close the review modal if it was open.
      this.showReviewModal = false;

      await this.api
        .post(`/trips/${this.tripId}/negotiation/customer-offer`, { amount })
        .toPromise();

      this.selectedDriverId = null;
      this.stopDriverListPoll();
      this.startWaitingForDriver(amount);
    } catch (e: any) {
      this.error = e?.error?.message || e?.message || 'Could not start search.';
    } finally {
      this.loading = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Waiting for the chosen driver to act
  // ─────────────────────────────────────────────────────────────────

  private startWaitingForDriver(amount: number): void {
    // Clear timers from any previous round (e.g. when the customer bargains
    // back and re-broadcasts) so we never stack duplicate intervals.
    if (this.searchTimer) clearInterval(this.searchTimer);
    if (this.findAnotherTimeoutHandle) clearTimeout(this.findAnotherTimeoutHandle);
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.state = 'waiting';
    this.driverOffers = [];
    this.searchSecondsLeft = 60;
    this.showFindAnother = false;
    this.searchTimer = setInterval(() => {
      this.searchSecondsLeft = Math.max(0, this.searchSecondsLeft - 1);
      if (this.searchSecondsLeft <= 0) clearInterval(this.searchTimer);
    }, 1000);

    // Escape hatch: if the chosen driver hasn't accepted/countered within 60s,
    // show "Find another driver". Cleared on success in cleanupSearch().
    this.findAnotherTimeoutHandle = setTimeout(() => {
      if (this.state === 'waiting' && !this.driverOffers.length) {
        this.showFindAnother = true;
      }
    }, 60_000);

    // searchDrivers() may have already opened the negotiation subscription
    // for the ring broadcasts — reuse it instead of double-binding.
    if (this.tripId && !this.unsubscribeRealtime) {
      this.unsubscribeRealtime = this.realtime.subscribeNegotiation(
        this.tripId,
        (p) => this.onIncomingOffer(p.offer),
        () => this.onLocked(),
        (p) => this.onDispatchRing(p)
      );
    }

    this.pollHandle = setInterval(() => this.pollNegotiation(), 4000);
  }

  /**
   * Backend just expanded the search ring. Update the UI panel, animate
   * the Google Maps Circle from its current radius up to the new one, and
   * merge any newly-discovered drivers into the selectable list.
   */
  private onDispatchRing(p: DispatchRingExpandedPayload): void {
    // eslint-disable-next-line no-console
    console.log('[dispatch-ring] hop=' + p.hop + '/' + p.max_hops + ' radius=' + p.radius_m + ' eligible_count=' + p.eligible_drivers + ' drivers=' + (p.drivers?.length ?? 0) + ' payload=', p);
    this.dispatchRing = {
      hop: p.hop,
      max_hops: p.max_hops,
      radius_m: p.radius_m,
      eligible: p.eligible_drivers,
      hop_interval_sec: p.hop_interval_sec,
    };
    this.updateSearchCircle(p.radius_m, p.hop_interval_sec * 1000);

    // Merge discovered drivers (discovery mode payload). Dedupe by driver_id.
    if (Array.isArray(p.drivers) && p.drivers.length > 0) {
      const existingIds = new Set(this.drivers.map((d) => d.driver_id));
      const newlyAdded: NearbyDriver[] = [];
      for (const d of p.drivers) {
        if (d.driver_id != null && !existingIds.has(d.driver_id)) {
          const entry = {
            driver_id: d.driver_id,
            name: d.name ?? 'Driver',
            vehicle: typeof d.vehicle === 'object' && d.vehicle !== null
              ? d.vehicle
              : (d.vehicle ? { brand: d.vehicle, model: '', color: '', map_marker_url: d.map_marker_url } : null),
            map_marker_url: d.map_marker_url || d.vehicle?.map_marker_url || null,
            image_url: d.image_url || d.vehicle?.image_url || null,
            distance_km: d.distance_km ?? 0,
            eta_min: null,
            rating_avg: null,
            lat: d.lat ?? 0,
            lng: d.lng ?? 0,
          } as any;
          this.drivers.push(entry);
          newlyAdded.push(entry);
          existingIds.add(d.driver_id);
        }
      }
      // Re-plot map markers using the accumulated driver list.
      const markerData = this.drivers
        .filter((d: any) => Number.isFinite(d.lat) && Number.isFinite(d.lng))
        .map((d: any) => ({
          id: d.driver_id,
          lat: d.lat,
          lng: d.lng,
          bearing_deg: d.bearing_deg ?? 0,
          map_marker_url: d.map_marker_url || d.vehicle?.map_marker_url,
          vehicle: d.vehicle,
        }));
      if (markerData.length) this.renderNearbyDrivers(markerData);

      // Replace the backend's haversine distance with Google's road distance
      // + ETA for the drivers we just added. One Matrix call per ring.
      if (newlyAdded.length) void this.enrichDriversWithRoadDistance(newlyAdded);
    }

    // Search complete on the last hop.
    if (p.hop >= p.max_hops) {
      this.searching = false;
    }
  }

  /**
   * Batch-resolve road distance + ETA for a set of newly-discovered drivers
   * via Google Distance Matrix. Origins = each driver's current location,
   * destination = the customer's pickup. Patches the matching entries in
   * `this.drivers` in place so the picker shows accurate "X km · Y min away".
   *
   * Failures (no SDK, no quota, ZERO_RESULTS, etc.) are silent — the
   * pre-populated haversine distance from the backend stays as the fallback.
   */
  private async enrichDriversWithRoadDistance(newDrivers: NearbyDriver[]): Promise<void> {
    if (!this.pickup) return;
    const origins = newDrivers
      .filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lng))
      .map((d) => ({ driver_id: d.driver_id, lat: d.lat, lng: d.lng }));
    if (!origins.length) return;

    try {
      await this.places.ensureLoaded();
      if (!this.distanceMatrix && typeof google !== 'undefined') {
        this.distanceMatrix = new google.maps.DistanceMatrixService();
      }
      if (!this.distanceMatrix) return;

      const destination = { lat: this.pickup.lat, lng: this.pickup.lng };

      this.distanceMatrix.getDistanceMatrix(
        {
          origins: origins.map((o) => ({ lat: o.lat, lng: o.lng })),
          destinations: [destination],
          travelMode: 'DRIVING',
        },
        (response: any, status: string) => {
          if (status !== 'OK' || !response?.rows) return;
          response.rows.forEach((row: any, i: number) => {
            const el = row?.elements?.[0];
            if (!el || el.status !== 'OK') return;
            const driverId = origins[i].driver_id;
            const entry = this.drivers.find((d) => d.driver_id === driverId);
            if (!entry) return;
            if (el.distance?.value != null) {
              entry.distance_km = Math.round((el.distance.value / 1000) * 1000) / 1000;
            }
            if (el.duration?.value != null) {
              entry.eta_min = Math.max(1, Math.round(el.duration.value / 60));
            }
          });
        }
      );
    } catch {
      // Swallow — haversine distance from backend remains as the fallback.
    }
  }

  /**
   * Discovery-only search. Triggers DispatchHopJob in discoveryMode = true on
   * the backend — drivers in each expanding ring are revealed to the customer
   * (populating the find-driver list) but NOT notified. The customer then names
   * a price and broadcasts it to all of them via sendOffer → /customer-offer.
   */
  async searchDrivers(): Promise<void> {
    if (!this.estimate?.estimated_fare) {
      const t = await this.toastCtrl.create({
        message: 'Still calculating fare — please wait a moment.',
        duration: 2000,
      });
      await t.present();
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      if (!this.tripId) {
        await this.createTrip();
      }
      if (!this.tripId) throw new Error('Trip creation failed.');

      // Reset UI state for a fresh search.
      this.drivers = [];
      this.dispatchRing = null;
      this.clearSearchCircle();
      this.searching = true;

      // Subscribe BEFORE firing the search so we don't miss hop 1.
      if (!this.unsubscribeRealtime) {
        this.unsubscribeRealtime = this.realtime.subscribeNegotiation(
          this.tripId,
          (p) => this.onIncomingOffer(p.offer),
          () => this.onLocked(),
          (p) => this.onDispatchRing(p)
        );
      }

      await this.api.post(`/trips/${this.tripId}/search-drivers`, {}).toPromise();
    } catch (e: any) {
      this.searching = false;
      this.error = e?.error?.message || e?.message || 'Could not start search.';
    } finally {
      this.loading = false;
    }
  }

  private updateSearchCircle(targetRadiusM: number, animMs: number): void {
    if (!this.map || !this.pickupMarker) return;
    const center = this.pickupMarker.position;
    if (!center) return;

    if (!this.searchCircle) {
      this.searchCircle = new google.maps.Circle({
        map: this.map,
        center,
        radius: 0,
        strokeColor: '#10b981',
        strokeOpacity: 0.85,
        strokeWeight: 2,
        fillColor: '#10b981',
        fillOpacity: 0.10,
        clickable: false,
        zIndex: 1,
      });
    } else {
      this.searchCircle.setCenter(center);
    }

    // Smooth radius interpolation so the ring visibly "grows" rather than
    // snapping. 30 fps over animMs milliseconds.
    if (this.searchCircleTween) clearInterval(this.searchCircleTween);
    const startRadius = this.searchCircle.getRadius() || 0;
    const startedAt = performance.now();
    const duration = Math.max(300, Math.min(animMs, 4000));
    this.searchCircleTween = setInterval(() => {
      if (!this.searchCircle) return;
      const t = Math.min(1, (performance.now() - startedAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      this.searchCircle.setRadius(startRadius + (targetRadiusM - startRadius) * eased);
      if (t >= 1) {
        clearInterval(this.searchCircleTween);
        this.searchCircleTween = null;
      }
    }, 33);

    try {
      // Keep the ring visible by zooming out a touch as it grows.
      const bounds = this.searchCircle.getBounds?.();
      if (bounds && this.map.fitBounds) fitCustomerMap(this.map, bounds, 80);
    } catch {}
  }

  private clearSearchCircle(): void {
    if (this.searchCircleTween) {
      clearInterval(this.searchCircleTween);
      this.searchCircleTween = null;
    }
    if (this.searchCircle) {
      this.searchCircle.setMap(null);
      this.searchCircle = null;
    }
    this.dispatchRing = null;
  }

  /**
   * Cancel the current trip and return to driver-picking. Cancel grace fields
   * on the PricingRule (cancel_threshold_distance_km / cancel_threshold_time_min)
   * ensure no fee because the chosen driver never moved.
   */
  async findAnotherDriver(): Promise<void> {
    if (!this.tripId) return;
    const tripToCancel = this.tripId;

    try {
      await this.api.post(`/trips/${tripToCancel}/cancel`, { reason: 'driver_unresponsive' }).toPromise();
    } catch {
      // Even if cancel fails, drop local state so the user isn't stuck.
    }
    this.cleanupSearch();
    this.tripId = null;
    this.selectedDriverId = null;
    this.driverOffers = [];
    this.showFindAnother = false;
    this.lastSearchKey = null;
    // Back to the fare step so the customer can re-send "Search driver" (the
    // cancelled trip is replaced by a fresh one on the next send).
    this.state = 'offer';
  }

  private cleanupSearch(): void {
    if (this.searchTimer) {
      clearInterval(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.unsubscribeRealtime) {
      this.unsubscribeRealtime();
      this.unsubscribeRealtime = null;
    }
    if (this.findAnotherTimeoutHandle) {
      clearTimeout(this.findAnotherTimeoutHandle);
      this.findAnotherTimeoutHandle = null;
    }
    this.clearSearchCircle();
    this.showFindAnother = false;
  }

  private pollNegotiation(): void {
    if (!this.tripId) return;
    this.api
      .get<{
        trip_id: number;
        negotiation: { status: string; final_amount: number; offers: DriverOffer[] };
        negotiation_config?: { min_amount?: number; floor_percent?: number; estimated_fare?: number };
      }>(`/trips/${this.tripId}/negotiation`)
      .subscribe({
        next: (res) => {
          this.captureNegotiationConfig(res?.negotiation_config);
          const offers = (res?.negotiation?.offers || []).filter(
            (o) => o.from_role === 'driver' && (o.status === 'PENDING' || o.status === 'ACCEPTED')
          );
          for (const o of offers) this.onIncomingOffer(o);
          if (res?.negotiation?.status === 'LOCKED') this.onLocked();
        },
      });
  }

  /**
   * Pull the negotiation floor out of the negotiation response. min_amount is
   * the true lowest the customer may offer, so it overrides minFare. The empty
   * text box is left untouched — the customer types their own price.
   */
  private captureNegotiationConfig(
    cfg?: { min_amount?: number; floor_percent?: number; estimated_fare?: number } | null
  ): void {
    if (!cfg) return;
    if (typeof cfg.min_amount === 'number' && Number.isFinite(cfg.min_amount) && cfg.min_amount >= 0) {
      this.minFare = cfg.min_amount;
    }
  }

  private onIncomingOffer(offer: DriverOffer): void {
    if (offer.from_role !== 'driver') return;
    const exists = this.driverOffers.some((o) => o.id != null && o.id === offer.id);
    if (exists) return;
    this.driverOffers = [...this.driverOffers, offer];
    // A driver replied — surface the bids sheet so the customer can confirm.
    // The "send a new price" box stays EMPTY; the customer types their own.
    if (this.state === 'waiting') {
      this.state = 'bids';
    }
  }

  private onLocked(): void {
    if (!this.tripId) return;
    this.cleanupSearch();
    this.router.navigateByUrl(`/customer-tabs/trip/${this.tripId}`, { replaceUrl: true });
  }

  /**
   * Customer re-broadcasts a brand-new price to ALL drivers from the bids sheet
   * (bargaining back). Reuses the customer-offer path, so every driver sees the
   * new ask and can re-accept or re-counter.
   */
  async counterBid(): Promise<void> {
    const amount = Number(this.counterOfferAmount);
    if (!this.counterOfferAmount || amount <= 0) {
      this.error = 'Enter a price to send.';
      return;
    }
    // Backstop for the disabled send button: never send below the negotiation floor.
    if (this.minFare && amount < this.minFare) {
      this.error = `You can't offer below ₹${this.minFare} — the minimum allowed offer is ₹${this.minFare}.`;
      return;
    }
    this.counterOfferAmount = null;
    await this.requestAutoDispatch(amount);
  }

  async confirmOffer(offer: DriverOffer): Promise<void> {
    if (!this.tripId) return;

    const ok = await this.alertCtrl.create({
      header: `Take ₹${offer.amount}?`,
      buttons: [
        { text: 'Back', role: 'cancel' },
        {
          text: 'Take it',
          role: 'destructive',
          handler: () => this.lockOffer(offer),
        },
      ],
    });
    await ok.present();
  }

  private async lockOffer(offer: DriverOffer): Promise<void> {
    if (!this.tripId) return;
    if (offer.id == null) {
      const t = await this.toastCtrl.create({
        message: 'Offer is missing an id — refresh and try again.',
        duration: 2500,
        color: 'danger',
      });
      await t.present();
      return;
    }
    try {
      await this.api
        .post(`/trips/${this.tripId}/negotiation/customer-confirm`, {
          final_fare: offer.amount,
          accepted_offer_id: offer.id,
        })
        .toPromise();
      this.onLocked();
    } catch (e: any) {
      const t = await this.toastCtrl.create({
        message: e?.error?.message || 'Could not confirm fare.',
        duration: 2500,
        color: 'danger',
      });
      await t.present();
    }
  }

  async cancelRequest(): Promise<void> {
    if (!this.tripId) {
      this.resetToIdle();
      return;
    }
    const a = await this.alertCtrl.create({
      header: 'Cancel request?',
      message: 'No driver will be assigned. You can request again any time.',
      buttons: [
        { text: 'Keep waiting', role: 'cancel' },
        {
          text: 'Cancel',
          role: 'destructive',
          handler: async () => {
            try {
              await this.api.post(`/trips/${this.tripId}/cancel`, {}).toPromise();
            } catch {
              /* ignore */
            }
            this.resetToIdle();
          },
        },
      ],
    });
    await a.present();
  }

  private resetToIdle(): void {
    this.cleanupSearch();
    this.stopDriverListPoll();
    this.tripId = null;
    this.selectedDriverId = null;
    this.driverOffers = [];
    this.drivers = [];
    // Fresh booking → clear any "for a friend" details.
    this.bookingForOther = false;
    this.bookedForName = '';
    this.bookedForCountryCode = '91';
    this.bookedForPhone = '';
    this.state = 'idle';
  }

  private uuid(prefix: string): string {
    try {
      return (crypto as unknown as { randomUUID: () => string }).randomUUID();
    } catch {
      return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    }
  }
}
