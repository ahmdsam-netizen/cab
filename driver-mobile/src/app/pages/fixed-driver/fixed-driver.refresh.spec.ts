import { Subject } from 'rxjs';
import { FixedDriverPage } from './fixed-driver.page';

describe('Fixed driver route loading recovery', () => {
  it('filters nearby route starts within 5 km while retaining search and scope filters', () => {
    const page: any = Object.create(FixedDriverPage.prototype);
    page.routes = [
      { id: 1, name: 'Near', scope: 'local', origin_lat: 34, origin_lng: 74 },
      { id: 2, name: 'Far', scope: 'local', origin_lat: 35, origin_lng: 74 },
      { id: 3, name: 'No coordinates', scope: 'local' },
      { id: 4, name: 'First stop', scope: 'outstation', stops: [{ lat: 34, lng: 74 }] },
    ];
    page.driverPosition = { lat: 34, lng: 74 };
    page.routeProximityFilter = 'nearby';
    page.selectedCityFilter = 'all'; page.selectedScopeFilter = 'local';
    expect(page.filteredRoutes.map((r: any) => r.id)).toEqual([1]);
    page.selectedScopeFilter = 'all';
    expect(page.filteredRoutes.map((r: any) => r.id)).toEqual([1, 4]);
    page.routeSearchQuery = 'first';
    expect(page.filteredRoutes.map((r: any) => r.id)).toEqual([4]);
    page.resetRouteFilters();
    expect(page.filteredRoutes.length).toBe(4);
  });

  it('settles failed nearby location and supports retry without using a stale fix', async () => {
    const page: any = Object.create(FixedDriverPage.prototype);
    page.driverPosition = { lat: 34, lng: 74 };
    page.geo = { getCurrentPosition: jasmine.createSpy().and.rejectWith(new Error('denied')) };
    await page.setProximityFilter('nearby');
    expect(page.driverPosition).toBeNull();
    expect(page.nearbyLocationLoading).toBeFalse();
    page.geo.getCurrentPosition.and.resolveTo({ lat: 34.1, lng: 74.2 });
    await page.setProximityFilter('nearby');
    expect(page.driverPosition).toEqual({ lat: 34.1, lng: 74.2 });
    expect(page.nearbyLocationLoading).toBeFalse();
  });

  it('reviews only a visible selected route without opening bookings', () => {
    const page: any = Object.create(FixedDriverPage.prototype);
    page.routes = [{ id: 7, name: 'Sopore', scope: 'local', stops: [{ name: 'ATM' }] }];
    page.selectedCityFilter = 'all'; page.selectedScopeFilter = 'all';
    page.routeSearchQuery = ''; page.routeChoiceId = 7;
    page.selectRoute = jasmine.createSpy();
    page.reviewChosenRoute();
    expect(page.selectRoute).toHaveBeenCalledOnceWith(page.routes[0]);
    page.selectRoute.calls.reset();
    page.routeSearchQuery = 'missing';
    expect(page.chosenRoute).toBeNull();
    page.reviewChosenRoute();
    expect(page.selectRoute).not.toHaveBeenCalled();
    page.routeSearchQuery = 'atm';
    expect(page.chosenRoute?.id).toBe(7);
    page.busy = true;
    page.reviewChosenRoute();
    expect(page.selectRoute).not.toHaveBeenCalled();
  });

  function setup() {
    const routes = new Subject<any>();
    const vehicles = new Subject<any>();
    const page: any = Object.create(FixedDriverPage.prototype);
    page.api = { get: jasmine.createSpy('get').and.callFake((url: string) =>
      url.endsWith('/routes') ? routes : vehicles) };
    page.pickActiveVehicle = jasmine.createSpy().and.returnValue(null);
    for (const name of ['stopManifestPolling', 'resetEmbeddedMap']) page[name] = jasmine.createSpy(name);
    page.stopFixedTripLocationStreaming = jasmine.createSpy().and.resolveTo();
    return { page, routes, vehicles };
  }

  it('stops loading after offline rejection and the other request finishes', () => {
    const { page, routes, vehicles } = setup();
    page.refresh();
    routes.error({ error: { message: 'Go online with your registered fixed service before choosing a fixed route.' } });
    expect(page.loading).toBeTrue();
    vehicles.next({ data: [] }); vehicles.complete();
    expect(page.loading).toBeFalse();
    expect(page.error).toContain('Go online');
  });

  it('stops loading when both requests fail, in either order', () => {
    for (const reverse of [false, true]) {
      const { page, routes, vehicles } = setup();
      page.refresh();
      const [first, second] = reverse ? [vehicles, routes] : [routes, vehicles];
      first.error({});
      expect(page.loading).toBeTrue();
      second.error({});
      expect(page.loading).toBeFalse();
      expect(page.error).toBeTruthy();
    }
  });

  it('settles a vehicle failure after routes succeed and can retry successfully', () => {
    const { page, routes, vehicles } = setup();
    page.refresh();
    routes.next({ data: [], driver_scope: 'local' }); routes.complete();
    expect(page.loading).toBeTrue();
    vehicles.error({});
    expect(page.loading).toBeFalse();
    expect(page.error).toBe('Could not load fixed vehicles.');
    const retryRoutes = new Subject<any>(); const retryVehicles = new Subject<any>();
    page.api.get.and.callFake((url: string) => url.endsWith('/routes') ? retryRoutes : retryVehicles);
    page.refresh();
    expect(page.error).toBeNull();
    expect(page.loading).toBeTrue();
    retryVehicles.next({ data: [] }); retryVehicles.complete();
    expect(page.loading).toBeTrue();
    retryRoutes.next({ data: [{ id: 7, city_id: 3, city_name: 'Sopore' }] }); retryRoutes.complete();
    expect(page.loading).toBeFalse();
    expect(page.routes[0].id).toBe(7);
    expect(page.error).toBeNull();
  });
});
