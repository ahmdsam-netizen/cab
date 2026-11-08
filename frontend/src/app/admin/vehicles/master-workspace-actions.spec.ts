import { VehicleWorkspaceComponent } from './vehicle-workspace.component';
import { Subject } from 'rxjs';
import { FixedRoutesComponent } from '../fixed/fixed-routes.component';

describe('Master live editor delegation', () => {
  let page: any;
  beforeEach(() => {
    page = Object.create(VehicleWorkspaceComponent.prototype);
    Object.assign(page, {
      vehicles: [{ id: 10 }, { id: 20 }], routes: [{ id: 1, city_vehicle_type_id: 20 }],
      groups: [{ id: 1, city_vehicle_type_id: 10, route_ids: [1], driver_user_ids: [] }], cityDrivers: [],
      toast: { warning: jasmine.createSpy() }, newRouteFor: jasmine.createSpy(), editRouteFor: jasmine.createSpy(),
      openDriverDrawer: jasmine.createSpy(), openMasterGroupEditor: jasmine.createSpy(),
    });
  });
  it('opens the existing route editor with its real owning vehicle', () => {
    page.handleMasterAction({ kind: 'edit-route', id: 1, vehicleId: 10 });
    expect(page.editRouteFor).toHaveBeenCalledOnceWith(page.vehicles[1], 1);
  });
  it('opens the focused group editor with group ownership rather than a colliding route ID', () => {
    page.handleMasterAction({ kind: 'edit-group', id: 1, vehicleId: 20 });
    expect(page.openMasterGroupEditor).toHaveBeenCalledOnceWith(page.vehicles[0], page.groups[0]);
  });
  it('uses the existing driver allocation draft without writing on open', () => {
    page.handleMasterAction({ kind: 'group-drivers', id: 1 });
    expect(page.openDriverDrawer).toHaveBeenCalledOnceWith(page.groups[0]);
  });
  it('requires an explicit vehicle for route creation when no target is selected', () => {
    page.handleMasterAction({ kind: 'add-route', vehicleId: null });
    expect(page.newRouteFor).not.toHaveBeenCalled(); expect(page.toast.warning).toHaveBeenCalled();
  });
  it('ignores route, group and driver responses from a previously selected city', () => {
    const requests: Subject<any>[] = [];
    page.cityId = 1; page.supportLoading = new Set(); page.supportErrors = new Set();
    page.api = { get: () => { const response = new Subject<any>(); requests.push(response); return response; } };
    page.recompute = jasmine.createSpy();
    page.loadRoutes(); page.loadGroups(); page.loadDrivers();
    page.cityId = 2;
    const before = JSON.stringify([page.routes, page.groups, page.cityDrivers]);
    requests.forEach(response => response.next({ data: [{ id: 999 }] }));
    expect(JSON.stringify([page.routes, page.groups, page.cityDrivers])).toBe(before);
    expect(page.recompute).not.toHaveBeenCalled();
  });
});

describe('Master map editor loading', () => {
  it('opens the requested route when its initial catalog response arrives', () => {
    const page: any = Object.create(FixedRoutesComponent.prototype);
    const response = new Subject<any>();
    Object.assign(page, { cityId: 1, routes: [], pendingEditRouteId: null, api: { get: () => response }, routesChanged: { emit: jasmine.createSpy() }, openEdit: jasmine.createSpy() });
    page.fetchRoutes();
    page.openEditById(7);
    expect(page.openEdit).not.toHaveBeenCalled();
    const route = { id: 7 };
    response.next({ data: [route] });
    expect(page.openEdit).toHaveBeenCalledOnceWith(route);
    expect(page.pendingEditRouteId).toBeNull();
  });
});
