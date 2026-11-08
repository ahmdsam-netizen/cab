import { FixedBookPage } from './fixed.page';
import { Subject } from 'rxjs';

describe('Customer route category filters', () => {
  let page: FixedBookPage;
  beforeEach(() => {
    page = Object.create(FixedBookPage.prototype);
    Object.assign(page, {
      routeScope: 'all', search: '', radiusFilterActive: true,
      userCoords: { lat: 34, lng: 74 },
      cdr: { markForCheck: jasmine.createSpy() },
      routes: [
        { id: 1, scope: 'local', distance_to_start: 100 },
        { id: 2, scope: 'outstation', distance_to_start: 200 },
        { id: 3, scope: 'outstation', distance_to_start: 1500 },
        { id: 4, scope: 'local', distance_to_start: null },
      ],
    });
  });

  it('opens the requested Home route once, using the loaded catalogue', () => {
    const target = page as any;
    target.activatedRoute = { snapshot: { queryParamMap: { get: () => '2' } } };
    target.loading = false;
    const pick = spyOn(page, 'pickRoute');
    page.ionViewWillEnter();
    expect(pick).toHaveBeenCalledOnceWith(page.routes[1]);
    target.openRequestedHomeRoute();
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('waits for route data and handles a removed Home route without selecting another', () => {
    const target = page as any;
    target.activatedRoute = { snapshot: { queryParamMap: { get: () => '99' } } };
    target.loading = true;
    const pick = spyOn(page, 'pickRoute');
    page.ionViewWillEnter();
    expect(pick).not.toHaveBeenCalled();
    target.openRequestedHomeRoute();
    expect(pick).not.toHaveBeenCalled();
    expect(page.error).toContain('no longer available');
  });

  it('keeps an existing hold when arriving from a Home route card', () => {
    const target = page as any;
    target.requestedHomeRouteId = 2;
    target.hold = { id: 7 };
    const pick = spyOn(page, 'pickRoute');
    target.openRequestedHomeRoute();
    expect(pick).not.toHaveBeenCalled();
    expect(target.hold.id).toBe(7);
  });

  it('keeps nearby and all-route results within the selected category', () => {
    page.setRouteScope('outstation');
    expect(page.visibleRoutes.map(route => route.id)).toEqual([2]);
    expect(page.nearbyRoutesCount).toBe(1);
    expect(page.scopedRoutes.length).toBe(2);
    page.setRadiusFilter(false);
    expect(page.visibleRoutes.map(route => route.id)).toEqual([2, 3]);
    page.setRouteScope('local');
    expect(page.visibleRoutes.map(route => route.id)).toEqual([1, 4]);
    page.setRouteScope('all');
    expect(page.visibleRoutes.length).toBe(4);
  });

  it('preserves the category for search results even when nearby filtering is bypassed', () => {
    page.search = 'matching route';
    page.setRouteScope('outstation');
    expect(page.visibleRoutes.map(route => route.id)).toEqual([2, 3]);
    page.setRouteScope('local');
    expect(page.visibleRoutes.map(route => route.id)).toEqual([1, 4]);
  });

  it('works without location permission and returns no unrelated routes for an empty category', () => {
    page.userCoords = null;
    page.setRouteScope('local');
    expect(page.visibleRoutes.map(route => route.id)).toEqual([1, 4]);
    page.routes = page.routes.filter(route => route.scope === 'outstation');
    expect(page.visibleRoutes).toEqual([]);
    expect(page.nearbyRoutesCount).toBe(0);
    page.setRouteScope('all');
    expect(page.visibleRoutes.length).toBe(2);
  });

  it('updates the nearest pickup and distance from live fixes and unsubscribes on destruction', async () => {
    const fixes = new Subject<any>();
    const target = page as any;
    const stop = (id: number, lat: number) => ({ id, seq: id, name: `Stop ${id}`, lat, lng: 74, is_pickup: true, is_active: true, is_temporarily_unavailable: false });
    Object.assign(target, {
      userCoords: null, cities: [],
      routes: [{ id: 1, scope: 'local', stops: [stop(1, 34), stop(2, 34.01)] }],
      booking: { trip: { cityId: 1 } },
      fixedLocation: { fix$: fixes, start: async () => {} },
      initUserLocation: async () => {}, loadCities: async () => {}, loadRoutes: () => {}, checkActiveHold: () => {},
      paymentOptions: { load: async () => ({}) }, stopApprovalWaiting: () => {},
    });
    await page.ngOnInit();
    fixes.next({ lat: 34.001, lng: 74, accuracy: 10 });
    expect(page.routes[0].nearest_pickup_stop?.id).toBe(1);
    expect(page.routes[0].distance_to_nearest_pickup).toBe(111);
    expect(page.routes[0].starting_stop?.id).toBe(1);
    expect(page.routes[0].distance_to_start).toBe(111);
    fixes.next({ lat: 34.009, lng: 74, accuracy: 20 });
    expect(page.routes[0].nearest_pickup_stop?.id).toBe(2);
    expect(page.routes[0].starting_stop?.id).toBe(1);
    expect(page.routes[0].distance_to_start).toBe(1001);
    expect(page.visibleRoutes).toEqual([]);
    expect(page.locationAccuracy).toBe(20);
    page.ngOnDestroy();
    fixes.next({ lat: 34, lng: 74, accuracy: 5 });
    expect(page.routes[0].nearest_pickup_stop?.id).toBe(2);
  });

  it('ranks and filters by the first stop even when a later pickup is closer', () => {
    const stop = (id: number, seq: number, lat: number) => ({ id, seq, name: `Stop ${id}`, lat, lng: 74, is_pickup: true, is_active: true, is_temporarily_unavailable: false });
    const target = page as any;
    page.routes = [
      { id: 1, scope: 'local', stops: [stop(2, 2, 34.0001), stop(1, 1, 34.02)] },
      { id: 2, scope: 'local', stops: [stop(3, 1, 34.005)] },
    ] as any;
    target.annotateRoutesWithProximity();
    target.sortRoutesByProximity();
    expect(page.routes.map(route => route.id)).toEqual([2, 1]);
    expect(page.routes[1].starting_stop?.id).toBe(1);
    expect(page.routes[1].nearest_pickup_stop?.id).toBe(2);
    expect(page.visibleRoutes.map(route => route.id)).toEqual([2]);
    expect(page.nearbyRoutesCount).toBe(1);
    page.setRadiusFilter(false);
    expect(page.visibleRoutes.map(route => route.id)).toEqual([2, 1]);
  });

  it('proves 10 routes show only the 5 starts within 1 km, closest first, and All routes shows all 10 in order', () => {
    const distances = [100, 250, 500, 750, 1000, 1001, 1500, 2000, 3000, 5000];
    // Place the starts north of the GPS fix; scramble the incoming route order.
    page.routes = [9, 5, 2, 7, 0, 6, 4, 8, 1, 3].map(index => ({
      id: index + 1,
      name: `Route ${String.fromCharCode(65 + index)}`,
      scope: 'local',
      stops: [
        { id: index * 2 + 2, seq: 2, name: 'Later pickup', lat: 34.00001, lng: 74, is_pickup: true, is_active: true, is_temporarily_unavailable: false },
        { id: index * 2 + 1, seq: 1, name: 'Vehicle start', lat: 34 + distances[index] / 6371000 * 180 / Math.PI, lng: 74, is_pickup: true, is_active: true, is_temporarily_unavailable: false },
      ],
    })) as any;
    const target = page as any;
    target.annotateRoutesWithProximity();
    target.sortRoutesByProximity();
    expect(page.visibleRoutes.map(route => route.name)).toEqual(['Route A', 'Route B', 'Route C', 'Route D', 'Route E']);
    expect(page.visibleRoutes.map(route => route.distance_to_start)).toEqual([100, 250, 500, 750, 1000]);
    expect(page.nearbyRoutesCount).toBe(5);
    const nearby = page.visibleRoutes.map(route => ({ route: route.name, starting_distance_m: route.distance_to_start }));
    page.setRadiusFilter(false);
    expect(page.visibleRoutes.map(route => route.distance_to_start)).toEqual(distances);
    expect(page.visibleRoutes.length).toBe(10);
    // Every later pickup is about 1 m away, but it must not affect the list.
    expect(page.routes.every(route => route.distance_to_nearest_pickup === 1)).toBeTrue();
    console.info('ROUTE DISTANCE PROOF: ' + JSON.stringify({ within_1_km: nearby, all_routes: page.visibleRoutes.map(route => ({ route: route.name, starting_distance_m: route.distance_to_start })) }));
  });

  it('does not substitute a later pickup when the start has no coordinates or is closed', () => {
    const first = { id: 1, seq: 1, name: 'Start', lat: 0, lng: 0, is_pickup: true, is_active: false, is_temporarily_unavailable: true, distance_meters: 50 };
    const later = { id: 2, seq: 2, name: 'Later pickup', lat: 34, lng: 74, is_pickup: true, is_active: true, is_temporarily_unavailable: false };
    page.routes = [{ id: 1, scope: 'local', stops: [later, first] }] as any;
    (page as any).annotateRoutesWithProximity();
    expect(page.routes[0].starting_stop?.id).toBe(1);
    expect(page.routes[0].distance_to_start).toBeNull();
    expect(page.visibleRoutes).toEqual([]);
    first.lat = 34.02;
    first.lng = 74;
    (page as any).annotateRoutesWithProximity();
    expect(page.routes[0].starting_stop?.id).toBe(1);
    expect(page.routes[0].distance_to_start).toBeGreaterThan(1000);
    expect(page.visibleRoutes).toEqual([]);
  });

  it('shows the starting stop without inventing a distance when GPS is unavailable', () => {
    page.userCoords = null;
    page.routes = [{ id: 1, scope: 'local', stops: [{ id: 1, seq: 1, name: 'Vehicle start', lat: 34, lng: 74 }] }] as any;
    (page as any).annotateRoutesWithProximity();
    expect(page.routes[0].starting_stop?.name).toBe('Vehicle start');
    expect(page.routes[0].distance_to_start).toBeNull();
    expect(page.visibleRoutes.map(route => route.id)).toEqual([1]);
  });

  it('clears an old nearest-stop distance if no eligible pickup remains', () => {
    const target = page as any;
    page.routes = [{ id: 1, scope: 'local', distance_to_nearest_pickup: 85, nearest_pickup_stop: { id: 1 }, stops: [{ id: 1, lat: 34, lng: 74, is_pickup: true, is_active: false, is_nearest_pickup: true }] }] as any;
    target.annotateRoutesWithProximity();
    expect(page.routes[0].nearest_pickup_stop).toBeNull();
    expect(page.routes[0].distance_to_nearest_pickup).toBeNull();
    expect(page.routes[0].stops[0].is_nearest_pickup).toBeFalse();
  });

  it('retries real GPS and reports failure without inventing a distance', async () => {
    const target = page as any;
    Object.assign(target, { userCoords: null, geo: { getCurrentFix: async () => null } });
    await page.refreshLocation();
    expect(page.userCoords).toBeNull();
    expect(page.locating).toBeFalse();
    expect(page.locationMessage).toContain('Allow location access');
    target.geo.getCurrentFix = async () => ({ lat: 34, lng: 74, accuracy: 15 });
    target.loadRoutes = jasmine.createSpy();
    await page.refreshLocation();
    expect(page.userCoords).toEqual({ lat: 34, lng: 74 });
    expect(page.locationAccuracy).toBe(15);
    expect(page.locationMessage).toBe('');
    expect(target.loadRoutes).toHaveBeenCalledTimes(1);
  });
});
