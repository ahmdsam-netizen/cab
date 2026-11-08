import { Component, OnInit } from '@angular/core';
import { ApiService } from '../../core/api.service';

interface SupportInfo {
  emergency_police_no: string | null;
  customer_support_no: string | null;
  driver_support_no: string | null;
  support_email: string | null;
}

interface Faq {
  q: string;
  a: string;
}

/**
 * Help & Support — the official support channels (pulled out of the old
 * emergency-contacts "Support" segment) plus an FAQ and a report-a-problem
 * shortcut. Support numbers/email come from /support-info (city_settings).
 */
@Component({
  selector: 'app-support',
  templateUrl: './support.page.html',
  styleUrls: ['./support.page.scss'],
  standalone: false,
})
export class SupportPage implements OnInit {
  loading = false;
  error: string | null = null;
  support: SupportInfo | null = null;

  readonly faqs: Faq[] = [
    {
      q: 'How do I go online and start receiving rides?',
      a: 'Open the dashboard and tap “Go Online”. Make sure location permission is granted so we can match you with nearby trips.',
    },
    {
      q: 'When and how do I get paid?',
      a: 'Riders pay online before or after the ride — never in cash. Your share of each fare is sent straight to your own bank account once the trip is complete, with the commission already deducted. Open Ride earnings to see what has been paid and what is still on its way.',
    },
    {
      q: 'Why is some of my money “waiting to be released”?',
      a: 'We can only send money to a verified payout account. Add your bank or UPI details on the Payout account page and everything held is released automatically — nothing is ever lost.',
    },
    {
      q: 'My documents are still under review. What now?',
      a: 'Verification usually completes within a few hours. You’ll be notified the moment you’re approved, and you can re-check the status from your account screen.',
    },
    {
      q: 'How is commission calculated?',
      a: 'Commission depends on your operator’s settings and any active subscription. A commission-free plan removes per-ride deductions — see Subscriptions.',
    },
    {
      q: 'How do I add emergency contacts?',
      a: 'Open “Contact” from the menu and add people manually or straight from your phone. They can be reached during an SOS.',
    },
  ];

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.api.get<SupportInfo>('/support-info').subscribe({
      next: (res) => {
        this.support = res;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || 'Could not load support info.';
        this.loading = false;
      },
    });
  }

  get hasChannels(): boolean {
    // Customer support is intentionally NOT shown in the driver app.
    return !!(
      this.support?.driver_support_no ||
      this.support?.support_email ||
      this.support?.emergency_police_no
    );
  }

  call(phone: string | null | undefined): void {
    if (!phone) return;
    window.location.href = `tel:${phone}`;
  }

  email(addr: string | null | undefined): void {
    if (!addr) return;
    window.location.href = `mailto:${addr}`;
  }

  report(): void {
    const to = this.support?.support_email || '';
    const subject = encodeURIComponent('Driver app — Report a problem');
    const body = encodeURIComponent(
      'Please describe the problem you are facing:\n\n\n— Sent from the Cabbies driver app',
    );
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  }
}
