import { CUSTOMER_MAP_STYLE, fitCustomerMap } from '../../core/customer-map';
import { Component, NgZone } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../core/api.service';
import {
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
  buildPassengerMarkerElement,
} from '../../core/car-marker.helper';
import { PlacesService } from '../../core/places.service';
import { RealtimeService, TripLocationPayload } from '../../core/realtime.service';

declare const google: any;

interface FixedBooking {
  id: number;
  trip_id?: number | null;
  route_name?: string | null;
  board?: string | null;
  drop?: string | null;
  board_lat?: number | null;
  board_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  status?: string | null;
  driver_name?: string | null;
  map_marker_url?: string | null;
  image_url?: string | null;
  vehicle?: any;
  departure?: any;
  latest_driver_location?: { lat: number; lng: number; recorded_at?: string | null } | null;
}

@Component({
  selector: 'app-fixed-route-map',
  templateUrl: './fixed-route-map.page.html',
  styleUrls: ['./fixed-route-map.page.scss'],
  standalone: false,
})
export class FixedRouteMapPage {
  booking: FixedBooking | null = null;
  loading = false;
  error: string | null = null;
  liveTrackingActive = false;

  private map: any | null = null;
  private pickupMarker: any | null = null;
  private dropMarker: any | null = null;
  private driverMarker: any | null = null;
  private routePolylines: any[] = [];
  private driverPosition: { lat: number; lng: number } | null = null;
  private driverBearing = 0;
  private trackingTripId: number | null = null;
  private unsubscribeTracking: (() => void) | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
    private places: PlacesService,
    private realtime: RealtimeService,
    private zone: NgZone,
  ) {}

  ionViewWillEnter(): void {
    this.loadBooking();
  }

  ionViewWillLeave(): void {
    this.clearMap();
  }

  back(): void {
    this.router.navigateByUrl('/customer-tabs/go');
  }

  bookingStatusLabel(): string {
    switch ((this.booking?.status || '').toUpperCase()) {
      case 'BOOKED':
      case 'CONFIRMED':
        return 'Booking confirmed';
      case 'BOARDED':
        return 'Boarded';
      case 'DROPPED':
        return 'Dropped off';
      case 'COMPLETED':
        return 'Ride completed';
      case 'NO_SHOW':
        return 'No-show';
      case 'CANCELLED':
        return 'Cancelled';
      default:
        return this.booking?.status || 'Route map';
    }
  }

  private loadBooking(): void {
    const id = Number(this.route.snapshot.paramMap.get('bookingId'));
    if (!id) {
      this.error = 'Booking not found.';
      return;
    }

    this.loading = true;
    this.error = null;
    this.api.get<{ booking: FixedBooking }>('/fixed/bookings/' + id).subscribe({
      next: (res) => {
        const booking = res?.booking || null;
        this.booking = booking;
        this.loading = false;
        if (!booking) {
          this.error = 'Booking not found.';
          return;
        }
        if (['BOOKED', 'CONFIRMED', 'BOARDED'].includes(booking.status?.toUpperCase() ?? '')) {
          void this.router.navigateByUrl('/customer-tabs/fixed-rides/' + id, { replaceUrl: true });
          return;
        }
        if (!this.hasRouteCoords(booking)) {
          this.error = 'Map coordinates are not available for this booking.';
          return;
        }
        void this.renderMap(booking);
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Could not load fixed route map.';
      },
    });
  }

  private hasRouteCoords(booking: FixedBooking): boolean {
    return booking.board_lat != null && booking.board_lng != null && booking.drop_lat != null && booking.drop_lng != null;
  }

  private async renderMap(booking: FixedBooking): Promise<void> {
    try {
      await this.places.ensureLoaded();
      const div = document.getElementById('fixed-route-full-map');
      if (!div) return;

      const pickup = { lat: Number(booking.board_lat), lng: Number(booking.board_lng) };
      const drop = { lat: Number(booking.drop_lat), lng: Number(booking.drop_lng) };

      this.map = new google.maps.Map(div, {
        ...CUSTOMER_MAP_STYLE,
        center: pickup,
        zoom: 13,
        disableDefaultUI: true,
        clickableIcons: false,
        gestureHandling: 'greedy',
        mapId: 'DEMO_MAP_ID',
      });

      this.pickupMarker = new google.maps.marker.AdvancedMarkerElement({
        position: pickup,
        map: this.map,
        title: 'Pickup',
        content: buildPassengerMarkerElement({ kind: 'pickup', name: 'Pickup' }),
      });
      this.dropMarker = new google.maps.marker.AdvancedMarkerElement({
        position: drop,
        map: this.map,
        title: 'Drop',
        content: buildPassengerMarkerElement({ kind: 'drop', name: 'Drop' }),
      });

      await this.drawRoute(pickup, drop);
      this.seedDriverLocation(booking);
      this.subscribeLiveTracking(booking);
      this.frame(pickup, drop);
    } catch (e) {
      this.error = (e as Error)?.message || 'Could not load the map.';
    }
  }

  private async drawRoute(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<void> {
    if (!this.map) return;
    for (const pl of this.routePolylines) pl.setMap?.(null);
    this.routePolylines = [];
    // Route line eliminated as requested: customer sees only pickup/drop pins and driver live marker
  }

  private frame(a: { lat: number; lng: number }, b: { lat: number; lng: number }): void {
    if (!this.map) return;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(a);
    bounds.extend(b);
    if (this.driverMarker?.position) bounds.extend(this.driverMarker.position as any);
    fitCustomerMap(this.map, bounds, { top: 110, right: 42, bottom: 190, left: 42 });
  }

  private buildPin(letter: string, color: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'fixed-full-map-pin';
    el.style.background = color;
    el.textContent = letter;
    return el;
  }

  private seedDriverLocation(booking: FixedBooking): void {
    const latest = booking.latest_driver_location;
    if (!latest || latest.lat == null || latest.lng == null) return;
    this.driverPosition = { lat: Number(latest.lat), lng: Number(latest.lng) };
    this.ensureDriverMarker(booking);
  }

  private subscribeLiveTracking(booking: FixedBooking): void {
    const tripId = booking.trip_id || null;
    if (!tripId || !this.isLiveTrackingStatus(booking)) {
      this.stopTracking();
      return;
    }
    if (this.trackingTripId === tripId && this.unsubscribeTracking) return;
    this.stopTracking();
    this.trackingTripId = tripId;
    this.liveTrackingActive = true;
    this.unsubscribeTracking = this.realtime.subscribeTracking(
      tripId,
      (payload) => this.onTripLocation(payload),
      () => {},
    );
  }

  private isLiveTrackingStatus(booking: FixedBooking): boolean {
    return ['BOOKED', 'CONFIRMED', 'BOARDED'].includes((booking.status || '').toUpperCase());
  }

  private onTripLocation(payload: TripLocationPayload): void {
    const loc = payload?.location;
    if (!loc || loc.lat == null || loc.lng == null) return;
    this.zone.run(() => {
      this.driverPosition = { lat: Number(loc.lat), lng: Number(loc.lng) };
      if (loc.bearing_deg != null) {
        this.driverBearing = Number(loc.bearing_deg);
      }
      if (this.booking) this.ensureDriverMarker(this.booking);
    });
  }

  private ensureDriverMarker(booking: FixedBooking): void {
    if (!this.map || !this.driverPosition) return;
    if (!this.driverMarker) {
      this.driverMarker = new google.maps.marker.AdvancedMarkerElement({
        position: this.driverPosition,
        map: this.map,
        title: 'Driver',
        content: this.buildDriverMarker(),
      });
    } else {
      this.driverMarker.position = this.driverPosition;
      updateCarMarkerBearing(this.driverMarker, this.driverBearing);
      const markerUrl = (booking as any)?.map_marker_url
        || (booking as any)?.vehicle?.map_marker_url
        || (booking as any)?.departure?.map_marker_url
        || null;
      if (markerUrl) {
        updateCarMarkerImage(this.driverMarker, markerUrl);
      }
    }
  }

  private buildDriverMarker(): HTMLElement {
    return buildReusableCarMarkerElement({
      bearing: this.driverBearing,
      markerUrl: (this.booking as any)?.map_marker_url
        || (this.booking as any)?.vehicle?.map_marker_url
        || (this.booking as any)?.departure?.map_marker_url
        || null,

    });
  }

  private stopTracking(): void {
    if (this.unsubscribeTracking) this.unsubscribeTracking();
    this.unsubscribeTracking = null;
    this.trackingTripId = null;
    this.liveTrackingActive = false;
  }

  private clearMap(): void {
    this.stopTracking();
    if (this.pickupMarker) { this.pickupMarker.map = null; this.pickupMarker = null; }
    if (this.dropMarker) { this.dropMarker.map = null; this.dropMarker = null; }
    if (this.driverMarker) { this.driverMarker.map = null; this.driverMarker = null; }
    for (const pl of this.routePolylines) pl.setMap?.(null);
    this.routePolylines = [];
    this.driverPosition = null;
    this.map = null;
  }
}
