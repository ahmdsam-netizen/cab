import { CUSTOMER_MAP_STYLE, fitCustomerMap } from '../../core/customer-map';
import { Component } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { buildPassengerMarkerElement } from '../../core/car-marker.helper';
import { PlacesService } from '../../core/places.service';
import {
  coordsFromTrip,
  googleMapsDirectionsUrl,
  openExternalUrl,
} from '../../core/maps-navigation';

declare const google: any;

interface TripPayment {
  id: number;
  method?: string | null;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED' | string | null;
  amount?: number | null;
  discount_amount?: number | null;
  paid_at?: string | null;
  coupon_assignment_id?: number | null;
}

interface TripDriver {
  id: number;
  name?: string | null;
  phone?: string | null;
  avatar_path?: string | null;
  vehicle_reg_no?: string | null;
  vehicle?: any;
}

interface TripDetail {
  id: number;
  status: string;
  vehicle_name?: string | null;
  image_url?: string | null;
  map_marker_url?: string | null;
  ride_type?: { id: number; name: string } | null;
  pickup_address?: string | null;
  drop_address?: string | null;
  pickup_lat?: number | null;
  pickup_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  estimated_fare?: number | null;
  final_fare?: number | null;
  currency?: string | null;
  payment_method?: string | null;
  cancellation_fee_amount?: number | null;
  waiting_charge_amount?: number | null;
  tip_amount?: number | null;
  cancelled_reason?: string | null;
  no_show_by?: string | null;
  created_at?: string | null;
  negotiation_started_at?: string | null;
  confirmed_at?: string | null;
  assigned_at?: string | null;
  en_route_pickup_at?: string | null;
  arrived_pickup_at?: string | null;
  en_route_drop_at?: string | null;
  arrived_drop_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  payment?: TripPayment | null;
  driver?: TripDriver | null;
}

/**
 * Read-only trip summary screen. Customer arrives here from the My Trips list
 * to see the full breakdown of a past (or unpaid completed) ride.
 *
 * Payment gating:
 *   - payment.status === 'SUCCESS' → render no Pay button. The "Paid" badge
 *     and amount paid are enough.
 *   - status === 'COMPLETED' but no SUCCESS payment → render the Pay button.
 *     Clicking it navigates to /customer-tabs/trip/{id} (trip-active), which
 *     already owns the full coupon + payment-method flow. We don't duplicate
 *     that logic here.
 */
@Component({
  selector: 'app-trip-details',
  templateUrl: './trip-details.page.html',
  styleUrls: ['./trip-details.page.scss'],
  standalone: false,
})
export class TripDetailsPage {
  tripId!: number;
  loading = true;
  error: string | null = null;
  trip: TripDetail | null = null;

