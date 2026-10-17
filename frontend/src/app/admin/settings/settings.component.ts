import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CitySettingsComponent } from './city-settings.component';
import { AdminAiAssistantComponent } from './admin-ai-assistant.component';
import { IconComponent, IconName } from '../../ui';

/**
 * City Settings shell. A design-system tab bar switches between the
 * city-scoped settings screens. The active city comes from the topbar
 * switcher — each child component observes it.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    IconComponent,
    CitySettingsComponent,
    AdminAiAssistantComponent,
  ],
  template: `
    <div class="stg">
      <nav class="stg__tabs" role="tablist">
        <button
          *ngFor="let t of tabs; let i = index"
          type="button"
          role="tab"
          class="stg__tab"
          [class.is-on]="activeIndex === i"
          [attr.aria-selected]="activeIndex === i"
          (click)="activeIndex = i"
        >
          <tm-icon [name]="t.icon" [size]="15" />
          <span>{{ t.label }}</span>
        </button>
      </nav>

      <div class="stg__panel">
        <app-city-settings *ngIf="activeIndex === 0"></app-city-settings>
        <app-admin-ai-assistant *ngIf="activeIndex === 1"></app-admin-ai-assistant>
      </div>
    </div>
  `,
  styles: [`
    .stg { display: flex; flex-direction: column; gap: 18px; }

    .stg__tabs {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid var(--tm-line);
      overflow-x: auto;
    }
    .stg__tab {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 11px 16px;
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      color: var(--tm-text-muted);
      transition: color var(--tm-duration-fast) var(--tm-ease),
                  border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .stg__tab:hover { color: var(--tm-text); }
    .stg__tab.is-on {
      color: var(--tm-green);
      border-bottom-color: var(--tm-green);
    }

    .stg__panel { min-width: 0; }
  `],
})
export class SettingsComponent {
  activeIndex = 0;

  tabs: { label: string; icon: IconName }[] = [
    { label: 'City Settings', icon: 'cog' },
    { label: 'Agentic AI Service', icon: 'bolt' },
  ];
}

