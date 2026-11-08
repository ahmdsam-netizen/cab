import { SimpleChange } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { RouteGroupSetupComponent } from './route-group-setup.component';

describe('Stand assignment usability', () => {
  let editor: RouteGroupSetupComponent;
  let api: any;
  beforeEach(() => {
    api = { put: jasmine.createSpy().and.returnValue(of({})), post: jasmine.createSpy().and.returnValue(of({})) };
    editor = new RouteGroupSetupComponent(api, { success: () => undefined } as any);
    editor.cityId = 1;
    editor.vehicles = [
      { id: 1, display_name: 'SUMO', vehicle_type_id: 1 }, { id: 2, display_name: 'SUMO', vehicle_type_id: 1 },
      { id: 3, display_name: 'TAVERA', vehicle_type_id: 2 },
    ];
    editor.group = { id: 5, name: 'Town stand', is_active: true, city_vehicle_type_id: 1, route_ids: [20], driver_user_ids: [50], vehicle_set_ids: [] };
    editor.ngOnChanges({ group: new SimpleChange(null, editor.group, true) });
  });
  it('shows the existing primary vehicle as selected without making the form dirty', () => {
    expect(editor.familySelected([1, 2])).toBeTrue(); expect(editor.selectedVehicleCount).toBe(1);
    expect(editor.vehicleSummary).toBe('SUMO'); expect(editor.dirty).toBeFalse();
    editor.toggleFamily([3]); expect(editor.selectedVehicleCount).toBe(2);
    editor.save(); expect(api.put.calls.mostRecent().args).toEqual(['/admin/cities/1/route-groups/5/setup', {
      name: 'Town stand', is_active: true, city_vehicle_type_id: 1, route_ids: [20], driver_user_ids: [50], vehicle_set_ids: [], vehicle_ids: [3],
    }]);
  });
  it('explicitly unchecks the primary association and retains other selections', () => {
    editor.toggleFamily([3]); editor.toggleFamily([1, 2]);
    expect(editor.ownerVehicleId).toBeNull(); expect(editor.familySelected([1, 2])).toBeFalse();
    expect(editor.selectedVehicleLabels).toEqual(['TAVERA']); expect(editor.dirty).toBeTrue();
  });
  it('restores the original association when its checkbox is unchecked then rechecked', () => {
    editor.toggleFamily([1, 2]); editor.toggleFamily([1, 2]);
    expect(editor.ownerVehicleId).toBe(1); expect(editor.vehicleIds.size).toBe(0);
    expect(editor.dirty).toBeFalse();
  });
  it('counts vehicle options inside selected sets once, including an overlapping primary', () => {
    editor.sets = [{ id: 10, name: 'Shared fleet', members: [{ id: 1 }, { id: 2 }, { id: 3 }] }];
    editor.setIds.add(10); expect(editor.selectedVehicleCount).toBe(2);
    expect(editor.selectedVehicleLabels).toEqual(['SUMO', 'TAVERA']);
    editor.vehicleSearch = 'tavera'; expect(editor.shownVehicleSets.map(set => set.id)).toEqual([10]);
  });
  it('filters selections and searches without losing assignments when switching sections', () => {
    editor.selectedOnly = true; expect(editor.shownStandaloneVehicles.map(vehicle => vehicle.name)).toEqual(['SUMO']);
    editor.vehicleSearch = 'tavera'; expect(editor.shownStandaloneVehicles).toEqual([]);
    editor.changeSection('drivers'); expect(editor.selectedOnly).toBeFalse();
    expect(editor.routeIds.has(20)).toBeTrue(); expect(editor.driverIds.has(50)).toBeTrue();
    expect(editor.ownerVehicleId).toBe(1); expect(editor.dirty).toBeFalse();
  });
  it('shows driver photos, falls back after an image error and preserves checkbox selection', () => {
    TestBed.configureTestingModule({ imports: [RouteGroupSetupComponent], providers: [
      { provide: ApiService, useValue: api }, { provide: ToastService, useValue: {} },
    ] });
    const fixture = TestBed.createComponent(RouteGroupSetupComponent);
    const photo = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    Object.assign(fixture.componentInstance, { cityId: 1, group: editor.group, initialSection: 'drivers', drivers: [
      { id: 1, user_id: 50, name: 'Photo driver', avatar_url: photo, vehicle_reg_no: 'JK01', phone: '123' },
      { id: 2, user_id: 60, name: 'No photo', avatar_url: null, vehicle_reg_no: 'JK02', phone: '456' },
    ] });
    fixture.componentInstance.ngOnChanges({ group: new SimpleChange(null, editor.group, true) }); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelectorAll('.driver-choices > label').length).toBe(2);
    const image = root.querySelector<HTMLImageElement>('.driver-photo img')!;
    expect(image.alt).toBe('Photo driver');
    expect(root.querySelectorAll('.driver-photo tm-icon').length).toBe(1);
    image.dispatchEvent(new Event('error')); fixture.detectChanges();
    expect(root.querySelector('.driver-photo img')).toBeNull();
    expect(root.querySelectorAll('.driver-photo tm-icon').length).toBe(2);
    const checkbox = root.querySelector<HTMLInputElement>('[aria-label="Assign Photo driver"]')!;
    expect(checkbox.checked).toBeTrue(); checkbox.click(); fixture.detectChanges();
    expect(fixture.componentInstance.driverIds.has(50)).toBeFalse(); fixture.destroy();
  });
  it('renders searchable vehicle options with a correct selected summary and primary checkbox', () => {
    TestBed.configureTestingModule({ imports: [RouteGroupSetupComponent], providers: [
      { provide: ApiService, useValue: api }, { provide: ToastService, useValue: {} },
    ] });
    const fixture = TestBed.createComponent(RouteGroupSetupComponent);
    const vehiclePhoto = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    editor.vehicles[0].image_url = vehiclePhoto;
    Object.assign(fixture.componentInstance, { cityId: 1, group: editor.group, vehicles: editor.vehicles, initialSection: 'vehicles' });
    fixture.componentInstance.ngOnChanges({ group: new SimpleChange(null, editor.group, true) }); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('.assignment-summary .selected')?.textContent).toContain('SUMO');
    expect(root.querySelector<HTMLInputElement>('.choices input')?.checked).toBeTrue();
    const image = root.querySelector<HTMLImageElement>('.vehicle-photo img')!;
    expect(image.alt).toBe('SUMO'); image.dispatchEvent(new Event('error')); fixture.detectChanges();
    expect(root.querySelector('.vehicle-photo img')).toBeNull();
    expect(root.querySelector('.vehicle-photo tm-icon')).not.toBeNull();
    const search = root.querySelector<HTMLInputElement>('[aria-label="Find vehicles for stand"]')!;
    search.value = 'tavera'; search.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(root.querySelectorAll('.choices > label').length).toBe(1);
    expect(root.querySelector('.choices')?.textContent).toContain('TAVERA'); fixture.destroy();
  });
});
