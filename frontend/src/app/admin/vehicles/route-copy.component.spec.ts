import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { RouteCopyComponent } from './route-copy.component';

describe('Route copy dialog', () => {
  let api: { post: jasmine.Spy; patch?: jasmine.Spy; put?: jasmine.Spy };
  let response: Subject<any>;
  beforeEach(() => {
    response = new Subject();
    api = {
      post: jasmine.createSpy().and.returnValue(response),
      patch: jasmine.createSpy().and.returnValue(new Subject()),
      put: jasmine.createSpy().and.returnValue(new Subject()),
    };
    TestBed.configureTestingModule({
      imports: [RouteCopyComponent],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: { success: jasmine.createSpy() } },
      ],
    });
  });

  function dialog(reverse = false) {
    const fixture = TestBed.createComponent(RouteCopyComponent);
    Object.assign(fixture.componentInstance, {
      cityId: 1,
      reverse,
      route: { id: 20, name: 'Outbound', origin_name: 'Srinagar', dest_name: 'Kupwara', flat_fare: 150 },
      groups: [
        { id: 10, name: 'North Stand', is_active: true, city_vehicle_type_id: 1, route_ids: [20], driver_user_ids: [101] },
        { id: 11, name: 'South Stand', is_active: true, city_vehicle_type_id: 1, route_ids: [], driver_user_ids: [102] },
      ],
      drivers: [
        { id: 1, user_id: 101, name: 'Ahmad Khan', phone: '9876543210', vehicle_reg_no: 'JK01A1234' },
        { id: 2, user_id: 102, name: 'Bilal Lone', phone: '9876543211', vehicle_reg_no: 'JK01B5678' },
        { id: 3, user_id: 103, name: 'Tariq Mir', phone: '9876543212', vehicle_reg_no: 'JK01C9999' },
      ],
    });
    fixture.detectChanges();
    return fixture;
  }

  for (const reverse of [false, true]) {
    it(`creates a ${reverse ? 'reverse' : 'same-direction'} copy with an active status by default and unassigned stands`, async () => {
      const fixture = dialog(reverse), page = fixture.componentInstance;
      const before = JSON.stringify(page.route), saved = jasmine.createSpy(), closed = jasmine.createSpy();
      page.saved.subscribe(saved);
      page.closed.subscribe(closed);
      await fixture.whenStable();
      fixture.detectChanges();

      const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
      expect(input.value).toBe(reverse ? 'Kupwara → Srinagar' : 'Outbound (copy)');
      expect(fixture.nativeElement.querySelector('.direction-endpoints').textContent).toContain(reverse ? 'Kupwara' : 'Srinagar');

      // Stand cards and drivers start unassigned
      expect(page.selectedGroupIds.size).toBe(0);
      expect(page.assignedDriverUserIds).toEqual([]);

      const submit = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
        .find(button => button.textContent?.includes('Save'))!;
      submit.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(api.post).toHaveBeenCalledOnceWith('/admin/cities/1/fixed-routes/20/copy', {
        name: page.name,
        reverse,
        is_active: true,
        assigned_group_ids: null,
        assigned_group_id: null,
        new_group_name: null,
        driver_user_ids: null,
      });
      expect(input.disabled).toBeTrue();
      expect(closed).not.toHaveBeenCalled();

      response.next({ route: { id: 21, name: page.name, is_active: true } });
      expect(saved).toHaveBeenCalledOnceWith({ id: 21, name: page.name, is_active: true });
      expect(closed).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(page.route)).toBe(before);
      fixture.destroy();
    });
  }

  it('allows multi-selecting multiple stand cards and assigning drivers across stands', async () => {
    const fixture = dialog(), page = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();

    // Find stand cards
    const standCards = fixture.nativeElement.querySelectorAll('.stand-card');
    expect(standCards.length).toBe(3); // 2 stands + 1 "New stand" card

    // Click first stand card (North Stand)
    page.toggleGroup(page.groups[0]);
    fixture.detectChanges();
    expect(page.selectedGroupIds.has(10)).toBeTrue();
    expect(page.assignedDriverUserIds).toContain(101);

    // Click second stand card (South Stand) - multiselect!
    page.toggleGroup(page.groups[1]);
    fixture.detectChanges();
    expect(page.selectedGroupIds.has(10)).toBeTrue();
    expect(page.selectedGroupIds.has(11)).toBeTrue();
    expect(page.selectedGroupIds.size).toBe(2);
    expect(page.assignedDriverUserIds).toContain(101);
    expect(page.assignedDriverUserIds).toContain(102);

    // Toggle a third driver
    page.toggleDriver(103);
    expect(page.assignedDriverUserIds).toContain(103);

    page.save();
    expect(api.post).toHaveBeenCalledWith('/admin/cities/1/fixed-routes/20/copy', {
      name: page.name,
      reverse: false,
      is_active: true,
      assigned_group_ids: [10, 11],
      assigned_group_id: null,
      new_group_name: null,
      driver_user_ids: [101, 102, 103],
    });
    fixture.destroy();
  });

  it('supports creating a new stand alongside existing stands', async () => {
    const fixture = dialog(), page = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();

    page.toggleGroup(page.groups[0]);
    page.toggleNewStand();
    page.newGroupName = 'Express Stand';
    page.save();

    expect(api.post).toHaveBeenCalledWith('/admin/cities/1/fixed-routes/20/copy', {
      name: page.name,
      reverse: false,
      is_active: true,
      assigned_group_ids: [10],
      assigned_group_id: 10,
      new_group_name: 'Express Stand',
      driver_user_ids: [101],
    });
    fixture.destroy();
  });

  it('blocks invalid names and keeps duplicate-name errors and draft available for retry', () => {
    const fixture = dialog(), page = fixture.componentInstance;
    page.name = ' ';
    page.save();
    expect(api.post).not.toHaveBeenCalled();

    page.name = 'x'.repeat(121);
    page.save();
    expect(api.post).not.toHaveBeenCalled();

    page.name = 'Taken';
    page.save();
    response.error({ status: 422, error: { errors: { name: ['Taken'] } } });
    fixture.detectChanges();

    expect(page.name).toBe('Taken');
    expect(page.saving).toBeFalse();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('unique route name');
    fixture.destroy();
  });

  it('cancels without creating a route and stops listening after destruction', () => {
    const fixture = dialog(), page = fixture.componentInstance, closed = jasmine.createSpy(), saved = jasmine.createSpy();
    page.closed.subscribe(closed);
    page.saved.subscribe(saved);
    page.close();
    expect(api.post).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);

    page.save();
    fixture.destroy();
    response.next({ route: { id: 21, name: 'Copy' } });
    expect(saved).not.toHaveBeenCalled();
  });
});
