import { Component, ElementRef, NgZone, OnDestroy, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, Platform, ToastController } from '@ionic/angular';
import { Subscription, interval } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import {
  buildPassengerMarkerElement,
  buildReusableCarMarkerElement,
  buildStopMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
} from '../../core/car-marker.helper';
import { FixedCustomerLocationService } from '../../core/fixed-customer-location.service';
import { GeoFix, GeolocationService } from '../../core/geolocation.service';
import { PlacesService } from '../../core/places.service';
import { RealtimeService, TripLocationPayload } from '../../core/realtime.service';

declare const google: any;

interface FixedLiveStatus {
  key: string;
  label: string;
  detail: string;
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'medium' | string;
}

interface StopItem {
  id: number;
  seq: number;
  name: string;
  lat: number | null;
  lng: number | null;
  is_pickup?: boolean;
  is_drop?: boolean;
}

interface FixedBooking {
  id: number;
  route_name?: string | null;
  trip_id?: number | null;
  departure_status?: string | null;
  fixed_last_reached_stop_seq?: number | null;
  fixed_last_reached_stop_at?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  vehicle_name?: string | null;
  vehicle_type_name?: string | null;
  vehicle_brand?: string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
  vehicle_reg_no?: string | null;
  board_lat?: number | null;
  board_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  seats: number;
  seat_labels?: string[];
  latest_driver_location_stale?: boolean;
  status: string;
  boarding_code?: string | null;
  fixed_live_status?: FixedLiveStatus | null;
  payment_method?: string | null;
  payment_status?: string | null;
  refund_status?: string | null;
  payment_reference?: string | null;
  fare_amount?: number | null;
  promo_discount_amount?: number | null;
  has_extra_luggage?: boolean;
  extra_luggage_count?: number;
  luggage_surcharge_amount?: number;
  board?: string | null;
  drop?: string | null;
  created_at?: string | null;
  announced_depart_at?: string | null;
  depart_at?: string | null;
  service_date?: string | null;
  rating_score?: number | null;
  rating_comment?: string | null;
  latest_driver_location?: { lat: number; lng: number; recorded_at?: string | null } | null;
  map_marker_url?: string | null;
  image_url?: string | null;
  vehicle?: {
    type?: string | null;
    brand?: string | null;
    model?: string | null;
    color?: string | null;
    reg_no?: string | null;
    image_url?: string | null;
    map_marker_url?: string | null;
  } | null;
  stops?: StopItem[];
}

@Component({
  selector: 'app-fixed-ride-active',
  templateUrl: './fixed-ride-active.page.html',
  styleUrls: ['./fixed-ride-active.page.scss'],
  standalone: false,
})
export class FixedRideActivePage implements OnDestroy {
  @ViewChild('fixedActiveMap', { static: false }) mapElRef?: ElementRef<HTMLDivElement>;

  loading = false;
  cancelling = false;
  submittingRating = false;
  ratingScore = 5;
  ratingComment = '';
  error: string | null = null;
  mapError: string | null = null;
  sosBusy = false;
  walkingDistanceMeters: number | null = null;
  walkingDurationSeconds: number | null = null;
  walkingLoading = false;
  walkingMessage = 'Waiting for your current location…';
  private walkingRequest = 0;
  private walkingLeftPage = false;
  private walkingLastKey = '';
  private walkingLastAttempt = 0;
  booking: FixedBooking | null = null;
  stopScrollPercent = 0;
  sheetExpanded = false;
  toggleSheet(): void { this.sheetExpanded = !this.sheetExpanded; }

  private map: any | null = null;
  private pickupMarker: any | null = null;
  private dropMarker: any | null = null;
  private userLiveMarker: any | null = null;
  private driverMarker: any | null = null;
  private stopMarkers: any[] = [];
  private routePolylines: any[] = [];
  private driverPosition: { lat: number; lng: number } | null = null;
  private driverBearing = 0;
  private userPosition: { lat: number; lng: number } | null = null;

  private pollSub?: Subscription;
  private backButtonSub?: Subscription;
  private watchId: string | null = null;
  private trackingTripId: number | null = null;
  private unsubscribeTracking: (() => void) | null = null;
  private readonly inactiveStatuses = new Set(['DROPPED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']);

