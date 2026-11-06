import { of, Subject, throwError } from 'rxjs';
import { DriversListComponent } from './drivers-list.component';
import { DriverRouteGroupsPanelComponent } from './driver-route-groups-panel.component';

describe('All Drivers route allocation integration', () => {
  let page: DriversListComponent;
  let api: { get: jasmine.Spy };
  beforeEach(() => {
    api = { get: jasmine.createSpy() };
    page = new DriversListComponent(api as any, { error: jasmine.createSpy() } as any, {} as any, {} as any, {} as any, {} as any);
  });
  it('separates approval views server-side and resets pagination without clearing other filters', () => {
    api.get.and.returnValue(of({ allocation_filters_supported: true, data: { data: [], total: 0 } }));
    page.page = 4; page.search = 'Ali';
    page.selectApproval('not_approved');
    expect(page.page).toBe(1);
    expect(api.get.calls.mostRecent().args[0]).toContain('approval_status=not_approved');
    expect(api.get.calls.mostRecent().args[0]).toContain('q=Ali');
    page.selectApproval('approved');
    expect(api.get.calls.mostRecent().args[0]).toContain('approval_status=approved');
    page.selectApproval('all');
    expect(api.get.calls.mostRecent().args[0]).not.toContain('approval_status=');
  });
  it('loads hosted membership data without inventing a zero route count', () => {
    api.get.and.callFake((url: string) => url.includes('/route-groups')
      ? of({ assigned_group_ids: [2], groups: [{ id: 1, name: 'Other' }, { id: 2, name: 'Airport' }] })
      : of({ data: { data: [{ id: 4 }], total: 1 } }));
    page.reload();
    expect(page.rows[0].route_groups?.map(group => group.name)).toEqual(['Airport']);
    expect(page.rows[0].allocated_route_count).toBeUndefined();
    expect(page.allocationFiltersSupported).toBeFalse();
    page.reload();
    expect(api.get.calls.allArgs().filter(args => args[0].includes('/route-groups')).length).toBe(1);
  });
  it('cancels an old request when city or vehicle filters change during loading', () => {
    const old = new Subject<any>();
    api.get.and.returnValue(old);
    page.reload();
    api.get.and.returnValue(of({ allocation_filters_supported: true, data: { data: [], total: 0 } }));
    page.allocationCityId = 8; page.allocationVehicleId = 12; page.cityScope = 'selected'; page.reload();
    expect(api.get.calls.mostRecent().args[0]).toContain('city_id=8');
    expect(api.get.calls.mostRecent().args[0]).toContain('city_vehicle_type_id=12');
    old.next({ data: { data: [{ id: 99 }], total: 1 } });
    expect(page.rows).toEqual([]); expect(page.total).toBe(0);
    expect(page.allocationFiltersSupported).toBeTrue();
  });
  it('filters the existing list by city and stand and clears the stand when switching cities', () => {
    api.get.and.callFake((url: string) => /\/(vehicle-types|driver-stand-counts)$/.test(url)
      ? of({ data: [] })
      : of({ allocation_filters_supported: true, data: { data: [], total: 0 } }));
    page.search = 'Alice';
    page.selectDriverCity(8);
    page.page = 4;
    page.selectDriverStand(12);
    expect(page.page).toBe(1);
    expect(api.get.calls.mostRecent().args[0]).toContain('city_id=8&stand_id=12');
    expect(api.get.calls.mostRecent().args[0]).toContain('q=Alice');

    page.selectDriverCity(9);
    expect(page.selectedStandId).toBeNull();
    expect(api.get.calls.mostRecent().args[0]).toContain('city_id=9');
    expect(api.get.calls.mostRecent().args[0]).not.toContain('stand_id=');
  });
  it('uses stand membership across driver pages when the stand-count endpoint is unavailable', () => {
    api.get.and.callFake((url: string) => {
      if (url.endsWith('/driver-stand-counts')) return throwError(() => ({ status: 404 }));
      if (url.endsWith('/route-groups')) return of({ data: [
        { id: 12, name: 'Airport', driver_user_ids: [20], driver_count: 1, is_active: true },
      ] });
      if (url.endsWith('/vehicle-types')) return of({ data: [] });
      const params = new URLSearchParams(url.split('?')[1]);
      const isFirstPage = params.get('page') === '1';
      return of({ allocation_filters_supported: true, data: {
        data: isFirstPage ? [{ id: 4, user: { id: 10 } }] : [{ id: 5, user: { id: 20 } }],
        total: 2,
        last_page: 2,
      } });
    });
    page.selectDriverCity(8);
    page.selectDriverStand(12);
    expect(page.rows.map(row => row.id)).toEqual([5]);
    expect(page.total).toBe(1);
    expect(api.get.calls.mostRecent().args[0]).toContain('page=2');
    expect(api.get.calls.mostRecent().args[0]).not.toContain('stand_id=');
  });
});
describe('Driver assignment loading', () => {
  it('blocks saves before a successful read and after a load failure', () => {
    const response = new Subject<any>();
    const api = { get: jasmine.createSpy().and.returnValue(response), put: jasmine.createSpy() };
    const panel = new DriverRouteGroupsPanelComponent(api as any, {} as any);
    panel.driverId = 4; panel.load(); panel.save(); expect(api.put).not.toHaveBeenCalled();
    response.error(new Error('Unavailable')); panel.save(); expect(api.put).not.toHaveBeenCalled();
    expect(panel.loadFailed).toBeTrue();
  });
});