  // Embedded route map (pickup → drop with the road route drawn).
  mapsError: string | null = null;
  private map: any | null = null;
  private pickupMarker: any | null = null;
  private dropMarker: any | null = null;
  private routePolylines: any[] = [];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
    private places: PlacesService,
  ) {}

  ionViewWillEnter(): void {
    this.tripId = Number(this.route.snapshot.paramMap.get('tripId'));
    if (!Number.isFinite(this.tripId) || this.tripId < 1) {
      this.error = 'Invalid trip.';
      this.loading = false;
      return;
    }
    this.refresh();
  }

  ionViewWillLeave(): void {
    this.clearMap();
  }

  refresh(): void {
    this.loading = true;
    this.error = null;
    this.api.get<{ trip: TripDetail }>(`/customer/trips/${this.tripId}`).subscribe({
      next: (res) => {
        this.trip = res?.trip ?? null;
        // Let the *ngIf map container render, then draw the route into it.
        if (this.hasRouteCoords) setTimeout(() => this.renderMap(), 60);
      },
      error: (err) => {
        this.error = err?.error?.message || 'Could not load trip';
        this.trip = null;
      },
      complete: () => { this.loading = false; },
    });
  }

  // ── Derived helpers ─────────────────────────────────────────────

  /** True when the trip is completed but no successful payment exists. */
  get needsPayment(): boolean {
    if (!this.trip) return false;
    if (this.trip.status !== 'COMPLETED') return false;
    return this.trip.payment?.status !== 'SUCCESS';
  }

  get isPaid(): boolean {
    return this.trip?.payment?.status === 'SUCCESS';
  }

  /**
   * The single source of truth for the amount due. Once paid, show what was
   * actually charged (payment.amount); before that, show the final fare — which
   * is exactly what the pay endpoints charge — so the button and the breakdown
   * never disagree.
   */
  get payableAmount(): number | null {
    const t = this.trip;
    if (!t) return null;
    if (this.isPaid) return t.payment?.amount ?? t.final_fare ?? null;
    return t.final_fare ?? t.payment?.amount ?? null;
  }

  statusLabel(): string {
    const t = this.trip;
    if (!t) return '';
    if (t.status === 'COMPLETED') return 'Completed';
    if (t.status === 'CANCELLED') return t.no_show_by ? 'Missed' : 'Cancelled';
    return t.status;
  }

  statusColor(): string {
    const t = this.trip;
    if (!t) return 'primary';
    if (t.status === 'COMPLETED') return 'success';
    if (t.status === 'CANCELLED') return t.no_show_by ? 'warning' : 'medium';
    return 'primary';
  }

  paymentBadge(): { label: string; color: string } | null {
    if (!this.trip) return null;
    if (this.isPaid) return { label: 'Paid', color: 'success' };
    if (this.trip.status === 'COMPLETED') return { label: 'Unpaid', color: 'danger' };
    return null;
  }

  currency(): string {
    return this.trip?.currency || 'INR';
  }

  /**
   * Build the fare breakdown from whatever fields are persisted. Lines that
   * resolve to 0 / null are skipped.
   */
  breakdownRows(): { label: string; value: string; negative?: boolean; emphasis?: boolean }[] {
    const t = this.trip;
    if (!t) return [];
    const rows: { label: string; value: string; negative?: boolean; emphasis?: boolean }[] = [];

    if (t.estimated_fare != null) {
      rows.push({ label: 'Estimated fare', value: `₹${t.estimated_fare}` });
    }
    if (t.final_fare != null) {
      rows.push({ label: 'Final fare', value: `₹${t.final_fare}` });
    }
    if (t.payment?.discount_amount && t.payment.discount_amount > 0) {
      rows.push({
        label: 'Coupon discount',
        value: `-₹${t.payment.discount_amount}`,
        negative: true,
      });
    }
    if (t.waiting_charge_amount && t.waiting_charge_amount > 0) {
      rows.push({ label: 'Waiting charge', value: `₹${t.waiting_charge_amount}` });
    }
    if (t.tip_amount && t.tip_amount > 0) {
      rows.push({ label: 'Tip', value: `₹${t.tip_amount}` });
    }
    if (t.cancellation_fee_amount && t.cancellation_fee_amount > 0) {
      rows.push({ label: 'Cancellation fee', value: `₹${t.cancellation_fee_amount}` });
    }
    const payable = this.payableAmount;
    if (payable != null) {
      rows.push({
        label: this.isPaid ? 'Paid' : 'Payable',
        value: `₹${payable}`,
        emphasis: true,
      });
    }
    return rows;
  }

  /**
   * Timeline of stamped trip transitions — only steps that actually happened
   * are returned, ordered chronologically.
   */
  timeline(): { label: string; at: string }[] {
    const t = this.trip;
    if (!t) return [];
    const candidates: { label: string; at?: string | null }[] = [
      { label: 'Booked',          at: t.created_at },
      { label: 'In negotiation',  at: t.negotiation_started_at },
      { label: 'Confirmed',       at: t.confirmed_at },
      { label: 'Driver assigned', at: t.assigned_at },
      { label: 'En route',        at: t.en_route_pickup_at },
      { label: 'At pickup',       at: t.arrived_pickup_at },
      { label: 'Ride started',    at: t.en_route_drop_at },
      { label: 'At drop',         at: t.arrived_drop_at },
      { label: 'Completed',       at: t.completed_at },
      { label: 'Cancelled',       at: t.cancelled_at },
    ];
    return candidates
      .filter((c): c is { label: string; at: string } => !!c.at)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  // ── Actions ─────────────────────────────────────────────────────

  /** Header back button — returns to the Rides list. */
  back(): void {
    this.router.navigateByUrl('/customer-tabs/my-trips');
  }

  /**
   * Pay → hand off to the active-trip page, which owns the full coupon +
   * payment-method flow. We don't duplicate that logic here.
   */
  payNow(): void {
    if (!this.trip) return;
    this.router.navigateByUrl(`/customer-tabs/trip/${this.trip.id}`);
  }

  openMaps(): void {
    if (!this.trip) return;
    const pickup = coordsFromTrip(this.trip as any, 'pickup_lat', 'pickup_lng');
    const drop = coordsFromTrip(this.trip as any, 'drop_lat', 'drop_lng');
    if (!pickup || !drop) return;
    openExternalUrl(
      googleMapsDirectionsUrl({ origin: pickup, destination: drop, travelmode: 'driving' }),
    );
  }

  // ── Embedded route map ───────────────────────────────────────────

  /** Both endpoints present — enough to draw a route on the map. */
  get hasRouteCoords(): boolean {
    const t = this.trip;
    return !!(t && t.pickup_lat != null && t.pickup_lng != null && t.drop_lat != null && t.drop_lng != null);
  }

  /** Build the map, drop pickup/drop pins, draw the road route, then frame it. */
  private async renderMap(): Promise<void> {
    if (!this.hasRouteCoords || !this.trip) return;
    try {
      await this.places.ensureLoaded();
      const div = document.getElementById('detail-map');
      if (!div) return;

      const pickup = { lat: Number(this.trip.pickup_lat), lng: Number(this.trip.pickup_lng) };
      const drop = { lat: Number(this.trip.drop_lat), lng: Number(this.trip.drop_lng) };

      this.map = new google.maps.Map(div, {
        ...CUSTOMER_MAP_STYLE,
        center: pickup,
        disableDefaultUI: true,
        clickableIcons: false,
        // Two-finger pan so the page still scrolls with one finger.
        gestureHandling: 'cooperative',
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
      this.frame(pickup, drop);
      this.mapsError = null;
    } catch (e) {
      this.mapsError = (e as Error)?.message || 'Could not load the map.';
    }
  }

  /**
   * Draw the road route between two points. Tries the new Routes API first,
   * falls back to the legacy DirectionsService, then to a straight line.
   * Route polylines eliminated: customer sees only pickup and drop pins.
   */
  private async drawRoute(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<void> {
    if (!this.map) return;
    for (const pl of this.routePolylines) pl.setMap?.(null);
    this.routePolylines = [];
  }

  /** Fit the map so the whole pickup → drop route is visible. */
  private frame(a: { lat: number; lng: number }, b: { lat: number; lng: number }): void {
    if (!this.map) return;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(a);
    bounds.extend(b);
    fitCustomerMap(this.map, bounds, 56);
  }

  /** Letter pin (A = pickup, B = drop) — matches the booking/active-trip maps. */
  private buildPin(letter: string, color: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'width:28px', 'height:36px', 'display:flex', 'align-items:flex-start',
      'justify-content:center', 'padding-top:4px', 'font-weight:700', 'font-size:13px',
      'color:#fff', `background:${color}`, 'border-radius:50% 50% 50% 0',
      'transform:rotate(-45deg) translate(0,-14px)', 'border:2px solid #fff',
      'box-shadow:0 1px 4px rgba(0,0,0,0.4)',
    ].join(';');
    const inner = document.createElement('span');
    inner.textContent = letter;
    inner.style.cssText = 'transform:rotate(45deg);';
    el.appendChild(inner);
    return el;
  }

  private clearMap(): void {
    for (const pl of this.routePolylines) pl.setMap?.(null);
    this.routePolylines = [];
    if (this.pickupMarker) { this.pickupMarker.map = null; this.pickupMarker = null; }
    if (this.dropMarker) { this.dropMarker.map = null; this.dropMarker = null; }
    this.map = null;
  }
}