  constructor(
    private api: ApiService,
    private route: ActivatedRoute,
    private router: Router,
    private alerts: AlertController,
    private toasts: ToastController,
    private platform: Platform,
    private auth: AuthService,
    private fixedLocation: FixedCustomerLocationService,
    private geo: GeolocationService,
    private places: PlacesService,
    private realtime: RealtimeService,
    private zone: NgZone,
  ) {}

  ionViewWillEnter(): void {
    this.walkingLeftPage = false;
    this.load();
    this.pollSub ??= interval(5000).subscribe(() => this.silentReload());
    this.backButtonSub = this.platform.backButton.subscribeWithPriority(10, () => {
      this.back();
    });
    void this.startUserLocationWatch();
  }

  ionViewWillLeave(): void {
    this.walkingLeftPage = true;
    this.walkingRequest++;
    this.walkingLoading = false;
    this.pollSub?.unsubscribe();
    this.pollSub = undefined;
    this.backButtonSub?.unsubscribe();
    this.backButtonSub = undefined;
    this.stopRealtimeTracking();
    void this.stopUserLocationWatch();
    void this.fixedLocation.stop();
  }

  ngOnDestroy(): void {
    this.ionViewWillLeave();
    this.clearMap();
  }

  load(): void {
    const bookingId = Number(this.route.snapshot.paramMap.get('bookingId') || 0);
    if (!bookingId) {
      this.error = 'Fixed booking not found.';
      return;
    }

    this.loading = true;
    this.error = null;
    this.api.get<{ booking: FixedBooking }>('/fixed/bookings/' + bookingId).subscribe({
      next: (res) => {
        this.booking = res?.booking || null;
        this.loading = false;
        if (!this.booking) {
          this.error = 'Fixed booking not found.';
        } else {
          this.initOrUpdateMap();
          this.syncRealtimeTracking();
        }
        this.syncFixedLocationStream();
        void this.refreshWalkingDistance();
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Could not load fixed ride.';
        this.syncFixedLocationStream();
      },
    });
  }

  private silentReload(): void {
    if (this.loading || this.cancelling) return;
    if (this.booking && !this.isActiveBooking(this.booking)) return;
    const bookingId = Number(this.route.snapshot.paramMap.get('bookingId') || 0);
    if (!bookingId) return;

    this.api.get<{ booking: FixedBooking }>('/fixed/bookings/' + bookingId).subscribe({
      next: (res) => {
        if (res?.booking) {
          this.booking = res.booking;
          if (res.booking.latest_driver_location?.lat != null && res.booking.latest_driver_location?.lng != null) {
            this.driverPosition = {
              lat: Number(res.booking.latest_driver_location.lat),
              lng: Number(res.booking.latest_driver_location.lng),
            };
          }
          this.initOrUpdateMap();
          this.syncRealtimeTracking();
          this.syncFixedLocationStream();
          void this.refreshWalkingDistance();
        }
      },
      error: () => {},
    });
  }

  updateStopScroll(event: Event): void {
    const rail = event.target as HTMLElement;
    const overflow = rail.scrollWidth - rail.clientWidth;
    this.stopScrollPercent = overflow > 0 ? rail.scrollLeft / overflow * 100 : 0;
  }

  scrollStopTimeline(rail: HTMLElement, event: Event): void {
    const percent = Number((event.target as HTMLInputElement).value);
    rail.scrollTo({ left: Math.max(0, rail.scrollWidth - rail.clientWidth) * percent / 100 });
    this.stopScrollPercent = percent;
  }

  back(): void {
    this.router.navigateByUrl('/customer-tabs/go');
  }

  callDriver(): void {
    const phone = this.booking?.driver_phone;
    if (phone) {
      window.open('tel:' + phone, '_system');
    }
  }

  orderedStops(ride: FixedBooking): StopItem[] {
    return [...(ride.stops || [])].sort((a, b) => a.seq - b.seq);
  }

  isBoardStop(ride: FixedBooking, stop: StopItem): boolean {
    if (ride.board_lat != null && ride.board_lng != null && stop.lat != null && stop.lng != null) {
      return Math.abs(ride.board_lat - stop.lat) < .00001 && Math.abs(ride.board_lng - stop.lng) < .00001;
    }
    return !!ride.board && stop.name === ride.board;
  }

  hasReached(ride: FixedBooking, stop: StopItem): boolean {
    return this.hasJourneyStarted(ride) && ride.fixed_last_reached_stop_seq != null && stop.seq <= ride.fixed_last_reached_stop_seq;
  }

