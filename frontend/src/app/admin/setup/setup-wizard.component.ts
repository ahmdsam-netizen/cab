import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { CityContextService } from '../../core/city-context.service';
import { ToastService } from '../../core/toast.service';
import { ButtonComponent, DrawerComponent, IconComponent, IconName, StatusPillComponent } from '../../ui';
import { VehicleTypesInlineComponent } from './vehicle-types-inline.component';

interface StepState {
  done: boolean;
  count: number;
  label: string;
}

interface ProgressResponse {
  city_id: number;
  city_name: string;
  steps: Record<string, StepState>;
}

interface StepSpec {
  key: string;
  title: string;
  icon: IconName;
  blurb: string;
  cta: string;
  action: () => void;
}

type DrawerKey = 'vehicle_types' | null;

@Component({
  selector: 'app-setup-wizard',
  standalone: true,
  imports: [CommonModule, ButtonComponent, DrawerComponent, IconComponent, StatusPillComponent, VehicleTypesInlineComponent],
  template: `
    <div class="wizard">
      <header class="wizard__head">
        <div>
          <h1>Setup Wizard</h1>
          <p>Everything needed to bring a city online — in order, in one place.</p>
        </div>
        <div class="wizard__meta" *ngIf="progress">
          <tm-status-pill [tone]="allDone ? 'success' : 'neutral'">
            {{ doneCount }} / {{ specs.length }} done
          </tm-status-pill>
        </div>
      </header>

      <div class="cue" *ngIf="cityId == null">
        <tm-icon name="map-marker" [size]="24" />
        <strong>Pick a city from the top bar</strong>
        <span>Setup is scoped to one city at a time. Choose one to see its progress.</span>
      </div>

      <div class="cue cue--loading" *ngIf="cityId != null && loading && !progress">
        <span>Loading city progress…</span>
      </div>

      <ol class="steps" *ngIf="cityId != null && progress">
        <li class="step" *ngFor="let s of specs; let i = index" [class.step--done]="stateFor(s.key).done">
          <div class="step__num">
            <span *ngIf="!stateFor(s.key).done">{{ i + 1 }}</span>
            <tm-icon *ngIf="stateFor(s.key).done" name="check" [size]="16" />
          </div>
          <div class="step__body">
            <div class="step__head">
              <tm-icon [name]="s.icon" [size]="16" />
              <h2>{{ s.title }}</h2>
              <span class="step__meta">
                <strong>{{ stateFor(s.key).count }}</strong> {{ stateFor(s.key).label }}
              </span>
            </div>
            <p class="step__blurb">{{ s.blurb }}</p>
          </div>
          <div class="step__actions">
            <tm-button [variant]="stateFor(s.key).done ? 'outline' : 'green'"
                       size="sm"
                       icon="chevron-right"
                       (clicked)="s.action()">
              {{ stateFor(s.key).done ? 'Edit' : s.cta }}
            </tm-button>
          </div>
        </li>
      </ol>
    </div>

    <tm-drawer [open]="drawer === 'vehicle_types'"
               title="Vehicle Types"
               subtitle="Manage the global vehicle-type registry"
               (closed)="closeDrawer()">
      <div slot="body">
        <app-vehicle-types-inline (changed)="fetch()"></app-vehicle-types-inline>
      </div>
    </tm-drawer>
  `,
  styles: [`
    .wizard { display: flex; flex-direction: column; gap: 18px; }
    .wizard__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .wizard__head h1 { margin: 0; font-size: 22px; font-weight: 800; color: var(--tm-text); }
    .wizard__head p { margin: 4px 0 0; font-size: 13px; color: var(--tm-text-muted); max-width: 72ch; }
    .cue { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 24px; text-align: center; color: var(--tm-text-muted); background: var(--tm-surface); border: 1px dashed var(--tm-line); border-radius: 14px; }
    .cue strong { color: var(--tm-text); font-size: 14px; }
    .cue--loading { padding: 24px; }
    .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .step { display: grid; grid-template-columns: 44px 1fr auto; gap: 14px; align-items: center; padding: 14px 16px; background: var(--tm-surface); border: 1px solid var(--tm-line); border-radius: 12px; }
    .step--done { background: var(--tm-green-tint, #ecfdf5); border-color: var(--tm-green, #16a34a); }
    .step__num { width: 34px; height: 34px; border-radius: 50%; background: var(--tm-canvas-2, #f3f4f6); color: var(--tm-text-muted); font-weight: 800; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; }
    .step--done .step__num { background: var(--tm-green, #16a34a); color: #fff; }
    .step__body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .step__head { display: flex; align-items: center; gap: 8px; }
    .step__head h2 { margin: 0; font-size: 14px; font-weight: 800; color: var(--tm-text); }
    .step__meta { margin-left: auto; font-size: 11.5px; color: var(--tm-text-muted); font-weight: 700; }
    .step__meta strong { color: var(--tm-text); }
    .step__blurb { margin: 0; font-size: 12.5px; color: var(--tm-text-muted); line-height: 1.4; }
    .step__actions { display: flex; align-items: center; }
    @media (max-width: 720px) {
      .step { grid-template-columns: 40px 1fr; }
      .step__actions { grid-column: 1 / -1; justify-content: flex-end; margin-top: 4px; }
      .step__meta { display: none; }
    }
  `],
})
export class SetupWizardComponent implements OnInit, OnDestroy {
  cityId: number | null = null;
  loading = false;
  progress: ProgressResponse | null = null;
  drawer: DrawerKey = null;
  private subs: Subscription[] = [];

