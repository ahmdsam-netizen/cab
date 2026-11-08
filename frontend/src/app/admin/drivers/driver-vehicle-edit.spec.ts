import { of, Subject, throwError } from 'rxjs';
import { DriverDetailComponent } from './driver-detail.component';

describe('Driver vehicle editing', () => {
  let page: DriverDetailComponent;
  let api: { get: jasmine.Spy; patch: jasmine.Spy };
  let toast: { error: jasmine.Spy };
  beforeEach(() => {
    api = { get: jasmine.createSpy(), patch: jasmine.createSpy().and.returnValue(new Subject()) };
    toast = { error: jasmine.createSpy() };
    page = new DriverDetailComponent({} as any, {} as any, api as any, toast as any, {} as any);
    page.driverId = 9;
    page.profile = { city_ids: [1, 2], city_vehicle_type_id: 10 } as any;
    page.editForm = { name: 'Driver', phone: '', email: '', dob: '', address: '', city_ids: [1, 2], service_scope: 'local', service_mode: 'fixed', vehicle_type_id: 3, city_vehicle_type_id: 10, vehicle_reg_no: 'JK01', vehicle_model: '2024', vehicle_color: 'White' };
    page.allCities = [{ id: 1, name: 'Sopore' }, { id: 2, name: 'Srinagar' }];
  });
  it('keeps the edit form open and displays the server reason when active work blocks a save', () => {
    const message = 'Complete or close the current ride/departure before changing this driver’s vehicle.';
    api.patch.and.returnValue(throwError(() => ({ status: 422, error: { message } })));
    page.editOpen = true;
    page.submitEditProfile();
    expect(page.editOpen).toBeTrue();
    expect(page.editSaving).toBeFalse();
    expect(page.editSaveError).toBe(message);
    expect(toast.error).toHaveBeenCalledWith(message, { title: 'Update failed' });
  });
  it('loads vehicles across operating cities and saves matching category', () => {
    api.get.and.callFake((url: string) => of({ data: url.includes('/1/')
      ? [{ id: 10, display_name: 'SUMO', vehicle_type_id: 3 }, { id: 11, is_active: false }]
      : [{ id: 20, display_name: 'INNOVA', vehicle_type_id: 5 }] }));
    page.loadCityVehiclesForEdit();
    expect(page.cityVehicleOptions.map(v => v.id)).toEqual([10, 20]);
    page.chooseEditVehicle('innova');
    page.submitEditProfile();
    expect(api.patch.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ city_vehicle_type_id: 20, vehicle_type_id: 5, vehicle_reg_no: 'JK01' }));
  });
  it('uses the saved city vehicle name when its ID points to another option', () => {
    page.profile = { city_ids: [1], city_vehicle_type_id: 10, city_vehicle_type_name: 'SWIFT', service_mode: 'private' } as any;
    page.editForm = { ...page.editForm!, city_ids: [1], service_mode: 'private', city_vehicle_type_id: 10 };
    api.get.and.returnValue(of({ data: [
      { id: 10, display_name: 'SUMO', vehicle_type_id: 3 },
      { id: 22, display_name: 'SWIFT', vehicle_type_id: 4 },
    ] }));

    page.loadCityVehiclesForEdit();

    expect(page.editVehicleChoices.map(vehicle => vehicle.name)).toEqual(['SUMO', 'SWIFT']);
    expect(page.editVehicleKey).toBe('swift');
    expect(page.selectedEditVehicle?.id).toBe(22);
    expect(page.editForm!.city_vehicle_type_id).toBe(22);
  });
  it('falls back to the registered vehicle category when the city vehicle label is absent', () => {
    page.profile = { city_ids: [1], city_vehicle_type_id: 10, vehicle_type_name: 'SWIFT', service_mode: 'private' } as any;
    page.editForm = { ...page.editForm!, city_ids: [1], service_mode: 'private', city_vehicle_type_id: 10 };
    api.get.and.returnValue(of({ data: [
      { id: 10, display_name: 'SUMO', vehicle_type_id: 3 },
      { id: 22, display_name: 'SWIFT', vehicle_type_id: 4 },
    ] }));

    page.loadCityVehiclesForEdit();

    expect(page.editVehicleKey).toBe('swift');
    expect(page.selectedEditVehicle?.id).toBe(22);
    expect(page.editForm!.city_vehicle_type_id).toBe(22);
  });
  it('shows a vehicle once and resolves fixed, private and shuttle configurations from service mode', () => {
    page.cityVehicleOptions = [
      { id: 10, display_name: 'SUMO', vehicle_type_id: 3, ride_type_id: 1, ride_type_mode: 'fixed' },
      { id: 11, display_name: 'SUMO', vehicle_type_id: 3, ride_type_id: 2, ride_type_mode: 'private' },
      { id: 12, display_name: 'sumo', vehicle_type_id: 3, ride_type_id: 3, ride_type_mode: 'shuttle' },
    ];
    expect(page.editVehicleChoices.length).toBe(1);
    page.chooseEditVehicle('sumo');
    expect(page.editForm!.city_vehicle_type_id).toBe(10);
    page.editForm!.service_mode = 'private'; page.syncEditVehicle();
    expect(page.editForm!.city_vehicle_type_id).toBe(11);
    page.editForm!.service_mode = 'shuttle'; page.syncEditVehicle();
    expect(page.editForm!.city_vehicle_type_id).toBe(12);
    page.submitEditProfile();
    expect(api.patch.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ city_vehicle_type_id: 12, vehicle_type_id: 3, ride_type_id: 3, service_mode: 'shuttle' }));
  });
  it('ignores stale city responses and blocks an unavailable vehicle after city changes', () => {
    const old = new Subject<any>();
    api.get.and.returnValue(old);
    page.loadCityVehiclesForEdit();
    page.editForm!.city_ids = [2];
    api.get.and.returnValue(of({ data: [{ id: 20, display_name: 'INNOVA', vehicle_type_id: 5 }] }));
    page.loadCityVehiclesForEdit();
    old.next({ data: [{ id: 99 }] }); old.complete();
    expect(page.cityVehicleOptions.map(v => v.id)).toEqual([20]);
    page.submitEditProfile();
    expect(api.patch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });
});
