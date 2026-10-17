import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { IconComponent } from '../../ui';

export interface AiHealthInfo {
  online: boolean;
  status: string;
  service_response?: {
    status?: string;
    service?: string;
    llm_provider?: string;
    laravel_api?: string;
  };
  error?: string;
}

export interface AiChatTestResult {
  reply: string;
  stage: string;
  thread_id: string;
  matched_route?: any;
  options?: any[];
  available_seats?: string[];
  selected_seats?: string[];
  luggage?: any;
  seat_hold_id?: number;
  payment_order?: any;
  error?: string;
}

@Component({
  selector: 'app-admin-ai-assistant',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  template: `
    <div class="ai-console">
      <!-- Health & Connectivity Banner -->
      <div class="ai-card">
        <div class="ai-card__head">
          <div class="ai-card__title">
            <tm-icon name="bolt" [size]="18" />
            <h3>Agentic AI Service Connectivity</h3>
          </div>
          <button
            type="button"
            class="ai-btn ai-btn--subtle"
            [disabled]="isCheckingHealth"
            (click)="checkHealth()"
          >
            <tm-icon name="refresh" [size]="14" />
            <span>{{ isCheckingHealth ? 'Checking...' : 'Refresh Status' }}</span>
          </button>
        </div>

        <div class="ai-card__body">
          <div class="ai-status-row">
            <div class="ai-status-pill" [class.is-online]="health?.online" [class.is-offline]="!health?.online">
              <span class="ai-dot"></span>
              <strong>{{ health?.online ? 'Connected & Healthy' : 'Service Offline / Unreachable' }}</strong>
            </div>

            <div class="ai-meta-item" *ngIf="health?.service_response?.llm_provider">
              <span class="ai-label">LLM Provider:</span>
              <span class="ai-val font-mono">{{ health?.service_response?.llm_provider }}</span>
            </div>

            <div class="ai-meta-item" *ngIf="health?.service_response?.laravel_api">
              <span class="ai-label">Target Backend API:</span>
              <span class="ai-val font-mono">{{ health?.service_response?.laravel_api }}</span>
            </div>
          </div>

          <div class="ai-alert ai-alert--warn" *ngIf="health && !health.online">
            <tm-icon name="alert-triangle" [size]="16" />
            <span>Could not reach FastAPI Agent microservice at port 8105. Verify the service is running.</span>
          </div>
        </div>
      </div>

      <!-- Interactive Agent Testing Console -->
      <div class="ai-card">
        <div class="ai-card__head">
          <div class="ai-card__title">
            <tm-icon name="send" [size]="18" />
            <h3>Test Conversational Fixed-Route Booking</h3>
          </div>
        </div>

        <div class="ai-card__body">
          <p class="ai-hint">
            Simulate a customer natural language prompt. The agent will geocode stops, match routes, fetch active
            departures, and hold seats automatically.
          </p>

          <div class="ai-form">
            <div class="ai-field">
              <label>Natural Language Message</label>
              <input
                type="text"
                class="ai-input"
                [(ngModel)]="testQuery"
                placeholder="e.g. I need a cab to Sopore with 2 bags from Lal Chowk"
                (keyup.enter)="sendTestQuery()"
              />
            </div>

            <div class="ai-form-row">
              <div class="ai-field">
                <label>Test User Lat</label>
                <input type="number" step="0.0001" class="ai-input" [(ngModel)]="testLat" />
              </div>
              <div class="ai-field">
                <label>Test User Lng</label>
                <input type="number" step="0.0001" class="ai-input" [(ngModel)]="testLng" />
              </div>
              <div class="ai-field">
                <label>Thread ID</label>
                <input type="text" class="ai-input" [(ngModel)]="testThreadId" />
              </div>
            </div>

            <div class="ai-actions">
              <button
                type="button"
                class="ai-btn ai-btn--primary"
                [disabled]="isTesting || !testQuery.trim()"
                (click)="sendTestQuery()"
              >
                <tm-icon name="send" [size]="14" />
                <span>{{ isTesting ? 'Processing Agent Request...' : 'Send Prompt to Agent' }}</span>
              </button>

              <button
                type="button"
                class="ai-btn ai-btn--subtle"
                [disabled]="isTesting || testStage !== 'CONFIRMING_DEPARTURE'"
                (click)="confirmTestBooking()"
              >
                <tm-icon name="check" [size]="14" />
                <span>Simulate Confirm Ride</span>
              </button>
            </div>
          </div>

          <!-- Test Response Output -->
          <div class="ai-response-wrap" *ngIf="lastResult">
            <h4 class="ai-subhead">Agent Response</h4>

            <div class="ai-result-box">
              <div class="ai-result-header">
                <span class="ai-stage-badge" [class.is-confirm]="lastResult.stage === 'CONFIRMING_DEPARTURE'" [class.is-await]="lastResult.stage === 'AWAITING_DRIVER'">
                  Stage: {{ lastResult.stage }}
                </span>
                <span class="ai-thread-id font-mono">Thread: {{ lastResult.thread_id }}</span>
              </div>

              <div class="ai-reply-text">
                {{ lastResult.reply }}
              </div>

              <!-- Matched Route -->
              <div class="ai-matched-card" *ngIf="lastResult.matched_route">
                <strong>Matched Route:</strong> {{ lastResult.matched_route.name }}
                <div class="ai-route-stops-tag">
                  Pickup: <em>{{ lastResult.matched_route.board_stop?.name }}</em> &rarr;
                  Drop: <em>{{ lastResult.matched_route.drop_stop?.name }}</em>
                </div>
              </div>

              <!-- Available Departures -->
              <div class="ai-dep-list" *ngIf="lastResult.options && lastResult.options.length">
                <strong>Departures Found ({{ lastResult.options.length }}):</strong>
                <div class="ai-dep-pill" *ngFor="let dep of lastResult.options">
                  <span>Departure #{{ dep.id }}</span>
                  <span *ngIf="dep.vehicle_name">&middot; {{ dep.vehicle_name }}</span>
                  <span *ngIf="dep.price_per_seat">&middot; ₹{{ dep.price_per_seat }}</span>
                </div>
              </div>

              <!-- Seat Hold Indicator -->
              <div class="ai-hold-alert" *ngIf="lastResult.seat_hold_id">
                <tm-icon name="check" [size]="16" />
                <span>Seat Hold Active #{{ lastResult.seat_hold_id }} &middot; Driver approval requested</span>
              </div>

              <!-- Raw Response JSON Collapsible -->
              <details class="ai-raw-details">
                <summary>Inspect Raw JSON</summary>
                <pre class="ai-raw-json">{{ lastResult | json }}</pre>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .ai-console {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .ai-card {
      background: var(--tm-bg-surface, #ffffff);
      border: 1px solid var(--tm-line, #e2e8f0);
      border-radius: 12px;
      overflow: hidden;
    }
    .ai-card__head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 18px;
      border-bottom: 1px solid var(--tm-line, #e2e8f0);
      background: var(--tm-bg-subtle, #f8fafc);
    }
    .ai-card__title {
      display: flex;
      align-items: center;
      gap: 10px;
      h3 {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        color: var(--tm-text, #0f172a);
      }
    }
    .ai-card__body {
      padding: 18px;
    }
    .ai-status-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 20px;
    }
    .ai-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 13px;

      &.is-online {
        background: rgba(16, 185, 129, 0.12);
        color: #059669;
        .ai-dot { background: #10b981; }
      }
      &.is-offline {
        background: rgba(239, 68, 68, 0.12);
        color: #dc2626;
        .ai-dot { background: #ef4444; }
      }
    }
    .ai-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .ai-meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      .ai-label { color: var(--tm-text-muted, #64748b); }
      .ai-val { color: var(--tm-text, #0f172a); font-weight: 600; }
    }
    .ai-alert {
      margin-top: 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      &--warn {
        background: #fffbeb;
        color: #b45309;
        border: 1px solid #fde68a;
      }
    }
    .ai-hint {
      margin: 0 0 16px;
      font-size: 13px;
      color: var(--tm-text-muted, #64748b);
    }
    .ai-form {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .ai-form-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
    }
    .ai-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      label {
        font-size: 12px;
        font-weight: 600;
        color: var(--tm-text-muted, #64748b);
      }
    }
    .ai-input {
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid var(--tm-line, #cbd5e1);
      font-size: 13px;
      background: var(--tm-bg, #ffffff);
      color: var(--tm-text, #0f172a);
      outline: none;
      &:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
      }
    }
    .ai-actions {
      display: flex;
      gap: 10px;
      margin-top: 4px;
    }
    .ai-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 9px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;

      &--primary {
        background: #3b82f6;
        color: #fff;
        &:hover:not(:disabled) { background: #2563eb; }
      }
      &--subtle {
        background: var(--tm-bg-subtle, #f1f5f9);
        color: var(--tm-text, #1e293b);
        border: 1px solid var(--tm-line, #cbd5e1);
        &:hover:not(:disabled) { background: #e2e8f0; }
      }
      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
    .ai-response-wrap {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid var(--tm-line, #e2e8f0);
    }
    .ai-subhead {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 700;
      color: var(--tm-text, #0f172a);
    }
    .ai-result-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .ai-result-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .ai-stage-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      background: #e2e8f0;
      color: #334155;

      &.is-confirm { background: #dbeafe; color: #1d4ed8; }
      &.is-await { background: #fef3c7; color: #b45309; }
    }
    .ai-thread-id {
      font-size: 11px;
      color: #64748b;
    }
    .ai-reply-text {
      font-size: 14px;
      line-height: 1.5;
      color: #0f172a;
      background: #fff;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
    }
    .ai-matched-card {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      color: #1e40af;
    }
    .ai-route-stops-tag {
      margin-top: 4px;
      font-size: 12px;
      color: #3b82f6;
    }
    .ai-dep-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
    }
    .ai-dep-pill {
      background: #fff;
      border: 1px solid #cbd5e1;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      display: flex;
      gap: 6px;
    }
    .ai-hold-alert {
      background: #ecfdf5;
      border: 1px solid #a7f3d0;
      color: #065f46;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ai-raw-details {
      margin-top: 8px;
      font-size: 12px;
      cursor: pointer;
      color: #64748b;

      summary { font-weight: 600; }
    }
    .ai-raw-json {
      margin-top: 8px;
      padding: 12px;
      border-radius: 8px;
      background: #0f172a;
      color: #38bdf8;
      font-size: 11px;
      overflow-x: auto;
    }
    .font-mono { font-family: monospace; }
  `],
})
export class AdminAiAssistantComponent implements OnInit {
  health: AiHealthInfo | null = null;
  isCheckingHealth = false;