  hasJourneyStarted(ride: FixedBooking): boolean {
    return ['DISPATCHED', 'DEPARTED', 'COMPLETED'].includes((ride.departure_status || '').toUpperCase()) ||
      ['BOARDED', 'DROPPED', 'COMPLETED'].includes(ride.status.toUpperCase());
  }

  isCurrentStop(ride: FixedBooking, stop: StopItem): boolean {
    return this.hasReached(ride, stop) && stop.seq === ride.fixed_last_reached_stop_seq;
  }

  hasPassed(ride: FixedBooking, stop: StopItem): boolean {
    return this.hasReached(ride, stop) && stop.seq < ride.fixed_last_reached_stop_seq!;
  }

  progressTitle(ride: FixedBooking): string {
    if (ride.status.toUpperCase() === 'BOARDED') return 'You’re on your way';
    if (!this.hasJourneyStarted(ride)) return this.bookingStatusLabel(ride);
    if (['driver_arrived', 'leaving_soon', 'vehicle_approaching'].includes(ride.fixed_live_status?.key || '')) return this.bookingStatusLabel(ride);
    const stops = this.orderedStops(ride);
    const pickup = stops.findIndex(stop => this.isBoardStop(ride, stop));
    const last = stops.findIndex(stop => stop.seq === ride.fixed_last_reached_stop_seq);
    if (pickup >= 0 && last >= 0) {
      if (last === pickup) return 'Cab reached your pickup stop';
      if (last > pickup) return 'Cab has passed your pickup stop';
      const remaining = pickup - last;
      return `Cab is ${remaining} ${remaining === 1 ? 'stop' : 'stops'} away`;
    }
    return this.bookingStatusLabel(ride);
  }

  canWalkToPickup(ride: FixedBooking): boolean {
    return ['BOOKED', 'CONFIRMED'].includes(ride.status.toUpperCase()) &&
      ride.board_lat != null && ride.board_lng != null &&
      Number.isFinite(Number(ride.board_lat)) && Number.isFinite(Number(ride.board_lng));
  }


  walkingDistanceLabel(): string {
    const meters = this.walkingDistanceMeters;
    if (meters == null) return this.walkingLoading ? 'Calculating walking distance…' : this.walkingMessage;
    const distance = meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
    const duration = this.walkingDurationSeconds;
    return `${distance} walk${duration != null ? ` · about ${Math.max(1, Math.ceil(duration / 60))} min` : ''}`;
  }

  async refreshWalkingDistance(): Promise<void> {
    const ride = this.booking;
    if (this.walkingLeftPage) return;
    if (!ride || !this.canWalkToPickup(ride)) {
      this.walkingRequest++;
      this.walkingDistanceMeters = null; this.walkingDurationSeconds = null; this.walkingLoading = false;
      return;
    }
    const origin = this.userPosition;
    if (!origin) { this.walkingMessage = 'Current location unavailable. Enable location to see walking distance.'; return; }
    const destination = { lat: Number(ride.board_lat), lng: Number(ride.board_lng) };
    const key = `${ride.id}:${destination.lat},${destination.lng}`;
    // Avoid a billable route request on each GPS ping or five-second booking poll.
    if (key === this.walkingLastKey && Date.now() - this.walkingLastAttempt < 30000) return;
    if (key !== this.walkingLastKey) { this.walkingDistanceMeters = null; this.walkingDurationSeconds = null; }
    this.walkingLastKey = key; this.walkingLastAttempt = Date.now();
    const request = ++this.walkingRequest;
    this.walkingLoading = true;
    try {
      const metrics = await this.fetchWalkingRoute(origin, destination);
      if (request !== this.walkingRequest || this.walkingLeftPage) return;
      this.walkingDistanceMeters = metrics.meters; this.walkingDurationSeconds = metrics.seconds;
      this.walkingMessage = '';
    } catch {
      if (request !== this.walkingRequest || this.walkingLeftPage) return;
      this.walkingDistanceMeters = null; this.walkingDurationSeconds = null;
      this.walkingMessage = 'Walking distance unavailable. Please try refreshing.';
    } finally { if (request === this.walkingRequest) this.walkingLoading = false; }
  }

