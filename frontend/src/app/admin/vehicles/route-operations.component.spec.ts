import { SimpleChange } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { RouteOperationsComponent } from './route-operations.component';
import { RouteGroupSetupComponent } from './route-group-setup.component';

describe('Routes operations workspace', () => {
  let page: RouteOperationsComponent;
  beforeEach(() => {
    page = new RouteOperationsComponent(); page.cityId = 1; page.cityName = 'Sopore';
    page.vehicles = [{ id: 1, display_name: 'Sumo', vehicle_type_id: 1, max_people: 9, luggage_capacity: 1, is_active: true, vehicle_set_ids: [10] }, { id: 2, display_name: 'Bus', vehicle_type_id: 2, max_people: 30, luggage_capacity: 2, is_active: false, vehicle_set_ids: [10] }];
    page.groups = [{ id: 5, name: 'Town service', is_active: true, city_vehicle_type_id: 1, vehicle_set_ids: [10], route_ids: [20], driver_user_ids: [50] }];
    page.routes = [{ id: 20, name: 'Market route', origin_name: 'Town', dest_name: 'Market', city_vehicle_type_id: 1, scope: 'local', flat_fare: 20, booking_window_hours: 2, is_active: true }, { id: 21, name: 'Incomplete', origin_name: 'Town', dest_name: 'Station', city_vehicle_type_id: 1, scope: 'outstation', flat_fare: null, booking_window_hours: 2, is_active: false }];
    page.drivers = [{ id: 3, user_id: 50, name: 'Driver One', phone: null, vehicle_type_id: 2, city_vehicle_type_id: 2, vehicle_reg_no: null, vehicle_model: null, vehicle_color: null }];
  });
  it('opens the dedicated rename dialog and updates the displayed name without changing assignments', async () => {
    const response = new Subject<any>();
    const api = { patch: jasmine.createSpy().and.returnValue(response) };
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent], providers: [
      { provide: ApiService, useValue: api }, { provide: ToastService, useValue: { success: () => undefined } },
    ] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page);
    const component = fixture.componentInstance, root: HTMLElement = fixture.nativeElement;
    component.openGroupManagement(); fixture.detectChanges();
    const before = JSON.stringify([component.groups[0].route_ids, component.groups[0].driver_user_ids, component.groups[0].vehicle_set_ids]);
    root.querySelector<HTMLButtonElement>('[aria-label="Rename stand Town service"]')!.click(); fixture.detectChanges();
    await fixture.whenStable(); fixture.detectChanges();
    expect(component.groupSetupOpen).toBeFalse();
    const input = root.querySelector<HTMLInputElement>('#rename-stand-name')!;
    input.value = 'Town stand'; input.dispatchEvent(new Event('input')); await fixture.whenStable(); fixture.detectChanges();
    const refreshed = jasmine.createSpy(); component.refresh.subscribe(refreshed);
    Array.from(root.querySelectorAll<HTMLButtonElement>('app-stand-rename button')).find(button => button.textContent?.trim() === 'Save')!.click();
    response.next({ route_group: { name: 'Town stand' } }); fixture.detectChanges();
    expect(root.querySelector('.group-management-identity')?.textContent).toContain('Town stand');
    expect(root.querySelector('app-stand-rename')).toBeNull(); expect(refreshed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([component.groups[0].route_ids, component.groups[0].driver_user_ids, component.groups[0].vehicle_set_ids])).toBe(before);
    fixture.destroy();
  });
  it('opens both copy actions from Browse routes and shows the created route independently', async () => {
    const response = new Subject<any>(), api = { post: jasmine.createSpy().and.returnValue(response) };
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent], providers: [
      { provide: ApiService, useValue: api }, { provide: ToastService, useValue: { success: () => undefined } },
    ] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page);
    const component = fixture.componentInstance, root: HTMLElement = fixture.nativeElement;
    component.routeDetailTab = 'browse'; fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('[aria-label="Copy route Market route"]')!.click(); fixture.detectChanges();
    await fixture.whenStable(); fixture.detectChanges();
    expect(component.copyReverse).toBeFalse();
    root.querySelector<HTMLButtonElement>('app-route-copy tm-button button')!.click(); fixture.detectChanges();
    expect(root.querySelector('app-route-copy')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('[aria-label="Copy as reverse Market route"]')!.click(); fixture.detectChanges();
    await fixture.whenStable(); fixture.detectChanges(); expect(component.copyReverse).toBeTrue();
    const refresh = jasmine.createSpy(); component.refresh.subscribe(refresh);
    expect(root.querySelector('.copy-review')).not.toBeNull();
    Array.from(root.querySelectorAll<HTMLButtonElement>('app-route-copy button')).find(button => button.textContent?.includes('Save') || button.textContent?.includes('copy'))!.click();
    response.next({ route: { id: 22, name: 'Market → Town', is_active: true } }); fixture.detectChanges();
    expect(component.search).toBe('Market → Town'); expect(component.routeGroupId).toBeNull();
    expect(component.routeDetailTab).toBe('copied'); expect(component.copyRoute).toBeNull(); expect(refresh).toHaveBeenCalledTimes(1);
    expect(component.copiedRouteIds.has(22)).toBeTrue();
    expect(component.routes[0].name).toBe('Market route'); fixture.destroy();
  });
  it('finds routes through shared groups for another vehicle without copying them', () => {
    page.vehicleId = 2;
    expect(page.filteredRoutes.map(route => route.id)).toEqual([20]);
    expect(page.routes.length).toBe(2);
    page.search = 'town service'; expect(page.filteredRoutes.map(route => route.id)).toEqual([20]);
  });
  it('separates inactive routes from incomplete setup and resets filters', () => {
    page.status = 'inactive'; expect(page.filteredRoutes.map(route => route.id)).toEqual([21]);
    page.status = 'attention'; expect(page.filteredRoutes.map(route => route.id)).toEqual([21]);
    page.scope = 'local'; expect(page.filteredRoutes).toEqual([]);
    page.clearFilters(); expect(page.filteredRoutes.length).toBe(2);
  });
  it('filters the network by real group membership and expands matching routes', () => {
    page.grouping = 'route-set';
    page.selectNetwork('all', 5);
    expect(page.networkLabel).toBe('Town service');
    expect(page.filteredRoutes.map(route => route.id)).toEqual([20]);
    expect(page.directoryRows.filter(row => row.route).map(row => row.route!.id)).toEqual([20]);
    expect(page.filtersActive).toBeTrue();
    page.selectNetwork('outstation');
    expect(page.routeGroupId).toBeNull();
    expect(page.filteredRoutes.map(route => route.id)).toEqual([21]);
    page.clearFilters(); expect(page.filteredRoutes.length).toBe(2);
  });
  it('switches the hierarchy group selector and clears conflicting route filters', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page);
    fixture.componentInstance.groups.push({ ...page.groups[0], id: 6, name: 'Empty group', route_ids: [] });
    fixture.detectChanges(); const select: HTMLSelectElement = fixture.nativeElement.querySelector('[aria-label="Select stand"]');
    fixture.componentInstance.search = 'no match'; fixture.componentInstance.status = 'inactive'; fixture.componentInstance.scope = 'outstation';
    select.selectedIndex = 1; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(fixture.componentInstance.routeGroupId).toBe(5); expect(fixture.componentInstance.selectedGroupId).toBe(5);
    expect(fixture.componentInstance.filteredRoutes.map(route => route.id)).toEqual([20]);
    expect(fixture.componentInstance.detailRoute?.id).toBe(20); expect(fixture.componentInstance.routeDetailTab).toBe('overview');
    select.selectedIndex = 2; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(fixture.componentInstance.filteredRoutes.length).toBe(0); expect(fixture.componentInstance.detailRoute).toBeUndefined();
    select.selectedIndex = 0; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(fixture.componentInstance.routeGroupId).toBeNull(); expect(fixture.componentInstance.filteredRoutes.length).toBe(2);
    fixture.destroy();
  });
  it('searches and switches groups beside the route picker while keeping both group controls synced', async () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const input = root.querySelector<HTMLInputElement>('[aria-label="Select stand to inspect"]')!;
    input.dispatchEvent(new Event('focus')); input.value = 'Town'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(root.querySelectorAll('#group-picker-options [role="option"]').length).toBe(1);
    expect(fixture.componentInstance.routeGroupId).toBeNull();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); fixture.detectChanges();
    expect(fixture.componentInstance.routeGroupId).toBe(5); expect(input.value).toBe('Town service');
    expect(fixture.componentInstance.filteredRoutes.map(route => route.id)).toEqual([20]);
    await fixture.whenStable(); fixture.detectChanges();
    expect((root.querySelector('[aria-label="Select stand"]') as HTMLSelectElement).selectedIndex).toBe(1);
    input.dispatchEvent(new Event('focus')); input.value = 'missing'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(root.querySelector('#group-picker-options')?.textContent).toContain('No matching stands');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges(); expect(input.value).toBe('Town service');
    input.dispatchEvent(new Event('focus')); fixture.detectChanges();
    (root.querySelector('#group-option-all') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(fixture.componentInstance.routeGroupId).toBeNull(); expect(input.value).toBe('All stands');
    input.dispatchEvent(new Event('focus')); fixture.componentInstance.openRoutePicker(); fixture.detectChanges();
    expect(root.querySelector('#group-picker-options')).toBeNull();
    fixture.destroy();
  });
  it('opens existing driver assignments from Overview and retains the add-to-group shortcut', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent], providers: [{ provide: ApiService, useValue: {} }, { provide: ToastService, useValue: {} }] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    Array.from(root.querySelectorAll<HTMLButtonElement>('.route-driver-actions button')).find(button => button.textContent?.includes('Add drivers'))!.click(); fixture.detectChanges();
    expect(fixture.componentInstance.editingGroup?.id).toBe(5);
    expect(root.querySelector('app-route-group-setup')?.textContent).toContain('Selected drivers receive every route in this stand.');
    expect((root.querySelector('app-route-group-setup .choices input') as HTMLInputElement).checked).toBeTrue();
    fixture.componentInstance.groupSetupOpen = false; fixture.detectChanges();
    Array.from(root.querySelectorAll<HTMLButtonElement>('.route-driver-actions button')).find(button => button.textContent?.includes('Add to stand'))!.click(); fixture.detectChanges();
    expect(fixture.componentInstance.routeForGroup?.id).toBe(20);
    fixture.destroy();
  });
  it('chooses a linked group for drivers and preselects an ungrouped priced route without changing memberships', () => {
    page.groups.push({ ...page.groups[0], id: 6, driver_user_ids: [] });
    page.addRouteDrivers(page.routes[0]); expect(page.groupSetupOpen).toBeFalse(); expect(page.driverTargetGroups.length).toBe(2);
    page.chooseDriverGroup(page.groups[1]); expect(page.editingGroup?.id).toBe(6); expect(page.initialRouteId).toBeNull(); expect(page.groupSetupSection).toBe('drivers');
    page.groupSetupOpen = false; page.routes[1].flat_fare = 50;
    page.addRouteDrivers(page.routes[1]); page.chooseDriverGroup(page.groups[0]);
    expect(page.initialRouteId).toBe(21); expect(page.groupSetupSection).toBe('drivers'); expect(page.groups[0].route_ids).toEqual([20]);
    page.groupSetupOpen = false; page.addRouteDrivers(page.routes[1]); page.chooseDriverGroup(null);
    expect(page.editingGroup).toBeNull(); expect(page.initialRouteId).toBe(21);
    page.ngOnChanges({ cityId: new SimpleChange(1, 2, false) }); expect(page.routeForDrivers).toBeNull();
    page.startGroup(page.groups[0]); expect(page.groupSetupSection).toBe('routes');
  });
  it('clears a group filter on city changes or removal and resets pagination', () => {
    page.routes = Array.from({ length: 23 }, (_, index) => ({ ...page.routes[0], id: index + 100 }));
    page.groups[0].route_ids = [100];
    page.goToPage(3); expect(page.currentPage).toBe(3);
    page.selectNetwork('all', 5); expect(page.currentPage).toBe(1);
    page.ngOnChanges({ cityId: new SimpleChange(1, 2, false) });
    expect(page.routeGroupId).toBeNull();
    page.selectNetwork('all', 5); page.groups = [];
    page.ngOnChanges({ groups: new SimpleChange([], [], false) });
    expect(page.routeGroupId).toBeNull();
  });
  it('keeps driver assignment in the workspace and resets dialogs when switching cities', () => {
    page.driverAssignment = page.drivers[0]; page.groupSetupOpen = true; page.routeStarterOpen = true;
    page.ngOnChanges({ cityId: new SimpleChange(1, 2, false) });
    expect(page.driverAssignment).toBeNull(); expect(page.groupSetupOpen).toBeFalse(); expect(page.routeStarterOpen).toBeFalse();
  });
  it('selects an existing group with the route preselected', () => {
    page.assignRoute(page.routes[0]); page.chooseGroupForRoute(page.groups[0]);
    expect(page.editingGroup?.id).toBe(5); expect(page.initialRouteId).toBe(20); expect(page.groupSetupOpen).toBeTrue();
  });
  it('opens pricing before an unpriced route can be added to a group', () => {
    const action = jasmine.createSpy(); page.action.subscribe(action);
    page.assignRoute(page.routes[1]);
    expect(page.routeForGroup).toBeNull();
    expect(action).toHaveBeenCalledWith({ kind: 'edit-route', id: 21, vehicleId: null });
  });
  it('renders clear management views and visible actions without leaving Routes', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent], providers: [{ provide: ApiService, useValue: { get: () => of({ groups: [], assigned_group_ids: [], effective_routes: [] }) } }, { provide: ToastService, useValue: {} }] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('h1').textContent).toBe('Routes');
    const tabs: HTMLButtonElement[] = [...fixture.nativeElement.querySelectorAll('.overview button')];
    tabs[1].click(); fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('Manage types'); expect(fixture.nativeElement.textContent).toContain('Seat layouts');
    tabs[2].click(); fixture.detectChanges();
    const assign = fixture.nativeElement.querySelector('.assign') as HTMLButtonElement; assign.click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.assignment').textContent).toContain('Fixed route access');
    fixture.destroy();
  });
  it('connects the reference cards and details to the original editors and actions', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent], providers: [{ provide: ApiService, useValue: { get: () => of({ groups: [], assigned_group_ids: [], effective_routes: [] }) } }, { provide: ToastService, useValue: {} }] });
    const fixture = TestBed.createComponent(RouteOperationsComponent);
    Object.assign(fixture.componentInstance, page); fixture.componentInstance.countryCode = 'IN';
    const events = jasmine.createSpy(); fixture.componentInstance.action.subscribe(events); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.geography-panel').textContent).toContain('India');
    expect(fixture.nativeElement.querySelector('.network-banner')).toBeNull();
    fixture.componentInstance.openGroupManagement(); fixture.detectChanges();
    fixture.componentInstance.selectGroup(page.groups[0]); fixture.detectChanges();
    expect(fixture.componentInstance.view).toBe('routes');
    expect(fixture.componentInstance.overviewGroup?.id).toBe(5);
    fixture.nativeElement.querySelector('.group-view-routes').click(); fixture.detectChanges();
    expect(fixture.componentInstance.filteredRoutes.map(route => route.id)).toEqual([20]);
    fixture.nativeElement.querySelector('[aria-label="Edit route Market route"]').click();
    expect(events).toHaveBeenCalledWith({ kind: 'edit-route', id: 20, vehicleId: null });
    fixture.componentInstance.routeDetailTab = 'tools'; fixture.detectChanges();
    fixture.nativeElement.querySelector('.toggle-route').click();
    expect(events).toHaveBeenCalledWith({ kind: 'toggle-route', id: 20, vehicleId: null });
    fixture.componentInstance.openGroupManagement(); fixture.detectChanges();
    fixture.nativeElement.querySelector('.group-card-edit').click(); fixture.detectChanges();
    expect(fixture.componentInstance.editingGroup?.id).toBe(5);
    expect(fixture.componentInstance.groupSetupOpen).toBeTrue();
    fixture.componentInstance.groupSetupOpen = false; fixture.componentInstance.changeView('drivers'); fixture.detectChanges();
    const assign: HTMLButtonElement = fixture.nativeElement.querySelector('.driver-reference-controls tm-button button');
    assign.click(); fixture.detectChanges();
    expect(fixture.componentInstance.driverAssignment?.id).toBe(3);
    fixture.destroy();
  });
  it('shows each module only through its summary card and keeps unrelated panels out', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.workspace-nav')).toBeNull();
    const tabs: HTMLButtonElement[] = [...fixture.nativeElement.querySelectorAll('.overview [role="tab"]')];
    for (const [index, view] of (['routes', 'vehicles', 'drivers'] as const).entries()) {
      tabs[index].click(); fixture.detectChanges();
      expect(fixture.componentInstance.view).toBe(view);
      expect(fixture.nativeElement.querySelector('[role="tabpanel"]').id).toBe('module-' + view);
      expect(tabs[index].getAttribute('aria-selected')).toBe('true');
      expect(fixture.nativeElement.querySelector('.map-panel') !== null).toBe(view === 'routes');
      expect(fixture.nativeElement.querySelector('.reference-gallery') !== null).toBeFalse();
      expect(fixture.nativeElement.querySelector('.group-overview') !== null).toBeFalse();
      expect(fixture.nativeElement.querySelector('.route-reference') !== null).toBe(view === 'routes');
      expect(fixture.nativeElement.querySelector('.driver-reference') !== null).toBe(view === 'drivers');
    }
    fixture.componentInstance.openGroupManagement(); fixture.detectChanges();
    const remove: HTMLButtonElement = fixture.nativeElement.querySelector('[aria-label="Delete stand Town service"]');
    const events = jasmine.createSpy(); fixture.componentInstance.action.subscribe(events); remove.click();
    expect(events).toHaveBeenCalledWith({ kind: 'delete-group', id: 5, vehicleId: null });
    fixture.destroy();
  });
  it('supports keyboard module navigation and clears hidden filters on module changes', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.detectChanges();
    const tabs: HTMLButtonElement[] = [...fixture.nativeElement.querySelectorAll('.overview [role="tab"]')];
    fixture.componentInstance.scope = 'outstation'; fixture.componentInstance.vehicleId = 2; fixture.componentInstance.status = 'attention';
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); fixture.detectChanges();
    expect(fixture.componentInstance.view).toBe('vehicles'); expect(document.activeElement).toBe(tabs[1]);
    expect(fixture.componentInstance.scope).toBe('all'); expect(fixture.componentInstance.vehicleId).toBeNull(); expect(fixture.componentInstance.status).toBe('all');
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); fixture.detectChanges();
    expect(fixture.componentInstance.view).toBe('drivers');
    fixture.componentInstance.showDriverRoute(20); fixture.detectChanges();
    expect(fixture.componentInstance.view).toBe('routes'); expect(fixture.componentInstance.detailRoute?.id).toBe(20);
    fixture.destroy();
  });
  it('keeps all group actions in their own route tab and group filters independent of route filters', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page);
    const root: HTMLElement = fixture.nativeElement;
    fixture.componentInstance.search = 'missing route'; fixture.componentInstance.openGroupManagement(); fixture.detectChanges();
    expect(root.querySelectorAll('.overview [role="tab"]').length).toBe(3);
    expect(root.querySelector('#module-tab-groups')).toBeNull();
    expect(root.querySelector('#route-panel-groups .group-management-row')?.textContent).toContain('Town service');
    (root.querySelector('#route-tab-tools') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(root.querySelector('.group-management')).toBeNull();
    (root.querySelector('#route-tab-groups') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(fixture.componentInstance.filteredRoutes.length).toBe(0);
    fixture.componentInstance.groupSearch = 'missing group'; fixture.detectChanges();
    expect(root.querySelector('.group-management-row')).toBeNull();
    fixture.componentInstance.resetGroupFilters(); fixture.detectChanges();
    (root.querySelector('[aria-label="Manage stand Town service"]') as HTMLButtonElement).click();
    expect(fixture.componentInstance.editingGroup?.id).toBe(5);
    expect(fixture.componentInstance.groupSetupOpen).toBeTrue();
    fixture.componentInstance.groupSetupOpen = false;
    const create = Array.from(root.querySelectorAll<HTMLButtonElement>('.group-management button')).find(button => button.textContent?.includes('New stand'))!;
    create.click(); expect(fixture.componentInstance.editingGroup).toBeNull(); expect(fixture.componentInstance.groupSetupOpen).toBeTrue();
    fixture.destroy();
  });
  it('searches the route selector without filtering the workspace and supports keyboard and pointer selection', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.textContent).not.toContain('Browse & filter');
    const input = root.querySelector<HTMLInputElement>('[aria-label="Select route to inspect"]')!;
    input.dispatchEvent(new Event('focus')); fixture.detectChanges();
    expect(root.querySelectorAll('[role="option"]').length).toBe(2);
    input.value = 'Station'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(root.querySelectorAll('[role="option"]').length).toBe(1);
    expect(fixture.componentInstance.filteredRoutes.length).toBe(2);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); fixture.detectChanges();
    expect(fixture.componentInstance.detailRoute?.id).toBe(21);
    expect(input.value).toBe('Incomplete'); expect(input.getAttribute('aria-expanded')).toBe('false');
    input.dispatchEvent(new Event('focus')); input.value = 'missing'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(root.querySelector('[role="listbox"]')?.textContent).toContain('No matching routes');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); expect(fixture.componentInstance.detailRoute?.id).toBe(21);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(input.value).toBe('Incomplete');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); fixture.detectChanges();
    (root.querySelector('[role="option"]') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(fixture.componentInstance.detailRoute?.id).toBe(20);
    input.dispatchEvent(new Event('focus')); input.dispatchEvent(new Event('blur')); fixture.detectChanges();
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    fixture.componentInstance.routes = []; fixture.detectChanges(); expect(input.disabled).toBeTrue();
    fixture.destroy();
  });
  it('keeps effective driver routes unique and city-scoped without changing assignments', () => {
    page.groups.push({ ...page.groups[0], id: 6 });
    expect(page.routesForDriver(50).map(route => route.id)).toEqual([20]);
    page.detailDriverId = 3; expect(page.detailDriver?.id).toBe(3);
    page.selectNetwork('outstation'); page.showDriverRoute(20);
    expect(page.detailRoute?.id).toBe(20); expect(page.scope).toBe('all');
    expect(page.groups[0].driver_user_ids).toEqual([50]);
    page.ngOnChanges({ cityId: new SimpleChange(1, 2, false) });
    expect(page.detailDriverId).toBeNull();
  });
  it('restores every grouping mode with expansion and collapse while retaining route actions', () => {
    for (const mode of ['route-set', 'city-area', 'scope', 'type', 'all-routes'] as const) {
      page.grouping = mode; page.changeGrouping();
      expect(page.directoryRows.some(row => row.kind !== 'route')).toBeTrue();
      page.expandDirectory();
      expect(new Set(page.directoryRows.filter(row => row.route).map(row => row.route!.id))).toEqual(new Set([20, 21]));
      page.explorer.collapseAll(); expect(page.directoryRows.every(row => !row.route)).toBeTrue();
    }
    page.grouping = 'routes'; expect(page.directoryRows.map(row => row.route?.id)).toEqual([20, 21]);
    localStorage.removeItem('master-route-view:v1:1');
  });
  it('keeps bulk selection and vehicle type filtering independent of route grouping', () => {
    page.vehicleTypeId = 2; expect(page.filteredVehicles.map(vehicle => vehicle.id)).toEqual([2]);
    page.selectVisibleVehicles(); expect([...page.selectedVehicleIds]).toEqual([2]);
    const action = jasmine.createSpy(); page.action.subscribe(action); page.vehicleBatch('copy-vehicles');
    expect(action).toHaveBeenCalledWith({ kind: 'copy-vehicles', ids: [2] });
    page.selectVisibleVehicles(); expect(page.selectedVehicleIds.size).toBe(0);
  });
  it('renders configured vehicle and driver photos and falls back when a photo fails', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent);
    fixture.componentInstance.vehicles = [{ ...page.vehicles[0], image_url: '/vehicle.jpg' }];
    fixture.componentInstance.drivers = [{ ...page.drivers[0], avatar_url: '/driver.jpg' }];
    fixture.componentInstance.view = 'vehicles'; fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.vehicle-photo img').getAttribute('src')).toBe('/vehicle.jpg');
    fixture.nativeElement.querySelector('.vehicle-photo img').dispatchEvent(new Event('error')); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.vehicle-photo tm-icon')).not.toBeNull();
    fixture.componentInstance.changeView('drivers'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.driver-photo img').getAttribute('src')).toBe('/driver.jpg');
    fixture.nativeElement.querySelector('.driver-photo img').dispatchEvent(new Event('error')); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.driver-photo').textContent.trim()).toBe('DO');
    fixture.destroy();
  });
  it('focuses inline editing immediately and supports keyboard cancellation', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent);
    fixture.componentInstance.vehicles = page.vehicles; fixture.componentInstance.view = 'vehicles';
    fixture.componentInstance.editId = 1; fixture.componentInstance.editField = 'seats'; fixture.componentInstance.editValue = '9';
    const event = jasmine.createSpy(); fixture.componentInstance.cellEdit.subscribe(event); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('.cell-input'); expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(event).toHaveBeenCalledWith({ phase: 'cancel', id: 1, field: 'seats', value: undefined }); fixture.destroy();
  });
  it('paginates filtered results and returns to page one when search or page size changes', () => {
    page.routes = Array.from({ length: 23 }, (_, index) => ({ ...page.routes[0], id: index + 100, name: `Route ${index + 1}` }));
    expect(page.pageCount).toBe(3); expect(page.pagedDirectoryRows.length).toBe(10);
    page.goToPage(3); expect(page.firstItem).toBe(21); expect(page.lastItem).toBe(23);
    page.search = 'Route 1'; expect(page.currentPage).toBe(1); expect(page.totalItems).toBe(11);
    page.changePageSize(25); expect(page.pageCount).toBe(1); expect(page.pagedDirectoryRows.length).toBe(11);
    page.changePageSize(0); expect(page.pageSize).toBe(25);
    page.search = ''; page.changePageSize(10); page.goToPage(3); page.routes = page.routes.slice(0, 11);
    expect(page.currentPage).toBe(2); expect(page.lastItem).toBe(11);
  });
  it('repeats group headings when a branch continues onto another page without dropping routes', () => {
    page.routes = Array.from({ length: 15 }, (_, index) => ({ ...page.routes[0], id: index + 100 }));
    page.groups[0].route_ids = page.routes.map(route => route.id); page.grouping = 'route-set'; page.expandDirectory();
    expect(page.totalItems).toBe(16); page.goToPage(2);
    expect(page.pagedDirectoryRows[0].name).toBe('Town service'); expect(page.pagedDirectoryRows[0].kind).toBe('group');
    expect(page.pagedDirectoryRows.filter(row => row.route).length).toBe(6);
    const lastPageRoutes = page.pagedDirectoryRows.filter(row => row.route).map(row => row.route!.id);
    page.goToPage(1);
    expect([...page.pagedDirectoryRows.filter(row => row.route).map(row => row.route!.id), ...lastPageRoutes]).toEqual(page.routes.map(route => route.id));
  });
  it('selects only vehicles on the current page and preserves earlier page selections', () => {
    page.changeView('vehicles'); page.vehicles = Array.from({ length: 15 }, (_, index) => ({ ...page.vehicles[0], id: index + 100 }));
    page.selectVisibleVehicles(); expect(page.selectedVehicleIds.size).toBe(10);
    page.goToPage(2); expect(page.allVisibleVehiclesSelected).toBeFalse();
    page.selectVisibleVehicles(); expect(page.selectedVehicleIds.size).toBe(15);
    page.selectVisibleVehicles(); expect(page.selectedVehicleIds.size).toBe(10);
    page.goToPage(1); expect(page.allVisibleVehiclesSelected).toBeTrue();
  });
  it('renders working page navigation and a page size selector', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent);
    fixture.componentInstance.routes = Array.from({ length: 11 }, (_, index) => ({ ...page.routes[0], id: index + 100 })); fixture.componentInstance.routeDetailTab = 'browse'; fixture.detectChanges();
    const next = fixture.nativeElement.querySelector('[aria-label="Next page"]'); expect(next.disabled).toBeFalse(); next.click(); fixture.detectChanges();
    expect(fixture.componentInstance.currentPage).toBe(2); expect(next.disabled).toBeTrue();
    expect(fixture.nativeElement.querySelectorAll('.route-browser-item').length).toBe(1);
    const size = fixture.nativeElement.querySelector('[aria-label="Rows per page"]'); size.selectedIndex = 1; size.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(fixture.componentInstance.pageSize).toBe(25); expect(fixture.componentInstance.currentPage).toBe(1);
    expect(fixture.nativeElement.querySelectorAll('.route-browser-item').length).toBe(11); fixture.destroy();
  });
  it('replaces the directory table with working route-detail tabs and preserves selection', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page);
    fixture.componentInstance.routes[0].stops = [{ id: 1, name: 'Town', seq: 1 }, { id: 2, name: 'Market', seq: 2 }];
    fixture.detectChanges(); const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('#module-routes table')).toBeNull();
    expect(root.textContent).not.toContain('Route directory');
    expect(root.querySelector('#route-panel-overview')?.textContent).toContain('Market route');
    expect(root.querySelector('#route-tab-stops')).toBeNull();
    expect(root.querySelector('#route-tab-drivers')).toBeNull();
    expect(root.querySelectorAll('.stop-timeline li').length).toBe(2);
    expect(root.querySelector('#route-panel-overview .route-stops-content')).not.toBeNull();
    expect(root.querySelector('#route-panel-overview .route-assigned-drivers')).not.toBeNull();
    expect(root.querySelector('.route-assigned-drivers')?.textContent).toContain('Driver One');
    (root.querySelector('#route-tab-browse') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(root.querySelectorAll('.route-browser-item').length).toBe(2);
    const routes = root.querySelectorAll<HTMLButtonElement>('.route-browser .route-name'); routes[1].click(); fixture.detectChanges();
    expect(fixture.componentInstance.detailRoute?.id).toBe(21);
    expect(fixture.componentInstance.routeDetailTab).toBe('overview');
    (root.querySelector('#route-tab-overview') as HTMLButtonElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); fixture.detectChanges();
    expect(fixture.componentInstance.routeDetailTab).toBe('tools');
    expect(document.activeElement?.id).toBe('route-tab-tools');
    const events = jasmine.createSpy(); fixture.componentInstance.action.subscribe(events);
    (root.querySelector('.toggle-route') as HTMLButtonElement).click();
    expect(events).toHaveBeenCalledWith({ kind: 'toggle-route', id: 21, vehicleId: null });
    fixture.componentInstance.ngOnChanges({ cityId: new SimpleChange(1, 2, false) });
    expect(fixture.componentInstance.routeDetailTab).toBe('overview'); fixture.destroy();
  });
  it('preserves overview stop editing, driver navigation and group assignments when routes change', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const events = jasmine.createSpy(); fixture.componentInstance.action.subscribe(events);
    expect(root.querySelector('.route-stops-content tm-button')).toBeNull();
    (root.querySelector('[aria-label="Edit route Market route"]') as HTMLButtonElement).click();
    expect(events).toHaveBeenCalledWith({ kind: 'edit-route', id: 20, vehicleId: null });
    const groupButton = Array.from(root.querySelectorAll<HTMLButtonElement>('.route-driver-actions button')).find(button => button.textContent?.includes('Add to stand'))!;
    groupButton.click(); fixture.detectChanges();
    expect(fixture.componentInstance.routeForGroup?.id).toBe(20); fixture.componentInstance.routeForGroup = null;
    (root.querySelector('#route-tab-overview') as HTMLButtonElement).click(); fixture.detectChanges();
    (root.querySelector('.route-assigned-drivers .driver-mini') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(fixture.componentInstance.view).toBe('drivers'); expect(fixture.componentInstance.detailDriver?.id).toBe(3);
    fixture.componentInstance.showDriverRoute(21); fixture.detectChanges();
    expect(root.querySelector('.route-stops-content')?.textContent).toContain('No stops configured');
    expect(root.querySelector('.route-assigned-drivers')?.textContent).toContain('No assigned drivers');
    (root.querySelector('#route-tab-browse') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(root.querySelector('.route-overview-operations')).toBeNull();
    fixture.destroy();
  });
  it('keeps browsing, creation and import reachable with empty, filtered or failed route data', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page); fixture.componentInstance.routes = []; fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.route-workspace')).not.toBeNull();
    fixture.componentInstance.routeDetailTab = 'tools'; fixture.detectChanges();
    const buttons: HTMLButtonElement[] = [...fixture.nativeElement.querySelectorAll('.route-tools-content button')];
    buttons.find(button => button.textContent?.includes('New route'))!.click(); fixture.detectChanges();
    expect(fixture.componentInstance.routeStarterOpen).toBeTrue(); fixture.componentInstance.routeStarterOpen = false;
    buttons.find(button => button.textContent?.includes('Import KML'))!.click(); fixture.detectChanges();
    expect(fixture.componentInstance.importStarter).toBeTrue(); fixture.componentInstance.routeStarterOpen = false;
    fixture.componentInstance.routes = page.routes; fixture.componentInstance.search = 'missing route'; fixture.componentInstance.routeDetailTab = 'browse'; fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No matching routes');
    fixture.componentInstance.loadError = 'Network unavailable'; fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Network unavailable');
    expect(fixture.nativeElement.querySelector('.route-detail-panel')).toBeNull(); fixture.destroy();
  });
  it('renders the copied routes tab with dedicated search and empty states', () => {
    TestBed.configureTestingModule({ imports: [RouteOperationsComponent] });
    const fixture = TestBed.createComponent(RouteOperationsComponent); Object.assign(fixture.componentInstance, page);
    fixture.componentInstance.routes = [
      ...page.routes,
      { id: 30, name: 'Market route (copy)', origin_name: 'Town', dest_name: 'Market', city_vehicle_type_id: 1, scope: 'local', flat_fare: 20, booking_window_hours: 2, is_active: false },
    ];
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const copiedTab = root.querySelector<HTMLButtonElement>('#route-tab-copied')!;
    expect(copiedTab).not.toBeNull();
    expect(copiedTab.textContent).toContain('Copied routes');
    expect(fixture.componentInstance.routeTabCount('copied')).toBe(1);
    copiedTab.click(); fixture.detectChanges();
    expect(fixture.componentInstance.routeDetailTab).toBe('copied');
    expect(root.querySelector('#route-panel-copied')).not.toBeNull();
    expect(root.querySelector('.copied-route-item')?.textContent).toContain('Market route (copy)');
    fixture.componentInstance.copiedSearch = 'nomatch'; fixture.detectChanges();
    expect(root.querySelector('.copied-route-item')).toBeNull();
    expect(root.querySelector('#route-panel-copied .section-empty')?.textContent).toContain('No matching copied routes');
    fixture.destroy();
  });
});

