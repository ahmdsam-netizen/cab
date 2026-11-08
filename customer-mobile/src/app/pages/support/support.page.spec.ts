import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular';
import { of, Subject, throwError } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { SupportPage } from './support.page';
import { BookingService } from '../booking/booking.service';

describe('Safety centre', () => {
  let api: { get: jasmine.Spy };
  let alerts: { create: jasmine.Spy };
  beforeEach(async () => {
    api = { get: jasmine.createSpy('get').and.callFake((path: string) => of(path === '/support-info?city_id=7'
      ? { city_id: 7, emergency_no: 'test-number', emergency_police_no: null, support_email: 'support@example.test', customer_support_no: null }
      : { data: [{ id: 1 }, { id: 2 }] })) };
    alerts = { create: jasmine.createSpy('create') };
    await TestBed.configureTestingModule({ declarations: [SupportPage], imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [{ provide: ApiService, useValue: api }, { provide: AlertController, useValue: alerts }, { provide: BookingService, useValue: { supportCityId: 7 } }] }).compileComponents();
  });
  it('uses saved contact counts and six report categories without automatic protection claims', () => {
    const view = TestBed.createComponent(SupportPage); view.componentInstance.ionViewWillEnter(); view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    expect(root.querySelector('.contacts-card')?.textContent).toContain('2 contacts added');
    expect(root.querySelectorAll('.report-grid button').length).toBe(6);
    expect(root.textContent).not.toContain('Get your trip link automatically');
    expect(root.textContent).not.toContain('Route deviation alerts');
    expect(root.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });
  it('does not present failed contact fetches as zero saved contacts and disables missing channels', () => {
    api.get.and.returnValue(throwError(() => new Error('offline')));
    const view = TestBed.createComponent(SupportPage); view.componentInstance.ionViewWillEnter(); view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    expect(root.querySelector('.contacts-card')?.textContent).toContain('Manage trusted contacts');
    expect(root.querySelector('.contacts-card')?.textContent).not.toContain('0 contacts');
    expect((root.querySelector('.sos-card') as HTMLButtonElement).disabled).toBeTrue();
    expect(Array.from(root.querySelectorAll('.report-grid button')).every(b => (b as HTMLButtonElement).disabled)).toBeTrue();
  });
  it('requires confirmation before opening an emergency call and respects cancellation', async () => {
    const page = new SupportPage(api as any, alerts as any, { supportCityId: 7 } as any);
    page.support = { city_id: 7, emergency_no: 'test-number', emergency_police_no: null, support_email: null, customer_support_no: null, driver_support_no: null };
    alerts.create.and.resolveTo({ present: async () => {}, onDidDismiss: async () => ({ role: 'cancel' }) });
    spyOn(page, 'call');
    await page.emergency();
    expect(alerts.create).toHaveBeenCalled(); expect(page.call).not.toHaveBeenCalled();
  });
  it('refreshes contacts on return and handles the genuine empty state', () => {
    const page = new SupportPage(api as any, alerts as any, { supportCityId: 7 } as any); page.ionViewWillEnter();
    expect(page.contactsCount).toBe(2);
    api.get.and.returnValue(of({ data: [] })); page.loadContacts(); expect(page.contactsCount).toBe(0);
  });
  it('rejects other-city responses from an older API and keeps Emergency separate from Police', () => {
    api.get.and.returnValue(of({ city_id: 8, emergency_no: 'other-city' }));
    const page = new SupportPage(api as any, alerts as any, { supportCityId: 7 } as any);
    page.load(); expect(page.support).toBeNull();
    expect(api.get).toHaveBeenCalledWith('/support-info?city_id=7');
    api.get.and.returnValue(of({ city_id: 7, emergency_no: null, emergency_police_no: 'police-only' }));
    const view = TestBed.createComponent(SupportPage); view.componentInstance.load(); view.detectChanges();
    expect((view.nativeElement.querySelector('.sos-card') as HTMLButtonElement).disabled).toBeTrue();
    expect(view.nativeElement.querySelector('.sos-card').textContent).not.toContain('police-only');
  });
  it('does not ask an older API for arbitrary-city contacts without a selected city', () => {
    const page = new SupportPage(api as any, alerts as any, { supportCityId: null } as any);
    page.load(); expect(api.get).not.toHaveBeenCalled(); expect(page.support).toBeNull();
  });
  it('shows the city police number separately and confirms before calling it', async () => {
    api.get.and.returnValue(of({ city_id: 7, emergency_no: 'emergency-line', emergency_police_no: 'police-line' }));
    const view = TestBed.createComponent(SupportPage); view.componentInstance.load(); view.detectChanges();
    expect(view.nativeElement.querySelector('.police-card').textContent).toContain('police-line');
    expect(view.nativeElement.querySelector('.sos-card').textContent).toContain('emergency-line');
    alerts.create.and.resolveTo({ present: async () => {}, onDidDismiss: async () => ({ role: 'confirm' }) });
    spyOn(view.componentInstance, 'call');
    await view.componentInstance.police();
    expect(view.componentInstance.call).toHaveBeenCalledWith('police-line');
    view.componentInstance.support!.emergency_police_no = null; view.detectChanges();
    expect((view.nativeElement.querySelector('.police-card') as HTMLButtonElement).disabled).toBeTrue();
  });
  it('opens each issue as an addressed draft with its category and booking prompts', () => {
    const page = new SupportPage(api as any, alerts as any, { supportCityId: 7 } as any); page.load();
    const open = spyOn<any>(page, 'openContactLink');
    for (const issue of page.issues) {
      page.report(issue.label);
      const uri = open.calls.mostRecent().args[0] as string;
      expect(uri.split('?')[0]).toBe('mailto:support@example.test');
      const query = new URLSearchParams(uri.split('?')[1]);
      expect(query.get('subject')).toBe('Customer app - ' + issue.label);
      expect(query.get('body')).toContain('Issue: ' + issue.label);
      expect(query.get('body')).toContain('Booking ID:');
    }
    page.support = null; open.calls.reset(); page.report(); expect(open).not.toHaveBeenCalled();
  });
  it('uses exact telephone/email targets without substituting the driver number', () => {
    const page = new SupportPage(api as any, alerts as any, { supportCityId: 7 } as any);
    const open = spyOn<any>(page, 'openContactLink');
    page.call('012345'); expect(open).toHaveBeenCalledWith('tel:012345');
    page.email('support@example.test'); expect(open).toHaveBeenCalledWith('mailto:support@example.test');
    open.calls.reset(); page.call(null); page.email(null); expect(open).not.toHaveBeenCalled();
    page.support = { emergency_no: null, emergency_police_no: null, customer_support_no: null, driver_support_no: 'driver', support_email: null };
    expect(page.effectivePhone).toBeNull();
  });
  it('ignores late responses from a previous refresh or city', () => {
    const first = new Subject<any>(); const second = new Subject<any>();
    api.get.and.returnValues(first, second);
    const city = { supportCityId: 7 };
    const page = new SupportPage(api as any, alerts as any, city as any);
    page.load(); page.load();
    second.next({ city_id: 7, emergency_no: 'new' });
    first.next({ city_id: 7, emergency_no: 'old' }); expect(page.support?.emergency_no).toBe('new');
    const third = new Subject<any>(); api.get.and.returnValue(third); page.load();
    city.supportCityId = 8; third.next({ city_id: 7, emergency_no: 'wrong-city' }); expect(page.support).toBeNull();
  });
});
