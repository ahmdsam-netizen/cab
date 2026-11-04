import { DriverMapCamera, DRIVER_MAP_STYLE } from '../core/driver-map';
import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MapsLoaderService } from '../core/maps-loader.service';
import { buildReusableCarMarkerElement, buildStopMarkerElement, updateCarMarkerImage } from '../core/car-marker.helper';

declare const google: any;
type Position = { lat: number; lng: number };

@Component({
  selector: 'app-stop-arrival-map', standalone: true, imports: [CommonModule],
  template: `
    <div #mapHost class="arrival-map-canvas" aria-label="Stop and driver map"></div>
    <span class="arrival-map-error" *ngIf="error">{{ error }}</span>
  `,
  styles: [`
    :host { display: block; position: relative; height: 100%; background: #e5eee6; }
    .arrival-map-canvas { height: 100%; width: 100%; }
    .arrival-map-error { position: absolute; inset: 0; display: grid; place-items: center; font-size: 13px; color: #48616b; padding: 18px; text-align: center; }
  `],
})
export class StopArrivalMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() stop: { name: string; seq?: number; lat?: number | null; lng?: number | null } | null = null;
  @Input() driver: Position | null = null;
  @Input() reached = false;
  @Input() markerUrl: string | null = null;
  @ViewChild('mapHost') host?: ElementRef<HTMLElement>;
  error = '';
  private ready = false;
  private generation = 0;
  private map: any;
  private stopMarker: any;
  private driverMarker: any;
  private camera = new DriverMapCamera();
  constructor(private loader: MapsLoaderService) {}
  ngAfterViewInit(): void {
    this.ready = true;
    void Promise.resolve().then(() => { if (this.ready) void this.render(); });
  }
  ngOnChanges(): void { if (this.ready) void this.render(); }
  ngOnDestroy(): void {
    this.ready = false; this.generation++;
    this.camera.reset();
    this.removeDriverMarker();
    if (this.stopMarker) this.stopMarker.map = null;
    this.stopMarker = null;
    this.map = null;
  }
  private valid(position: { lat?: number | null; lng?: number | null } | null): position is Position {
    return position?.lat != null && position.lng != null && Number.isFinite(position.lat) &&
      Number.isFinite(position.lng) && Math.abs(position.lat) <= 90 && Math.abs(position.lng) <= 180;
  }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    if (!this.valid(this.stop)) { this.error = 'Stop location unavailable'; return; }
    this.error = '';
    try {
      await this.loader.ensureLoaded();
      if (!this.ready || generation !== this.generation || !this.host) return;
      const stop = { lat: Number(this.stop!.lat), lng: Number(this.stop!.lng) };
      this.map ??= new google.maps.Map(this.host.nativeElement, {
        ...DRIVER_MAP_STYLE,
        center: stop, maxZoom: 18, mapId: 'DEMO_MAP_ID', disableDefaultUI: true,
        gestureHandling: 'cooperative', clickableIcons: false,
      });
      if (this.stopMarker) this.stopMarker.map = null;
      const pin = buildStopMarkerElement({
        seq: this.stop!.seq ?? 1, name: this.stop!.name, isNext: true, isReached: this.reached,
      });
      this.stopMarker = new google.maps.marker.AdvancedMarkerElement({
        map: this.map, position: stop, content: pin, title: this.stop!.name,
      });
      if (this.valid(this.driver)) {
        this.driverMarker ??= new google.maps.marker.AdvancedMarkerElement({
          map: this.map, position: this.driver,
          content: buildReusableCarMarkerElement({ label: 'You (Car)', markerUrl: this.markerUrl }),
          title: 'Your current location', zIndex: 2,
        });
        if (this.markerUrl) updateCarMarkerImage(this.driverMarker, this.markerUrl);
        this.camera.follow(this.map, this.driver, null, this.driverMarker);
      } else {
        this.camera.reset();
        this.removeDriverMarker();
        this.map.moveCamera({ center: stop, tilt: DRIVER_MAP_STYLE.tilt, zoom: DRIVER_MAP_STYLE.zoom });
      }
    } catch {
      if (this.ready && generation === this.generation) this.error = 'Map unavailable. You can still view passengers below.';
    }
  }

  private removeDriverMarker(): void {
    if (this.driverMarker) this.driverMarker.map = null;
    this.driverMarker = null;
  }
}
