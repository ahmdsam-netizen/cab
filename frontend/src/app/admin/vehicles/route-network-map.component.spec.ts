import { NgZone } from '@angular/core';
import { RouteNetworkMapComponent } from './route-network-map.component';
import { GoogleMapsLoaderService } from '../../core/google-maps-loader.service';
import { MasterRoute } from './master-explorer.component';

describe('Route catalogue map geometry', () => {
  const base: MasterRoute = { id: 1, name: 'Route', scope: 'local', origin_name: 'A', dest_name: 'B', flat_fare: 20, booking_window_hours: 2, is_active: true, city_vehicle_type_id: null };
  const map = () => new RouteNetworkMapComponent({} as GoogleMapsLoaderService, {} as NgZone);
  it('does not redraw Maps when change detection produces the same filtered routes', async () => {
    const component = new RouteNetworkMapComponent({} as GoogleMapsLoaderService, new NgZone({ enableLongStackTrace: false }));
    const render = spyOn<any>(component, 'render').and.returnValue(Promise.resolve());
    component.routes = [base]; component.ngAfterViewInit(); await Promise.resolve();
    component.routes = [base]; component.ngOnChanges(); component.ngOnChanges();
    expect(render).toHaveBeenCalledTimes(1);
    component.selectedRouteId = 1; component.ngOnChanges();
    expect(render).toHaveBeenCalledTimes(2);
    component.routes = [{ ...base, name: 'Updated route' }]; component.ngOnChanges();
    expect(render).toHaveBeenCalledTimes(3); component.ngOnDestroy();
  });
  it('uses the configured path before stops and never changes source geometry', () => {
    const route = { ...base, path_polyline: [{ lat: 34, lng: 74 }, { lat: 34.1, lng: 74.2 }], stops: [{ id: 1, lat: 35, lng: 75 }] };
    const before = JSON.stringify(route); expect(map().path(route)).toEqual(route.path_polyline);
    expect(JSON.stringify(route)).toBe(before);
  });
  it('uses ordered stop coordinates when a path is missing or invalid', () => {
    expect(map().path({ ...base, path_polyline: [{ lat: NaN, lng: 74 }], stops: [{ id: 2, seq: 2, lat: 34.2, lng: 74.2 }, { id: 1, seq: 1, lat: 34.1, lng: 74.1 }, { id: 3, seq: 3, lat: null, lng: null }] })).toEqual([{ lat: 34.1, lng: 74.1 }, { lat: 34.2, lng: 74.2 }]);
  });
  it('falls back to valid endpoints and never invents a default location', () => {
    expect(map().path(base)).toEqual([]);
    expect(map().path({ ...base, origin_lat: 34, origin_lng: 74, dest_lat: 34.2, dest_lng: 74.3 })).toEqual([{ lat: 34, lng: 74 }, { lat: 34.2, lng: 74.3 }]);
    expect(map().path({ ...base, origin_lat: 134, origin_lng: 74, dest_lat: 34, dest_lng: 274 })).toEqual([]);
  });
});
