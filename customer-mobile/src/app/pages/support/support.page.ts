import { Component } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { AlertController } from '@ionic/angular';
import { BookingService } from '../booking/booking.service';

interface SupportInfo {
  city_id?: number | null;
  emergency_no: string | null;
  emergency_police_no: string | null;
  customer_support_no: string | null;
  driver_support_no: string | null;
  support_email: string | null;
}

interface Faq {
  q: string;
  a: string;
}

@Component({
  selector: 'app-support',
  templateUrl: './support.page.html',
  styleUrls: ['./support.page.scss'],
  standalone: false,
})
export class SupportPage {
  loading = false;
  error: string | null = null;
  support: SupportInfo | null = null;
  contactsCount: number | null = null;
  contactsError = false;
  private supportRequest = 0;
  readonly issues = [
    { label: 'Driver behaviour', icon: 'person-outline' },
    { label: 'Overcharged', icon: 'card-outline' },
    { label: 'Unsafe driving', icon: 'speedometer-outline' },
    { label: 'Wrong pickup', icon: 'location-outline' },
    { label: 'Lost item', icon: 'search-outline' },
    { label: 'Refund delay', icon: 'sync-outline' },
  ];

  readonly faqs: Faq[] = [
    {
      q: 'How do I book a ride?',
      a: 'Choose pickup and drop locations, select the ride type, then confirm the booking. For fixed rides, choose the route, departure, boarding stop, and drop stop.',
    },
    {
      q: 'How do I track my driver?',
      a: 'Open your active ride screen after a driver is assigned. The map updates with the latest driver location when location tracking is available.',
    },
    {
      q: 'Can I cancel a booking?',
      a: 'Yes. Open the active ride or fixed booking details and use Cancel. Refund availability depends on the booking type and cancellation time.',
    },
    {
      q: 'How do fixed route bookings work?',
      a: 'Select a fixed route, pick a live departure, then choose your boarding and drop stops. You can book only from stops the vehicle has not already passed.',
    },
    {
      q: 'How do I manage emergency contacts?',
      a: 'Open Contact from the menu and add trusted people manually or from your phone contacts. They are used for SOS and safety support.',
    },
  ];

  constructor(private api: ApiService, private alerts: AlertController, private booking: BookingService) {}

  ionViewWillEnter(): void { this.load(); this.loadContacts(); }

  loadContacts(): void {
    this.contactsError = false;
    this.contactsCount = null;
    this.api.get<{ data: unknown[] }>('/me/emergency-contacts').subscribe({
      next: res => { this.contactsCount = res.data?.length ?? 0; },
      error: () => { this.contactsError = true; },
    });
  }

  async emergency(): Promise<void> {
    await this.confirmCall(this.support?.emergency_no, 'Call emergency services?');
  }

  async police(): Promise<void> {
    await this.confirmCall(this.support?.emergency_police_no, 'Call police?');
  }

  private async confirmCall(phone: string | null | undefined, header: string): Promise<void> {
    if (!phone) return;
    const alert = await this.alerts.create({
      header,
      message: `This will open your phone to call ${phone}.`,
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Call', role: 'confirm' }],
    });
    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role === 'confirm') this.call(phone);
  }

  load(): void {
    const request = ++this.supportRequest;
    this.loading = true;
    this.error = null;
    this.support = null;
    const cityId = this.booking.supportCityId;
    if (!cityId) {
      this.error = 'Choose your city on Home to view its support contacts.';
      this.loading = false;
      return;
    }
    this.api.get<SupportInfo>(`/support-info?city_id=${cityId}`).subscribe({
      next: (res) => {
        if (request !== this.supportRequest || this.booking.supportCityId !== cityId) return;
        // Older API deployments may return a different city's fallback contacts.
        if (cityId && Number(res.city_id) !== cityId) {
          this.error = 'Support contacts are not configured for this city.';
          this.loading = false;
          return;
        }
        this.support = res;
        this.loading = false;
      },
      error: (err) => {
        if (request !== this.supportRequest || this.booking.supportCityId !== cityId) return;
        this.error = err?.error?.message || 'Could not load support info.';
        this.loading = false;
      },
    });
  }

  get hasChannels(): boolean {
    return !!(
      this.effectivePhone ||
      this.support?.support_email ||
      this.support?.emergency_police_no
    );
  }

  get effectivePhone(): string | null {
    return this.support?.customer_support_no || null;
  }

  call(phone: string | null | undefined): void {
    if (!phone) return;
    this.openContactLink(`tel:${phone}`);
  }

  email(addr: string | null | undefined): void {
    if (!addr) return;
    this.openContactLink(`mailto:${addr}`);
  }

  report(issue = 'Report a problem'): void {
    const to = this.support?.support_email;
    if (!to) return;
    const subject = encodeURIComponent(`Customer app - ${issue}`);
    const body = encodeURIComponent(
      `Issue: ${issue}\nBooking ID:\nRide date:\nPlease describe what happened:\n\n\n- Sent from the DreamCabs customer app`,
    );
    this.openContactLink(`mailto:${to}?subject=${subject}&body=${body}`);
  }

  private openContactLink(uri: string): void { window.location.href = uri; }
}
