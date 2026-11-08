import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-booking-voice',
  standalone: false,
  templateUrl: './voice.page.html',
  styleUrls: ['./voice.page.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookingVoicePage {}