describe('Combined route group setup', () => {
  let editor: RouteGroupSetupComponent;
  let api: any;
  beforeEach(() => {
    api = { post: jasmine.createSpy().and.returnValue(of({})), put: jasmine.createSpy().and.returnValue(of({})) };
    editor = new RouteGroupSetupComponent(api, { success: jasmine.createSpy() } as any);
    editor.cityId = 1; editor.ngOnChanges({ cityId: new SimpleChange(null, 1, true) });
    editor.name = 'Town service';
  });
  it('saves name, status, routes, sharing and drivers in a single request', () => {
    editor.routeIds.add(20); editor.driverIds.add(50); editor.vehicleIds.add(1); editor.setIds.add(10); editor.active = false;
    editor.save();
    expect(api.post).toHaveBeenCalledOnceWith('/admin/cities/1/route-groups/setup', { name: 'Town service', is_active: false, city_vehicle_type_id: null, route_ids: [20], driver_user_ids: [50], vehicle_ids: [1], vehicle_set_ids: [10] });
  });
  it('creates several groups with common assignments in one request and rejects duplicate names', () => {
    editor.extraNames = ['Express service']; editor.routeIds.add(20); editor.driverIds.add(50); editor.vehicleIds.add(1);
    editor.save(); expect(api.post).toHaveBeenCalledOnceWith('/admin/cities/1/route-groups/setup-batch', { name: 'Town service', names: ['Town service', 'Express service'], is_active: true, city_vehicle_type_id: null, route_ids: [20], driver_user_ids: [50], vehicle_ids: [1], vehicle_set_ids: [] });
    editor.extraNames = ['town SERVICE']; expect(editor.namesValid).toBeFalse(); editor.save(); expect(api.post).toHaveBeenCalledTimes(1);
  });
  it('automatically selects vehicles added from the setup form without losing the draft', () => {
    editor.vehicles = [{ id: 1, display_name: 'Sumo', vehicle_type_id: 1 }]; editor.createVehicles();
    editor.vehicles = [...editor.vehicles, { id: 2, display_name: 'Bus', vehicle_type_id: 2 }, { id: 3, display_name: 'Tavera', vehicle_type_id: 3, vehicle_set_id: 10 }];
    editor.ngOnChanges({ vehicles: new SimpleChange([], editor.vehicles, false) });
    expect(editor.vehicleIds.has(2)).toBeTrue(); expect(editor.setIds.has(10)).toBeTrue(); expect(editor.name).toBe('Town service');
  });
  it('keeps all selections on failure and prevents duplicate submissions', () => {
    const request = new Subject(); api.post.and.returnValue(request); editor.routeIds.add(20);
    editor.save(); editor.save(); expect(api.post).toHaveBeenCalledTimes(1);
    request.error({ error: { message: 'Try again' } });
    expect(editor.error).toBe('Try again'); expect(editor.routeIds.has(20)).toBeTrue(); expect(editor.saving).toBeFalse();
  });
  it('keeps edits while adding a route and automatically selects the new priced route', () => {
    editor.vehicles = [{ id: 1, display_name: 'Sumo', vehicle_type_id: 1 }];
    editor.routes = [{ id: 20, name: 'Existing', origin_name: 'A', dest_name: 'B', flat_fare: 20, scope: 'local', is_active: true, city_vehicle_type_id: 1, booking_window_hours: null }];
    editor.routeVehicleId = 1; editor.createRoute();
    editor.routes = [...editor.routes, { ...editor.routes[0], id: 21, name: 'New' }];
    editor.ngOnChanges({ routes: new SimpleChange([], editor.routes, false) });
    expect(editor.name).toBe('Town service'); expect(editor.routeIds.has(21)).toBeTrue();
  });
  it('groups ride-mode options under one vehicle choice without moving existing set members', () => {
    editor.vehicles = [{ id: 1, display_name: 'Sumo', vehicle_type_id: 1 }, { id: 2, display_name: 'Sumo', vehicle_type_id: 1 }, { id: 3, display_name: 'Bus', vehicle_type_id: 2, vehicle_set_id: 10 }];
    expect(editor.standaloneVehicles).toEqual([{ name: 'Sumo', ids: [1, 2] }]);
    editor.toggleFamily([1, 2]); expect([...editor.vehicleIds]).toEqual([1, 2]);
  });
  it('shows plain fixed-route choices once and emits the correct fixed configuration', () => {
    editor.vehicles = [
      { id: 1, display_name: 'Sumo', vehicle_type_id: 1 },
      { id: 2, display_name: 'Sumo', vehicle_type_id: 1, ride_type_name: 'Private' },
      { id: 3, display_name: 'Sumo', vehicle_type_id: 1, ride_type_name: 'Fixed' },
      { id: 4, display_name: 'Sumo', vehicle_type_id: 1, ride_type_name: 'Shuttle' },
      { id: 5, display_name: 'Bus', vehicle_type_id: 2, ride_type_name: 'Fixed', is_active: false },
      { id: 6, display_name: 'Town Sumo', vehicle_type_id: 1, ride_type_name: 'Fixed' },
    ];
    editor.routeVehicleId = 2;
    editor.ngOnChanges({ vehicles: new SimpleChange([], editor.vehicles, false) });
    expect(editor.routeVehicleOptions.map(vehicle => vehicle.id)).toEqual([3, 6]);
    expect(editor.routeVehicleId).toBe(3);
    const emitted = jasmine.createSpy(); editor.addRoute.subscribe(emitted);
    editor.createRoute(); expect(emitted).toHaveBeenCalledOnceWith(3);
    editor.routeVehicleId = 2; editor.createRoute(); expect(emitted).toHaveBeenCalledTimes(1);
  });
  it('keeps the vehicle checkbox stable while toggling a grouped family', () => {
    TestBed.configureTestingModule({ imports: [RouteGroupSetupComponent], providers: [{ provide: ApiService, useValue: api }, { provide: ToastService, useValue: { success: () => undefined } }] });
    const fixture = TestBed.createComponent(RouteGroupSetupComponent);
    fixture.componentInstance.cityId = 1; fixture.componentInstance.section = 'vehicles';
    fixture.componentInstance.vehicles = [{ id: 1, display_name: 'Bus', vehicle_type_id: 2 }, { id: 2, display_name: 'Bus', vehicle_type_id: 2 }];
    fixture.detectChanges();
    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.choices input');
    checkbox.click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.choices input')).toBe(checkbox);
    expect(checkbox.checked).toBeTrue(); expect([...fixture.componentInstance.vehicleIds]).toEqual([1, 2]);
    fixture.destroy();
  });
});