  readonly specs: StepSpec[] = [
    {
      key: 'city_boundary',
      title: 'City & Boundary',
      icon: 'map-marker',
      blurb: 'Set the city’s service polygon. Trips outside the polygon are rejected.',
      cta: 'Draw boundary',
      action: () => this.goWithReturn('/settings/cities'),
    },
    {
      key: 'vehicle_types',
      title: 'Vehicle Types',
      icon: 'car',
      blurb: 'The global list — Sedan, SUV, Two-wheeler, Auto, etc. Shared across cities.',
      cta: 'Add vehicle types',
      action: () => { this.drawer = 'vehicle_types'; },
    },
    {
      key: 'city_vehicles',
      title: 'Vehicles per City',
      icon: 'car',
      blurb: 'Link vehicle types to this city with a display name, seat count and luggage capacity.',
      cta: 'Add vehicles',
      action: () => this.goWithReturn('/vehicles'),
    },
    {
      key: 'seat_layouts',
      title: 'Seat Layouts',
      icon: 'grid',
      blurb: 'Design the seat grid per vehicle type. Drivers pick this on Fixed rides so customers can visually book seats.',
      cta: 'Design layouts',
      action: () => this.goWithReturn('/vehicle-seat-layouts'),
    },
    {
      key: 'fares',
      title: 'Fares',
      icon: 'rupee',
      blurb: 'Configure Private / Fixed / Shuttle fare rules per city vehicle.',
      cta: 'Set fares',
      action: () => this.goWithReturn('/vehicles'),
    },
    {
      key: 'fixed_routes',
      title: 'Fixed Routes & Departures',
      icon: 'map',
      blurb: 'Route departures, stops and flat fares for Fixed rides.',
      cta: 'View departures',
      action: () => this.goWithReturn('/fixed-departures'),
    },
    {
      key: 'route_groups',
      title: 'Stands & Drivers',
      icon: 'users',
      blurb: 'Organize routes into stands and assign drivers.',
      cta: 'View departures',
      action: () => this.goWithReturn('/fixed-departures'),
    },
  ];

  constructor(
    private api: ApiService,
    private cityCtx: CityContextService,
    private toast: ToastService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.cityCtx.ensureCitiesLoaded().subscribe();
    this.subs.push(
      this.cityCtx.cityId$.subscribe((id) => {
        this.cityId = id;
        if (id != null) this.fetch();
        else this.progress = null;
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  fetch(): void {
    if (this.cityId == null) return;
    this.loading = true;
    this.api.get<ProgressResponse>(`/admin/cities/${this.cityId}/setup-progress`).subscribe({
      next: (res) => { this.progress = res; this.loading = false; },
      error: () => {
        this.loading = false;
        this.toast.error('Failed to load setup progress');
      },
    });
  }

  stateFor(key: string): StepState {
    return this.progress?.steps?.[key] ?? { done: false, count: 0, label: '' };
  }

  get doneCount(): number {
    if (!this.progress) return 0;
    return this.specs.reduce((n, s) => n + (this.stateFor(s.key).done ? 1 : 0), 0);
  }

  get allDone(): boolean {
    return this.doneCount === this.specs.length;
  }

  goWithReturn(url: string): void {
    const sep = url.includes('?') ? '&' : '?';
    this.router.navigateByUrl(`${url}${sep}from=setup`);
  }

  closeDrawer(): void {
    this.drawer = null;
    this.fetch();
  }
}
