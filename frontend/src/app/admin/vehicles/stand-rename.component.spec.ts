import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { StandRenameComponent } from './stand-rename.component';

describe('Stand rename dialog', () => {
  let api: { patch: jasmine.Spy };
  let response: Subject<any>;
  beforeEach(() => {
    response = new Subject(); api = { patch: jasmine.createSpy().and.returnValue(response) };
    TestBed.configureTestingModule({ imports: [StandRenameComponent], providers: [
      { provide: ApiService, useValue: api }, { provide: ToastService, useValue: { success: jasmine.createSpy() } },
    ] });
  });
  function dialog() {
    const fixture = TestBed.createComponent(StandRenameComponent);
    const group = { id: 5, name: 'Old stand', is_active: false, city_vehicle_type_id: 8, route_ids: [20], driver_user_ids: [50], vehicle_set_ids: [10] };
    Object.assign(fixture.componentInstance, { cityId: 1, group }); fixture.detectChanges();
    return fixture;
  }
  it('sends only the trimmed name, blocks duplicate submission and emits the saved name', async () => {
    const fixture = dialog(), page = fixture.componentInstance;
    const before = JSON.stringify(page.group), saved = jasmine.createSpy(), closed = jasmine.createSpy();
    page.saved.subscribe(saved); page.closed.subscribe(closed);
    await fixture.whenStable(); fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    expect(input.value).toBe('Old stand');
    input.value = '  New stand  '; input.dispatchEvent(new Event('input')); await fixture.whenStable(); fixture.detectChanges();
    const save = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(button => button.textContent?.trim() === 'Save')!;
    save.click(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); page.save(); page.close();
    expect(api.patch).toHaveBeenCalledOnceWith('/admin/cities/1/route-groups/5', { name: 'New stand' });
    expect(input.disabled).toBeTrue(); expect(closed).not.toHaveBeenCalled();
    response.next({ route_group: { name: 'New stand' } });
    expect(saved).toHaveBeenCalledOnceWith({ id: 5, name: 'New stand' }); expect(closed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(page.group)).toBe(before); fixture.destroy();
  });
  it('rejects blank and overlong names without making a request', () => {
    const fixture = dialog(), page = fixture.componentInstance;
    page.name = '   '; page.save(); expect(page.error).toContain('Enter a stand name');
    page.name = 'x'.repeat(121); page.save(); expect(page.error).toContain('120');
    expect(api.patch).not.toHaveBeenCalled(); fixture.destroy();
  });
  it('retains the draft and shows a useful duplicate-name error for retry', () => {
    const fixture = dialog(), page = fixture.componentInstance, closed = jasmine.createSpy(); page.closed.subscribe(closed);
    page.name = 'Existing stand'; page.save();
    response.error({ status: 422, error: { errors: { name: ['The name has already been taken.'] } } }); fixture.detectChanges();
    expect(page.saving).toBeFalse(); expect(page.name).toBe('Existing stand');
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('unique stand name');
    expect(closed).not.toHaveBeenCalled(); fixture.destroy();
  });
  it('cancels or leaves an unchanged name without saving', () => {
    const fixture = dialog(), page = fixture.componentInstance, closed = jasmine.createSpy(); page.closed.subscribe(closed);
    page.save(); page.name = 'Unsaved'; page.close();
    expect(api.patch).not.toHaveBeenCalled(); expect(page.group.name).toBe('Old stand'); expect(closed).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });
});
