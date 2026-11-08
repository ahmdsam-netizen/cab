import { AfterViewInit, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GoogleMapsLoaderService } from '../../core/google-maps-loader.service';
import { IconComponent } from '../../ui';
import { MasterRoute } from './master-explorer.component';

/** Read-only catalogue map. All editing still uses the existing route editor. */
@Component({
  selector: 'app-route-network-map', standalone: true, imports: [CommonModule, IconComponent],
  template: `<div class="map-shell"><div #canvas class="map-canvas" aria-label="Configured route network map"></div><div class="map-message" *ngIf="message"><tm-icon name="map" [size]="28" /><span>{{ message }}</span></div><span class="map-caption" *ngIf="!message"><i></i> Configured routes · select a line to view details</span></div>`,
  styles: [`.map-shell { height: 100%; min-height: 285px; position: relative; background: var(--tm-canvas); overflow: hidden; border-radius: 8px; }.map-canvas { position: absolute; inset: 0; }.map-message { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 25px; text-align: center; font-size: 12px; color: var(--tm-text-muted); }.map-caption { position: absolute; bottom: 25px; left: 12px; right: 45px; width: fit-content; display: flex; align-items: center; gap: 7px; background: var(--tm-surface); color: var(--tm-text); border: 1px solid var(--tm-line); border-radius: 5px; padding: 7px 10px; font-size: 9px; box-shadow: var(--tm-shadow-sm); pointer-events: none; }.map-caption i { height: 7px; width: 7px; border-radius: 50%; background: var(--tm-green); }`],
})
export class RouteNetworkMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() routes: MasterRoute[] = [];
  @Input() selectedRouteId: number | null = null;
  @Output() routeSelected = new EventEmitter<number>();
  @ViewChild('canvas') canvas?: ElementRef<HTMLDivElement>;
  message = 'No route coordinates available yet.';
  private map?: google.maps.Map;
  private overlays: (google.maps.Polyline | google.maps.Marker)[] = [];
  private ready = false;
  private destroyed = false;
  private initializing = false;
  private lastRoutes: MasterRoute[] = [];
  private lastSelection: number | null = null;
  private hasRequested = false;
  constructor(private loader: GoogleMapsLoaderService, private zone: NgZone) {}
  ngAfterViewInit(): void { this.ready = true; void Promise.resolve().then(() => { if (!this.destroyed) this.refresh(); }); }
  ngOnChanges(): void { if (this.ready) this.refresh(); }
  private refresh(): void {
    // The workspace filter returns a fresh array on change detection. Rebuilding
    // Maps for that array would make fitBounds trigger another render repeatedly.
    if (this.hasRequested && this.lastSelection === this.selectedRouteId && this.routes.length === this.lastRoutes.length && this.routes.every((route, index) => route === this.lastRoutes[index])) return;
    this.hasRequested = true;
    this.lastRoutes = [...this.routes]; this.lastSelection = this.selectedRouteId;
    void this.zone.runOutsideAngular(() => this.render());
  }
  private setMessage(message: string): void { if (this.message !== message) this.zone.run(() => { this.message = message; }); }
  path(route: MasterRoute): google.maps.LatLngLiteral[] {
    const valid = (p: { lat?: number | null; lng?: number | null }) => p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
    const configured = (route.path_polyline || []).filter(valid).map(p => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    // A single point cannot define a route. Prefer ordered stops to a straight endpoint fallback.
    if (configured.length > 1) return configured;
    const stops = [...(route.stops || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).filter(valid).map(p => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    if (stops.length > 1) return stops;
    return [{ lat: route.origin_lat, lng: route.origin_lng }, { lat: route.dest_lat, lng: route.dest_lng }].filter(valid).map(p => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  }
  private clear(): void { this.overlays.forEach(item => { google.maps.event.clearInstanceListeners(item); item.setMap(null); }); this.overlays = []; }
  private async render(): Promise<void> {
    const routes = this.routes.filter(route => this.path(route).length > 1);
    if (!routes.length) { if (this.map) this.clear(); this.setMessage('No route coordinates available yet.'); return; }
    if (!this.map) {
      if (this.initializing) return;
      this.initializing = true; this.setMessage('Loading route map…');
      try {
        await this.loader.load();
        if (this.destroyed || !this.canvas) return;
        this.map = new google.maps.Map(this.canvas.nativeElement, { center: this.path(routes[0])[0], zoom: 11, mapTypeControl: false, streetViewControl: false, fullscreenControl: true, gestureHandling: 'cooperative', clickableIcons: false });
      } catch { if (!this.destroyed) this.setMessage('Route map is unavailable. Your routes remain available below.'); return; }
      finally { this.initializing = false; }
      // Inputs may change while the shared Maps script is loading.
      if (!this.destroyed) await this.render();
      return;
    }
    this.clear(); this.setMessage('');
    const bounds = new google.maps.LatLngBounds();
    const colors = ['#16a34a', '#2563eb', '#d97706', '#0d9488', '#7c3aed'];
    routes.forEach((route, index) => {
      const path = this.path(route), color = colors[index % colors.length];
      path.forEach(point => bounds.extend(point));
      const line = new google.maps.Polyline({ map: this.map, path, strokeColor: color, strokeOpacity: this.selectedRouteId && this.selectedRouteId !== route.id ? .4 : .9, strokeWeight: this.selectedRouteId === route.id ? 5 : 3, zIndex: this.selectedRouteId === route.id ? 2 : 1 });
      line.addListener('click', () => this.zone.run(() => this.routeSelected.emit(route.id)));
      this.overlays.push(line);
      const marker = new google.maps.Marker({ map: this.map, position: path[0], title: route.name, icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 6 } });
      marker.addListener('click', () => this.zone.run(() => this.routeSelected.emit(route.id)));
      this.overlays.push(marker);
    });
    this.map.fitBounds(bounds, 30);
  }
  ngOnDestroy(): void { this.destroyed = true; if (this.map) { this.clear(); google.maps.event.clearInstanceListeners(this.map); } }
}