  private async fetchWalkingRoute(origin: { lat: number; lng: number }, destination: { lat: number; lng: number }): Promise<{ meters: number; seconds: number | null }> {
    await this.places.ensureLoaded();
    try {
      const { Route } = await google.maps.importLibrary('routes');
      const result = await Route.computeRoutes({ origin, destination, travelMode: 'WALKING', fields: ['distanceMeters', 'durationMillis'] });
      const route = result.routes?.[0];
      if (typeof route?.distanceMeters === 'number' && Number.isFinite(route.distanceMeters) && route.distanceMeters >= 0) {
        return { meters: route.distanceMeters, seconds: typeof route.durationMillis === 'number' && Number.isFinite(route.durationMillis) ? route.durationMillis / 1000 : null };
      }
    } catch { /* Existing deployments may only have the legacy Directions API enabled. */ }
    const result = await new google.maps.DirectionsService().route({ origin, destination, travelMode: 'WALKING' });
    const leg = result.routes?.[0]?.legs?.[0];
    if (typeof leg?.distance?.value !== 'number' || !Number.isFinite(leg.distance.value) || leg.distance.value < 0) throw new Error('No walking route');
    return { meters: leg.distance.value, seconds: typeof leg.duration?.value === 'number' ? leg.duration.value : null };
  }

  seatLine(ride: FixedBooking): string {
    if (ride.seat_labels?.length) return `Seat ${ride.seat_labels.join(', ')}`;
    return `${ride.seats} ${ride.seats === 1 ? 'seat' : 'seats'}`;
  }

  paymentMethodLabel(ride: FixedBooking): string {
    return ride.payment_method ? this.prettyToken(ride.payment_method) : 'Method unavailable';
  }

  vehicleDetails(ride: FixedBooking): string {
    return [this.carLine(ride), ride.vehicle_reg_no].filter(Boolean).join(' · ');
  }

