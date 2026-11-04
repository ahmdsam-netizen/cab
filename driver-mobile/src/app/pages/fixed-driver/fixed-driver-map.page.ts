import { Component, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { interval, Subscription } from 'rxjs';
import { customerMarkerSignature, hasCustomerLocation, isCustomerLocationLive } from '../../core/customer-location.helper';
import { ApiService } from '../../core/api.service';
import {
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
  buildPassengerMarkerElement,
  buildStopMarkerElement,
} from '../../core/car-marker.helper';
import { GeoFix, GeolocationService } from '../../core/geolocation.service';
import { PlacesService } from '../../core/places.service';
import { haversineDistanceMeters } from './fixed-driver.page';
import { NavigationRouteRenderer } from '../../core/navigation-route.helper';

declare const google: any;

interface FixedVehicle {
  id: number;
  route_name: string;
  origin_name?: string | null;
  dest_name?: string | null;
  status: string;
  fixed_last_reached_stop_seq?: number | null;
  map_marker_url?: string | null;
  image_url?: string | null;
}

interface FixedStop {
  id: number;
  seq: number;
  name: string;
  lat?: number | null;
  lng?: number | null;
  is_active?: boolean;
  is_temporarily_unavailable?: boolean;
}

interface FixedPassenger {
  id?: number;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_lat?: number | null;
  customer_lng?: number | null;
  customer_location_updated_at?: string | null;
  seats?: number | null;
  status?: string | null;
  board_stop_id?: number | null;
  drop_stop_id?: number | null;
  board?: string | null;
  drop?: string | null;
  board_lat?: number | null;
  board_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  customer_avatar_url?: string | null;
}

interface FixedCitySettings {
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
  stops?: FixedStop[];
  passengers?: FixedPassenger[];
  city_settings?: FixedCitySettings;
}

@Component({
  selector: 'app-fixed-driver-map',
  templateUrl: './fixed-driver-map.page.html',
  styleUrls: ['./fixed-driver-map.page.scss'],
  standalone: false,
})
export class FixedDriverMapPage implements OnDestroy {
  loading = false;
  error: string | null = null;
  vehicle: FixedVehicle | null = null;
  stops: FixedStop[] = [];
  passengers: FixedPassenger[] = [];
  private renderedPassengerSignature = '';
  citySettings: FixedCitySettings | null = null;
  selectedStopDetail: StopDetailModalData | null = null;
  driverPosition: { lat: number; lng: number } | null = null;

  private map: any = null;
  private routeLine: any = null;
  private navRoute = new NavigationRouteRenderer();
  private stopMarkers: any[] = [];
  private passengerMarkers: any[] = [];
  private selfMarker: any = null;
  private selfWatchId: string | null = null;
  private manifestPoll?: Subscription;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
    private places: PlacesService,
    private geo: GeolocationService,
  ) {}

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

  ionViewWillEnter(): void {
    this.load(true);
    this.startPolling();

    void this.geo.getCurrentPosition({ timeout: 8000, maximumAge: 15000 }).then((fix) => {
      if (fix) {
        this.driverPosition = { lat: fix.lat, lng: fix.lng };
        this.updatePassengerMarkerDistances();
      }
    }).catch(() => {});
  }

  ionViewWillLeave(): void {
    this.stopPolling();
    void this.stopDriverWatch();
    this.resetMap();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    void this.stopDriverWatch();
    this.resetMap();
  }

  private startPolling(): void {
    this.stopPolling();
    this.manifestPoll = interval(4000).subscribe(() => {
      this.load(false);
    });
  }

  private stopPolling(): void {
    if (this.manifestPoll) {
      this.manifestPoll.unsubscribe();
      this.manifestPoll = undefined;
    }
  }

  back(): void {
    void this.router.navigateByUrl('/tabs/fixed');
  }

  get routeOriginName(): string {
    const raw = this.vehicle?.origin_name;
    if (raw && raw.trim().toLowerCase() !== 'origin') return raw.trim();
    if (this.stops.length > 0 && this.stops[0]?.name) return this.stops[0].name;
    const rName = this.vehicle?.route_name;
    if (rName) {
      if (rName.includes('->')) return rName.split('->')[0].trim();
      if (rName.includes('→')) return rName.split('→')[0].trim();
      if (rName.toLowerCase().includes(' to ')) return rName.split(/ to /i)[0].trim();
    }
    return this.stops[0]?.name || 'Origin';
  }

  get routeDestName(): string {
    const raw = this.vehicle?.dest_name;
    if (raw && raw.trim().toLowerCase() !== 'destination') return raw.trim();
    if (this.stops.length > 1 && this.stops[this.stops.length - 1]?.name) {
      return this.stops[this.stops.length - 1].name;
    }
    const rName = this.vehicle?.route_name;
    if (rName) {
      if (rName.includes('->')) return rName.split('->')[1].trim();
      if (rName.includes('→')) return rName.split('→')[1].trim();
      if (rName.toLowerCase().includes(' to ')) return rName.split(/ to /i)[1].trim();
    }
    return this.stops[this.stops.length - 1]?.name || 'Destination';
  }

  routeLineText(): string {
    if (!this.vehicle) return 'Fixed route';
    const orig = this.routeOriginName;
    const dest = this.routeDestName;
    if (orig && dest && orig !== 'Origin' && dest !== 'Destination') return orig + ' to ' + dest;
    return this.vehicle.route_name || 'Fixed route';
  }

  passengerSummaryText(): string {
    const waiting = this.passengers.filter((passenger) => ['BOOKED', 'CONFIRMED'].includes((passenger.status || '').toUpperCase())).length;
    const boarded = this.passengers.filter((passenger) => (passenger.status || '').toUpperCase() === 'BOARDED').length;
    if (!this.passengers.length) return 'No passengers yet';
    return waiting + ' waiting · ' + boarded + ' boarded';
  }

  load(showSpinner = true): void {
    const departureId = Number(this.route.snapshot.paramMap.get('departureId') || 0);
    if (!departureId) {
      this.error = 'Fixed vehicle not found.';
      return;
    }

    if (showSpinner) this.loading = true;
    this.error = null;

    const oldRadius = Number(this.citySettings?.fixed_stop_arrival_radius_m || 0);
    const oldStopsJson = JSON.stringify(this.stops.map((s) => ({ id: s.id, seq: s.seq })));
    const oldPassengersJson = this.renderedPassengerSignature;
    const oldCitySettingsJson = JSON.stringify(this.citySettings || {});
    const hadMap = !!this.map;

    this.api.get<ManifestResponse>(`/fixed/departures/${departureId}/manifest`).subscribe({
      next: (res) => {
        this.vehicle = res.departure;
        const depMarkerUrl = res.departure?.map_marker_url || (res.departure as any)?.vehicle?.map_marker_url || null;
        if (this.selfMarker && depMarkerUrl) {
          updateCarMarkerImage(this.selfMarker, depMarkerUrl);
        }
        this.passengers = res.passengers ?? [];
        this.stops = this.visibleManifestStops(res.stops ?? [], this.passengers);
        this.citySettings = res.city_settings || null;

        // Live update stop detail popup if open
        if (this.selectedStopDetail) {
          this.openStopDetail(this.selectedStopDetail.stop);
        }

        const newRadius = Number(this.citySettings?.fixed_stop_arrival_radius_m || 0);
        const newStopsJson = JSON.stringify(this.stops.map((s) => ({ id: s.id, seq: s.seq })));
        const newPassengersJson = customerMarkerSignature(this.passengers);
        this.renderedPassengerSignature = newPassengersJson;
        const newCitySettingsJson = JSON.stringify(this.citySettings || {});

        if (!this.map) {
          requestAnimationFrame(() => void this.initMap());
        } else if (
          oldStopsJson !== newStopsJson ||
          oldPassengersJson !== newPassengersJson ||
          oldCitySettingsJson !== newCitySettingsJson ||
          oldRadius !== newRadius
        ) {
          this.refreshMap();
        }
      },
      error: (err) => {
        if (showSpinner) this.error = err?.error?.message || 'Could not load fixed route map.';
      },
      complete: () => {
        if (showSpinner) this.loading = false;
      },
    });
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

  private async initMap(): Promise<void> {
    try {
      await this.places.ensureLoaded();
      const div = document.getElementById('fixed-driver-full-map');
      if (!div) return;
      const firstStop = this.stops.find((stop) => this.hasStopCoords(stop));
      this.map = new google.maps.Map(div, {
        center: firstStop ? this.stopPosition(firstStop) : { lat: 28.6139, lng: 77.209 },
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: true,
        mapId: 'DEMO_MAP_ID',
      });
      this.refreshMap();
      void this.startDriverWatch();
    } catch {
      this.error = 'Could not load the map.';
    }
  }

  private refreshMap(): void {
    if (!this.map) return;
    this.clearRouteObjects();
    const routeStops = this.stops.filter((stop) => this.hasStopCoords(stop));
    if (!routeStops.length) {
      this.error = 'No stop coordinates are available for this route.';
      return;
    }

    // Route line with directional chevrons to the next upcoming stop
    const nextStop = routeStops.find((s) => Number(s.seq || 0) > this.completedStopSeq) || routeStops[routeStops.length - 1];
    const origin = this.driverPosition || (routeStops[0] ? this.stopPosition(routeStops[0]) : null);
    if (origin && nextStop) {
      void this.navRoute.render(this.map, origin, this.stopPosition(nextStop), 'drop');
    }

    this.stopMarkers = routeStops.map((stop) => {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        position: this.stopPosition(stop),
        map: this.map,
        title: stop.name,
        content: this.buildStopMarker(stop),
        zIndex: stop.seq,
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
    this.fitMap();
  }

  get completedStopSeq(): number {
    return ['FORMING', 'DISPATCHED'].includes(this.vehicle?.status || '')
      ? 0 : Number(this.vehicle?.fixed_last_reached_stop_seq || 0);
  }

  openStopDetail(stop: FixedStop): void {
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

  private onDriverPosition(fix: GeoFix): void {
    if (!this.map) return;
    const position = { lat: fix.lat, lng: fix.lng };
    const hadNoPosition = !this.driverPosition;
    this.driverPosition = position;
    this.navRoute.updateDriverProgress(position);
    if (hadNoPosition && this.stops.length) {
      const routeStops = this.stops.filter((stop) => this.hasStopCoords(stop));
      const nextStop = routeStops.find((s) => Number(s.seq || 0) > this.completedStopSeq) || routeStops[routeStops.length - 1];
      if (nextStop) {
        void this.navRoute.render(this.map, position, this.stopPosition(nextStop), 'drop');
      }
    }
    if (!this.selfMarker) {
      this.selfMarker = new google.maps.marker.AdvancedMarkerElement({
        position,
        map: this.map,
        title: 'You (Driver)',
        content: this.buildDriverMarker(fix.bearing ?? 0),
        zIndex: 1000,
      });
      this.fitMap();
      this.updatePassengerMarkerDistances();
      return;
    }
    this.selfMarker.position = position;
    if (fix.bearing != null) {
      updateCarMarkerBearing(this.selfMarker, fix.bearing);
    }
    const markerUrl = this.vehicle?.map_marker_url || (this.vehicle as any)?.vehicle?.map_marker_url || null;
    if (markerUrl) {
      updateCarMarkerImage(this.selfMarker, markerUrl);
    }
    this.updatePassengerMarkerDistances();
  }

  private fitMap(): void {
    if (!this.map) return;
    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const marker of [...this.stopMarkers, ...this.passengerMarkers, this.selfMarker]) {
      if (marker?.position) {
        bounds.extend(marker.position as any);
        any = true;
      }
    }
    if (any) this.map.fitBounds(bounds, 72);
  }

  private resetMap(): void {
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
    this.navRoute.clear();
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
      if (passenger.customer_lat != null && passenger.customer_lng != null &&
          Number.isFinite(Number(passenger.customer_lat)) && Number.isFinite(Number(passenger.customer_lng))) {
        return { lat: Number(passenger.customer_lat), lng: Number(passenger.customer_lng) };
      }
      if (passenger.board_lat != null && passenger.board_lng != null &&
          Number.isFinite(Number(passenger.board_lat)) && Number.isFinite(Number(passenger.board_lng))) {
        return { lat: Number(passenger.board_lat), lng: Number(passenger.board_lng) };
      }
      const stopId = passenger.board_stop_id;
      const stop = this.stops.find((item) => Number(item.id) === Number(stopId));
      return stop && this.hasStopCoords(stop) ? this.stopPosition(stop) : null;
    }

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
    return buildStopMarkerElement({
      seq: stop.seq,
      isReached: Number(stop.seq || 0) <= reachedSeq,
    });
  }

  private buildDriverMarker(bearing: number): HTMLElement {
    return buildReusableCarMarkerElement({
      bearing,
      label: 'You (Car)',
      markerUrl: this.vehicle?.map_marker_url || (this.vehicle as any)?.vehicle?.map_marker_url || null,
    });
  }
}