  testQuery = 'I want a ride to Sopore from Lal Chowk';
  testLat = 34.0837;
  testLng = 74.7973;
  testThreadId = 'admin_test_' + Math.random().toString(36).substring(2, 7);

  isTesting = false;
  lastResult: AiChatTestResult | null = null;
  testStage = '';

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.checkHealth();
  }

  checkHealth(): void {
    this.isCheckingHealth = true;
    this.api.get<AiHealthInfo>('/ai/health').subscribe({
      next: (res) => {
        this.health = res;
        this.isCheckingHealth = false;
      },
      error: (err) => {
        this.health = {
          online: false,
          status: 'unreachable',
          error: err?.message || 'Failed to reach AI service',
        };
        this.isCheckingHealth = false;
      },
    });
  }

  sendTestQuery(action?: string): void {
    if (!this.testQuery.trim() && !action) return;

    this.isTesting = true;
    this.api
      .post<AiChatTestResult>('/ai/chat', {
        message: this.testQuery,
        thread_id: this.testThreadId,
        user_current_lat: this.testLat,
        user_current_lng: this.testLng,
        action,
      })
      .subscribe({
        next: (res) => {
          this.lastResult = res;
          this.testStage = res.stage;
          this.isTesting = false;
        },
        error: (err) => {
          this.lastResult = {
            reply: 'Error calling agent service: ' + (err?.error?.error || err?.message),
            stage: 'ERROR',
            thread_id: this.testThreadId,
          };
          this.isTesting = false;
        },
      });
  }

  confirmTestBooking(): void {
    this.sendTestQuery('confirm');
  }
}