  async triggerSOS(): Promise<void> {
    if (!this.booking?.trip_id || !this.isActiveBooking(this.booking) || this.sosBusy) return;
    const tripId = this.booking.trip_id;
    const alert = await this.alerts.create({
      header: 'Send SOS?', message: 'Alert the support team with your ride and current location, if available.',
      buttons: [{ text: 'Go back', role: 'cancel' }, { text: 'Send SOS', role: 'confirm' }],
    });
    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role !== 'confirm' || this.sosBusy || this.booking?.trip_id !== tripId || !this.isActiveBooking(this.booking)) return;
    this.sosBusy = true;
    try {
      await this.api.post(`/trips/${tripId}/sos`, this.userPosition || {}).toPromise();
      await this.showToast('SOS alert sent to the support team.');
    } catch (err: any) {
      await this.showToast(err?.error?.message || 'Could not send SOS. Please try again or contact support.');
    } finally { this.sosBusy = false; }
  }

  // ── Smart Route Corridor Naming ───────────────────────────────────────────
  get routeOriginName(): string {
    const name = this.booking?.route_name || '';
    if (!name) return this.booking?.board || 'Origin';
    if (name.includes('->')) return name.split('->')[0].trim();
    if (name.includes('→')) return name.split('→')[0].trim();
    if (name.toLowerCase().includes(' to ')) return name.split(/\s+to\s+/i)[0].trim();
    return this.booking?.board || name;
  }

  get routeDestName(): string {
    const name = this.booking?.route_name || '';
    if (!name) return this.booking?.drop || 'Destination';
    if (name.includes('->')) return name.split('->')[1]?.trim() || '';
    if (name.includes('→')) return name.split('→')[1]?.trim() || '';
    if (name.toLowerCase().includes(' to ')) return name.split(/\s+to\s+/i)[1]?.trim() || '';
    return this.booking?.drop || name;
  }

  // ── Map Lifecycle & Rendering ─────────────────────────────────────────────
  private async initOrUpdateMap(): Promise<void> {
    if (!this.booking) return;

    if (this.isActiveBooking(this.booking) && this.booking.latest_driver_location?.lat != null && this.booking.latest_driver_location?.lng != null) {
      this.driverPosition = {
        lat: Number(this.booking.latest_driver_location.lat),
        lng: Number(this.booking.latest_driver_location.lng),
      };
    } else if (!this.isActiveBooking(this.booking)) {
      this.driverPosition = null;
      if (this.driverMarker) {
        this.driverMarker.map = null;
        this.driverMarker = null;
      }
    }

    if (!this.map) {
      await this.ensureMap();
    } else {
      this.updateMarkers();
    }
  }

  private async ensureMap(): Promise<void> {
    if (this.walkingLeftPage) return;
    if (!this.mapElRef?.nativeElement) {
      setTimeout(() => void this.ensureMap(), 80);
      return;
    }

    try {
      this.mapError = null;
      await this.places.ensureLoaded();
      if (!this.mapElRef?.nativeElement || typeof google === 'undefined') return;

      const center = this.resolveCenter();
      this.map = new google.maps.Map(this.mapElRef.nativeElement, {
        center,
        zoom: 14,
        disableDefaultUI: true,
        zoomControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        mapId: 'DEMO_MAP_ID',
        gestureHandling: 'greedy',
        clickableIcons: false,
      });

      this.updateMarkers();
      this.fitMapBounds();
    } catch {
      this.mapError = 'The map is unavailable. Your ride details are still shown. Refresh to try again.';
    }
  }

  private resolveCenter(): { lat: number; lng: number } {
    if (this.driverPosition) return this.driverPosition;
    if (this.booking?.board_lat != null && this.booking?.board_lng != null) {
      return { lat: Number(this.booking.board_lat), lng: Number(this.booking.board_lng) };
    }
    return { lat: 34.2985, lng: 74.4712 };
  }

  private updateMarkers(): void {
    if (!this.map || typeof google === 'undefined') return;

    const b = this.booking;
    if (!b) return;

    // 1. Pickup Stop Pin Marker (Clean pin, no person icon)
    if (b.board_lat != null && b.board_lng != null) {
      const pos = { lat: Number(b.board_lat), lng: Number(b.board_lng) };
      const label = 'Pickup: ' + (b.board || 'Stop');
      if (!this.pickupMarker) {
        this.pickupMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: label,
          content: this.buildPinMarkerElement('pickup', label),
          zIndex: 900,
        });
      } else {
        this.pickupMarker.position = pos;
      }
    }

    // 2. Drop Stop Pin Marker (Clean pin, no person icon)
    if (b.drop_lat != null && b.drop_lng != null) {
      const pos = { lat: Number(b.drop_lat), lng: Number(b.drop_lng) };
      const label = 'Drop: ' + (b.drop || 'Stop');
      if (!this.dropMarker) {
        this.dropMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pos,
          map: this.map,
          title: label,
          content: this.buildPinMarkerElement('drop', label),
          zIndex: 900,
        });
      } else {
        this.dropMarker.position = pos;
      }
    }

    // 3. Intermediate Stops eliminated: customer sees only their own pickup & drop pins
    for (const m of this.stopMarkers) m.map = null;
    this.stopMarkers = [];

    // 4. Passenger Device Actual Live Location (Person Avatar)
    if (this.userPosition) {
      if (!this.userLiveMarker) {
        this.userLiveMarker = new google.maps.marker.AdvancedMarkerElement({
          position: this.userPosition,
          map: this.map,
          title: 'Passenger',
          content: buildPassengerMarkerElement({
            kind: 'pickup',
            name: '',
            isLive: true,
            avatarUrl: this.auth.resolveAvatarUrl(this.auth.getUser()),
          }),
          zIndex: 1100,
        });
      } else {
        this.userLiveMarker.position = this.userPosition;
        if (!this.userLiveMarker.map) this.userLiveMarker.map = this.map;
      }
    } else if (this.userLiveMarker) {
      this.userLiveMarker.map = null;
      this.userLiveMarker = null;
    }

    // 5. Driver Vehicle Live Marker (active booking only)
    if (this.driverPosition && this.isActiveBooking(b)) {
      if (!this.driverMarker) {
        this.driverMarker = new google.maps.marker.AdvancedMarkerElement({
          position: this.driverPosition,
          map: this.map,
          title: 'Driver',
          content: buildReusableCarMarkerElement({
            bearing: this.driverBearing,
            markerUrl: (b as any).map_marker_url || (b as any).vehicle?.map_marker_url || null,
          }),
          zIndex: 1000,
        });
      } else {
        this.driverMarker.position = this.driverPosition;
        if (!this.driverMarker.map) this.driverMarker.map = this.map;
        updateCarMarkerBearing(this.driverMarker, this.driverBearing);
        const markerUrl = (b as any).map_marker_url || (b as any).vehicle?.map_marker_url || null;
        if (markerUrl) {
          updateCarMarkerImage(this.driverMarker, markerUrl);
        }
      }
    } else if (this.driverMarker) {
      this.driverMarker.map = null;
      this.driverMarker = null;
    }

    // 6. Draw Route Polyline Corridor
    this.renderRoutePolyline();
  }

  private renderRoutePolyline(): void {
    if (!this.map || typeof google === 'undefined') return;

    for (const poly of this.routePolylines) {
      poly.setMap(null);
    }
    this.routePolylines = [];
    // Route polylines eliminated: customer sees only pickup/drop pins and driver live vehicle marker
  }

  private buildPinMarkerElement(kind: 'pickup' | 'drop', label: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `dc-fixed-pin-marker dc-fixed-pin-marker--${kind}`;
    const isPickup = kind === 'pickup';
    const bg = isPickup ? '#2563EB' : '#EF4444';
    const dotBg = isPickup ? '#3B82F6' : '#F87171';
    el.innerHTML = `
      <div style="background: ${bg}; color: #ffffff; font-size: 11px; font-weight: 850; padding: 3px 9px; border-radius: 99px; box-shadow: 0 3px 10px rgba(0,0,0,0.3); border: 1.5px solid #ffffff; white-space: nowrap; text-align: center; line-height: 1.2;">
        ${label}
      </div>
      <div style="width: 10px; height: 10px; border-radius: 50%; background: ${dotBg}; border: 2.5px solid #ffffff; margin: 3px auto 0; box-shadow: 0 2px 6px rgba(0,0,0,0.35);"></div>
    `;
    return el;
  }

  recenterMap(): void {
    this.fitMapBounds();
  }

  private fitMapBounds(): void {
    if (!this.map || typeof google === 'undefined') return;

    const bounds = new google.maps.LatLngBounds();
    let count = 0;

    const addPoint = (lat?: number | null, lng?: number | null) => {
      if (lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
        bounds.extend({ lat: Number(lat), lng: Number(lng) });
        count++;
      }
    };

    addPoint(this.booking?.board_lat, this.booking?.board_lng);
    addPoint(this.booking?.drop_lat, this.booking?.drop_lng);
    addPoint(this.driverPosition?.lat, this.driverPosition?.lng);
    addPoint(this.userPosition?.lat, this.userPosition?.lng);

    if (this.booking?.stops) {
      for (const s of this.booking.stops) {
        addPoint(s.lat, s.lng);
      }
    }

    if (count > 0) {
      const sheet = this.mapElRef?.nativeElement.parentElement?.querySelector('.live-sheet');
      const mapHeight = this.mapElRef?.nativeElement.clientHeight || 600;
      const mapWidth = this.mapElRef?.nativeElement.clientWidth || 400;
      const sheetHeight = sheet?.getBoundingClientRect().height || mapHeight * .56;
      this.map.fitBounds(bounds, mapWidth >= 900
        ? { top: 90, bottom: 40, left: 440, right: 40 }
        : { top: 95, bottom: Math.min(sheetHeight + 20, mapHeight - 160), left: 30, right: 30 });
    }
  }

  private clearMap(): void {
    if (this.pickupMarker) { this.pickupMarker.map = null; this.pickupMarker = null; }
    if (this.dropMarker) { this.dropMarker.map = null; this.dropMarker = null; }
    if (this.userLiveMarker) { this.userLiveMarker.map = null; this.userLiveMarker = null; }
    if (this.driverMarker) { this.driverMarker.map = null; this.driverMarker = null; }
    for (const m of this.stopMarkers) m.map = null;
    this.stopMarkers = [];
    for (const p of this.routePolylines) p.setMap(null);
    this.routePolylines = [];
    this.map = null;
  }

  // ── Realtime Driver Tracking ──────────────────────────────────────────────
  private syncRealtimeTracking(): void {
    const tripId = this.booking?.trip_id;
    if (!tripId || !this.isActiveBooking(this.booking!)) {
      this.stopRealtimeTracking();
      return;
    }
    if (this.trackingTripId === tripId) return;

    this.stopRealtimeTracking();
    this.trackingTripId = tripId;

    this.unsubscribeTracking = this.realtime.subscribeTracking(
      tripId,
      (payload: TripLocationPayload) => {
        if (payload?.location) {
          const loc = payload.location;
          this.zone.run(() => {
            this.driverPosition = { lat: loc.lat, lng: loc.lng };
            if (loc.bearing_deg != null) this.driverBearing = loc.bearing_deg;
            this.updateMarkers();
          });
        }
      },
      () => {
        this.zone.run(() => this.silentReload());
      },
    );
  }

  private stopRealtimeTracking(): void {
    if (this.unsubscribeTracking) {
      this.unsubscribeTracking();
      this.unsubscribeTracking = null;
    }
    this.trackingTripId = null;
  }

  // ── Customer Geolocation ──────────────────────────────────────────────────
  private async startUserLocationWatch(): Promise<void> {
    if (this.watchId) return;
    try {
      const initialFix = await this.geo.getCurrentPosition();
      if (this.walkingLeftPage) return;
      if (initialFix) {
        this.zone.run(() => {
          this.userPosition = { lat: initialFix.lat, lng: initialFix.lng };
          void this.refreshWalkingDistance();
          if (this.map) this.updateMarkers();
        });
      }

      this.watchId = await this.geo.watchPosition(
        { enableHighAccuracy: true, maximumAge: 3000 },
        (fix: GeoFix | null) => {
          if (fix) {
            this.zone.run(() => {
              this.userPosition = { lat: fix.lat, lng: fix.lng };
              void this.refreshWalkingDistance();
              if (this.map) this.updateMarkers();
            });
          }
        },
      );
      if (this.walkingLeftPage) await this.stopUserLocationWatch();
    } catch {
      this.walkingMessage = 'Current location unavailable. Enable location to see walking distance.';
    }
  }

  private async stopUserLocationWatch(): Promise<void> {
    if (this.watchId) {
      await this.geo.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  // ── Ride Lifecycle Actions ────────────────────────────────────────────────
  async cancelRide(): Promise<void> {
    if (!this.booking || !this.canCancel(this.booking) || this.cancelling) return;
    const alert = await this.alerts.create({
      header: 'Cancel fixed ride?',
      message: 'Your seat will be released. Refund depends on the fixed ride cancellation window.',
      buttons: [
        { text: 'Keep booking', role: 'cancel' },
        { text: 'Cancel ride', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role !== 'confirm') return;

    this.cancelling = true;
    this.api.post<{ reservation: FixedBooking; message: string }>('/fixed/bookings/' + this.booking.id + '/cancel', {})
      .pipe(finalize(() => this.cancelling = false))
      .subscribe({
        next: async (res) => {
          this.booking = res?.reservation || this.booking;
          this.driverPosition = null;
          if (this.driverMarker) {
            this.driverMarker.map = null;
            this.driverMarker = null;
          }
          if (this.userLiveMarker) {
            this.userLiveMarker.map = null;
            this.userLiveMarker = null;
          }
          this.stopRealtimeTracking();
          void this.stopUserLocationWatch();
          this.syncFixedLocationStream();
          this.updateMarkers();
          this.fitMapBounds();
          await this.showToast(res?.message || 'Fixed booking cancelled.');
        },
        error: (err) => this.error = err?.error?.message || 'Could not cancel fixed booking.',
      });
  }

  canRate(booking: FixedBooking): boolean {
    return ['DROPPED', 'COMPLETED'].includes((booking.status || '').toUpperCase()) && booking.rating_score == null;
  }

  setRatingScore(score: number): void {
    this.ratingScore = score;
  }

  submitRating(): void {
    if (!this.booking || this.submittingRating) return;
    this.submittingRating = true;
    this.api.post<{ booking: FixedBooking; message: string }>('/fixed/bookings/' + this.booking.id + '/rate', {
      score: this.ratingScore,
      comment: this.ratingComment.trim() || null,
    }).pipe(finalize(() => this.submittingRating = false)).subscribe({
      next: async (res) => {
        if (res?.booking) {
          this.booking = res.booking;
        }
        await this.showToast(res?.message || 'Thank you for rating your ride!');
      },
      error: async (err) => {
        await this.showToast(err?.error?.message || 'Could not submit rating.');
      },
    });
  }

  isActiveBooking(booking: FixedBooking): boolean {
    return !this.inactiveStatuses.has((booking.status || '').toUpperCase());
  }

  codeDigits(booking: FixedBooking): string[] {
    return (booking.boarding_code || '').split('');
  }

  journeyStage(booking: FixedBooking): number {
    switch ((booking.status || '').toUpperCase()) {
      case 'BOOKED':
      case 'CONFIRMED': return 0;
      case 'BOARDED': return 1;
      case 'DROPPED': return 2;
      case 'COMPLETED': return 3;
      default: return -1;
    }
  }

  showBoardingCode(booking: FixedBooking): boolean {
    return this.journeyStage(booking) === 0 && !!booking.boarding_code;
  }

  journeyIcon(booking: FixedBooking): string {
    const stage = this.journeyStage(booking);
    return stage >= 2 ? 'checkmark-circle-outline' : stage === 1 ? 'car-outline' : 'ticket-outline';
  }

  canCancel(booking: FixedBooking): boolean {
    const status = (booking.status || '').toUpperCase();
    const depStatus = (booking.departure_status || '').toUpperCase();
    return ['BOOKED', 'CONFIRMED'].includes(status) && !['DEPARTED', 'COMPLETED', 'CANCELLED'].includes(depStatus);
  }

  bookingStatusLabel(booking: FixedBooking): string {
    switch ((booking.status || '').toUpperCase()) {
      case 'BOOKED':
      case 'CONFIRMED': return booking.fixed_live_status?.label || 'Booking confirmed';
      case 'BOARDED': return 'Boarded';
      case 'DROPPED': return 'Dropped off';
      case 'COMPLETED': return 'Ride completed';
      case 'NO_SHOW': return 'No-show';
      case 'CANCELLED': return booking.fixed_live_status?.key === 'driver_missed_stop' ? 'Driver missed pickup' : 'Cancelled';
      default: return booking.fixed_live_status?.label || booking.status || 'Active ride';
    }
  }

  statusClass(booking: FixedBooking): string {
    if (['BOOKED', 'CONFIRMED'].includes(booking.status.toUpperCase()) && booking.fixed_live_status?.tone) return 'status--' + booking.fixed_live_status.tone;
    switch ((booking.status || '').toUpperCase()) {
      case 'BOARDED':
      case 'DROPPED':
      case 'COMPLETED': return 'status--success';
      case 'NO_SHOW': return 'status--danger';
      case 'CANCELLED': return 'status--medium';
      default: return 'status--primary';
    }
  }

  statusDetail(booking: FixedBooking): string {
    if (['BOOKED', 'CONFIRMED', 'BOARDED'].includes((booking.status || '').toUpperCase()) && booking.fixed_live_status?.detail) return booking.fixed_live_status.detail;
    switch ((booking.status || '').toUpperCase()) {
      case 'BOOKED':
      case 'CONFIRMED': return 'Your seat is booked. The vehicle will pick you up at your stop.';
      case 'BOARDED': return 'You have boarded the vehicle and are on your way.';
      case 'DROPPED': return 'You have arrived at your drop-off stop.';
      case 'COMPLETED': return 'This fixed ride is completed.';
      case 'NO_SHOW': return 'The driver reached your pickup stop and the waiting window expired.';
      case 'CANCELLED': return 'This fixed booking is cancelled.';
      default: return 'Fixed ride status: ' + booking.status;
    }
  }

  vehicleLine(booking: FixedBooking): string {
    return [booking.vehicle_name, booking.vehicle_type_name].filter(Boolean).join(' · ') || 'Vehicle assigned';
  }

  carLine(booking: FixedBooking): string {
    return [booking.vehicle_brand, booking.vehicle_model, booking.vehicle_color].filter(Boolean).join(' · ');
  }

  luggageLine(booking: FixedBooking): string {
    const booked = booking.extra_luggage_count || 0;
    return booked ? booked + ' extra' : 'No extra luggage';
  }

  fareLine(booking: FixedBooking): string {
    if (booking.fare_amount == null) return '-';
    return '₹' + Number(booking.fare_amount).toFixed(2);
  }

  paymentLine(booking: FixedBooking): string {
    const method = this.paymentMethodLabel(booking);
    const status = booking.payment_status ? this.prettyToken(booking.payment_status) : 'Status unavailable';
    return method + ' · ' + status;
  }

  dateLine(booking: FixedBooking): string {
    const raw = booking.announced_depart_at || booking.depart_at || booking.created_at || booking.service_date;
    if (!raw) return '-';
    const date = new Date(raw);
    return isNaN(date.getTime()) ? raw : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  private syncFixedLocationStream(): void {
    if (this.booking && ['BOOKED', 'CONFIRMED'].includes((this.booking.status || '').toUpperCase())) void this.fixedLocation.start();
    else void this.fixedLocation.stop();
  }

  private prettyToken(value: string): string {
    return value.toString().toLowerCase().split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  }

  private async showToast(message: string): Promise<void> {
    const toast = await this.toasts.create({ message, duration: 2200, position: 'bottom' });
    await toast.present();
  }
}
