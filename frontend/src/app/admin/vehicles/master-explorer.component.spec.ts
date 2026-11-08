import { SimpleChange } from '@angular/core';
import { MasterExplorerComponent, MasterRoute } from './master-explorer.component';

describe('Master route explorer', () => {
  let page: MasterExplorerComponent;
  const route = (id: number, scope: string, vehicleId: number, active = true): MasterRoute => ({ id, name: `Route ${id}`, scope, city_vehicle_type_id: vehicleId, is_active: active, origin_name: 'Origin', dest_name: 'Destination', flat_fare: 20, booking_window_hours: 24 });
  beforeEach(() => {
    spyOn(localStorage, 'getItem').and.returnValue(null);
    spyOn(localStorage, 'setItem');
    page = new MasterExplorerComponent();
    page.cityId = 1; page.cityName = 'Srinagar';
    page.routes = [route(1, 'local', 10), route(2, 'outstation', 20), route(3, 'local', 20, false)];
    page.groups = [
      { id: 100, name: 'Airport', city_vehicle_type_id: 10, is_active: true, route_ids: [1, 2], driver_user_ids: [50] },
      { id: 101, name: 'Shared', city_vehicle_type_id: 20, is_active: true, route_ids: [1], driver_user_ids: [50] },
    ];
    page.drivers = [{ id: 5, user_id: 50, name: 'Driver', phone: null, city_vehicle_type_id: 10, vehicle_type_id: null, vehicle_reg_no: null, vehicle_model: null, vehicle_color: null }];
  });
  it('counts a shared route once while retaining membership in both sets', () => {
    page.grouping = 'all-routes';
    expect(page.tree.ids).toEqual([1, 3, 2]);
    page.grouping = 'route-set'; page.toggle('group:100');
    expect(page.rows.filter(row => row.node.key === 'route:1').length).toBe(1);
    expect(new Set(page.rows.map((row, index) => page.track(index, row))).size).toBe(page.rows.length);
    expect(page.routeDrivers(1).map(driver => driver.user_id)).toEqual([50]);
  });
  it('preserves routes allocated through a vehicle-bound group independently of route vehicle', () => {
    page.vehicleId = 10;
    expect(page.scopedRoutes.map(row => row.id)).toEqual([1, 2]);
  });
  it('shows shared groups and routes for another vehicle in the same set without copying records', () => {
    page.vehicles = [{ id: 30, display_name: 'Tavera', vehicle_type_id: 3, max_people: 7, luggage_capacity: 2, is_active: true, vehicle_set_ids: [7], mode_row_ids: [30, 31] }];
    page.groups[0].vehicle_set_ids = [7];
    page.vehicleId = 30;
    expect(page.vehicleGroups.map(group => group.id)).toEqual([100, 101]);
    expect(page.vehicleRoutes.map(route => route.id)).toEqual([1, 2]);
    expect(page.routes.length).toBe(3);
    page.vehicles[0].vehicle_set_ids = [];
    expect(page.vehicleGroups).toEqual([]);
    expect(page.vehicleRoutes).toEqual([]);
  });
  it('searches sets across scope branches and preserves status filtering', () => {
    page.search = 'Airport';
    expect(page.tree.ids).toEqual([1, 2]);
    page.scope = 'local';
    expect(page.tree.ids).toEqual([1]);
    page.status = 'inactive';
    expect(page.tree.ids).toEqual([]);
  });
  it('clears stale selection and filters when switching cities', () => {
    page.vehicleId = 10; page.search = 'Old'; page.selectedKey = 'route:1'; page.status = 'inactive'; page.expanded.add('local');
    page.ngOnChanges({ cityId: new SimpleChange(1, 2, false) });
    expect(page.vehicleId).toBeNull(); expect(page.selectedKey).toBe(''); expect(page.search).toBe(''); expect(page.status).toBe('all'); expect(page.expanded.size).toBe(0); expect(page.grouping).toBe('route-set');
  });
  it('defaults to route sets without the All Routes, scope or area wrappers', () => {
    expect(page.grouping).toBe('route-set');
    expect(page.rows.filter(row => row.depth === 0).map(row => row.node.name)).toEqual(['Airport', 'Shared', 'Routes without a stand']);
    expect(page.rows.every(row => row.depth === 0)).toBeTrue();
    expect(page.selected).toBeUndefined();
  });
  it('switches grouping dimensions without changing route records or filters', () => {
    const before = JSON.stringify([page.routes, page.groups]);
    page.status = 'active';
    page.grouping = 'scope'; page.changeGrouping();
    expect(page.tree.children.map(node => node.name)).toEqual(['Local', 'Outstation']);
    page.grouping = 'city-area'; page.changeGrouping();
    expect(page.tree.children.map(node => node.name)).toEqual(['Srinagar area']);
    page.grouping = 'type'; page.changeGrouping();
    expect(page.tree.children.map(node => node.name)).toEqual(['Fixed']);
    expect(page.tree.ids).toEqual([1, 2]);
    expect(page.status).toBe('active');
    expect(JSON.stringify([page.routes, page.groups])).toBe(before);
  });
  it('keeps only one route set open and supports closing it again', () => {
    page.toggle('group:100');
    expect(page.rows.filter(row => row.node.kind === 'route').map(row => row.node.id)).toEqual([1, 2]);
    page.toggle('group:101');
    expect([...page.expanded]).toEqual(['group:101']);
    expect(page.rows.filter(row => row.node.kind === 'route').map(row => row.node.id)).toEqual([1]);
    page.toggle('group:101');
    expect(page.rows.every(row => row.depth === 0)).toBeTrue();
  });
  it('retains ancestors but closes sibling branches and their descendants', () => {
    page.grouping = 'all-routes';
    page.toggle('root'); page.toggle('local'); page.toggle('area:local'); page.toggle('group:local:100');
    expect(page.expanded.has('root')).toBeTrue();
    page.toggle('outstation');
    expect([...page.expanded]).toEqual(['root', 'outstation']);
    page.collapseAll(); expect(page.expanded.size).toBe(0);
    expect(page.rows.length).toBe(1);
  });
  it('restores saved grouping but always starts collapsed, including old saved expansion data', () => {
    page.grouping = 'scope'; page.changeGrouping();
    const saved = (localStorage.setItem as jasmine.Spy).calls.mostRecent().args;
    expect(saved[0]).toBe('master-route-view:v1:1');
    (localStorage.getItem as jasmine.Spy).and.returnValue(JSON.stringify({ grouping: 'scope', collapsed: [] }));
    const returning = new MasterExplorerComponent(); returning.cityId = 1;
    returning.ngOnChanges({ cityId: new SimpleChange(null, 1, true) });
    expect(returning.grouping).toBe('scope'); expect(returning.expanded.size).toBe(0);
  });  it('uses city-specific preferences and ignores corrupt saved data', () => {
    page.cityId = 2;
    (localStorage.getItem as jasmine.Spy).and.returnValue('{broken');
    page.ngOnChanges({ cityId: new SimpleChange(1, 2, false) });
    expect(localStorage.getItem).toHaveBeenCalledWith('master-route-view:v1:2');
    expect(page.grouping).toBe('route-set'); expect(page.expanded.size).toBe(0);
  });
  it('emits an edit intent without changing route or group records', () => {
    const before = JSON.stringify([page.routes, page.groups]);
    const listener = jasmine.createSpy(); page.action.subscribe(listener);
    page.emit('edit-route', 1, 10);
    expect(listener).toHaveBeenCalledOnceWith({ kind: 'edit-route', id: 1, vehicleId: 10 });
    expect(JSON.stringify([page.routes, page.groups])).toBe(before);
  });
  it('retains the selected vehicle when moving between Master sections', () => {
    page.vehicleId = 10; page.changeVehicle();
    const saved = (localStorage.setItem as jasmine.Spy).calls.mostRecent().args[1];
    (localStorage.getItem as jasmine.Spy).and.returnValue(saved);
    page.section = 'drivers'; page.ngOnChanges({ section: new SimpleChange('routes', 'drivers', false) });
    expect(page.vehicleId).toBe(10);
    expect(page.vehicleRoutes.map(route => route.id)).toEqual([1, 2]);
  });
  it('does not include unrelated drivers when a selected vehicle has no global type', () => {
    page.vehicles = [{ id: 10, display_name: 'Vehicle', vehicle_type_id: null, max_people: 4, luggage_capacity: 0, is_active: true }];
    page.vehicleId = 10;
    page.drivers.push({ id: 6, user_id: 60, name: 'Unrelated', phone: null, city_vehicle_type_id: 20, vehicle_type_id: null, vehicle_reg_no: null, vehicle_model: null, vehicle_color: null });
    expect(page.vehicleDrivers.map(driver => driver.id)).toEqual([5]);
  });
  it('expands a group when its name is selected and closes its sibling', () => {
    page.toggle('group:100');
    const row = page.rows.find(row => row.node.key === 'group:101')!;
    page.choose(row.node, row.trackKey);
    expect([...page.expanded]).toEqual(['group:101']);
    expect(page.selectedGroup?.id).toBe(101);
  });
  it('reveals a route selected from the right through all its ancestors', () => {
    page.grouping = 'all-routes';
    page.toggle('root'); page.toggle('local'); page.toggle('area:local'); page.toggle('group:local:100');
    page.chooseRoute(page.routes[1]);
    expect([...page.expanded]).toEqual(['root', 'outstation', 'area:outstation', 'group:outstation:100']);
    expect(page.rows.some(row => row.node.id === 2 && row.node.kind === 'route')).toBeTrue();
    expect(page.selectedRoute?.id).toBe(2);
  });
  it('reveals shared routes inside the group currently shown in the right panel', () => {
    page.selectedKey = 'group:101';
    page.chooseRoute(page.routes[0]);
    expect([...page.expanded]).toEqual(['group:101']);
    expect(page.rows.find(row => row.node.kind === 'route')?.trackKey).toBe('/group:101/route:1');
  });  it('submits a trimmed inline group for the selected vehicle and blocks duplicate submission', () => {
    const listener = jasmine.createSpy(); page.groupCreate.subscribe(listener);
    page.newGroupName = '  New group  ';
    page.submitGroup(); expect(listener).not.toHaveBeenCalled();
    page.vehicleId = 10; page.submitGroup();
    expect(listener).toHaveBeenCalledOnceWith({ name: 'New group', vehicleId: 10 });
    page.groupCreating = true; page.submitGroup(); expect(listener.calls.count()).toBe(1);
  });
  it('keeps the name while saving or retrying and clears it only after success', () => {
    page.groupCreatorOpen = true; page.newGroupName = 'New group';
    page.ngOnChanges({ groupCreating: new SimpleChange(true, false, false) });
    expect(page.newGroupName).toBe('New group'); expect(page.groupCreatorOpen).toBeTrue();
    page.ngOnChanges({ groupCreatedVersion: new SimpleChange(0, 1, false) });
    expect(page.newGroupName).toBe(''); expect(page.groupCreatorOpen).toBeFalse();
  });});
