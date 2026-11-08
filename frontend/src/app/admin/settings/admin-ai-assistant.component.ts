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
  audio_base64?: string;
  audio_format?: string;
  audio_language?: string;
  error?: string;
}

export interface RateLimitConfig {
  max_conversations_per_day: number;
  max_requests_per_day: number;
  max_requests_per_minute: number;
  enabled: boolean;
}

export interface UserRateLimitUsage {
  user_id: string;
  date: string;
  conversations_used_today: number;
  max_conversations_per_day: number;
  requests_used_today: number;
  max_requests_per_day: number;
  requests_last_minute: number;
  max_requests_per_minute: number;
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

      <!-- Rate Limiting & Conversation Quotas Card -->
      <div class="ai-card">
        <div class="ai-card__head">
          <div class="ai-card__title">
            <tm-icon name="shield" [size]="18" />
            <h3>Rate Limiting & Conversation Quotas</h3>
          </div>
          <button
            type="button"
            class="ai-btn ai-btn--subtle"
            [disabled]="isLoadingRateLimit"
            (click)="loadRateLimitConfig()"
          >
            <tm-icon name="refresh" [size]="14" />
            <span>{{ isLoadingRateLimit ? 'Loading...' : 'Reload Config' }}</span>
          </button>
        </div>

        <div class="ai-card__body">
          <p class="ai-hint">
            Protect LLM costs, prevent spam, and enforce per-user conversation caps on the LangGraph agent microservice.
            Changes take effect immediately without restarting the service.
          </p>

          <div class="ai-form">
            <!-- Active Toggle -->
            <div class="ai-toggle-row">
              <label class="ai-toggle-label">
                <input
                  type="checkbox"
                  class="ai-checkbox"
                  [(ngModel)]="rateLimitConfig.enabled"
                />
                <span class="ai-toggle-text">Enable Per-User Rate Limiting</span>
              </label>
              <span class="ai-status-tag" [class.is-enabled]="rateLimitConfig.enabled" [class.is-disabled]="!rateLimitConfig.enabled">
                {{ rateLimitConfig.enabled ? 'ACTIVE & ENFORCED' : 'DISABLED' }}
              </span>
            </div>

            <!-- 3 Limit Inputs -->
            <div class="ai-form-row">
              <div class="ai-field">
                <label>Max New Conversations / Day (per user)</label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  class="ai-input"
                  [(ngModel)]="rateLimitConfig.max_conversations_per_day"
                />
                <span class="ai-input-desc">Total fresh chats a user can start per day.</span>
              </div>

              <div class="ai-field">
                <label>Max Requests / Day (per user)</label>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  class="ai-input"
                  [(ngModel)]="rateLimitConfig.max_requests_per_day"
                />
                <span class="ai-input-desc">Upper bound on total requests across all chats.</span>
              </div>

              <div class="ai-field">
                <label>Max Requests / Minute (RPM Burst Limit)</label>
                <input
                  type="number"
                  min="1"
                  max="500"
                  class="ai-input"
                  [(ngModel)]="rateLimitConfig.max_requests_per_minute"
                />
                <span class="ai-input-desc">Anti-spam burst shield for fast button clicks.</span>
              </div>
            </div>

            <!-- Actions & Status Notifications -->
            <div class="ai-actions">
              <button
                type="button"
                class="ai-btn ai-btn--primary"
                [disabled]="isSavingRateLimit"
                (click)="saveRateLimitConfig()"
              >
                <tm-icon name="check" [size]="14" />
                <span>{{ isSavingRateLimit ? 'Saving Changes...' : 'Save Rate Limit Settings' }}</span>
              </button>

              <div class="ai-save-success" *ngIf="rateLimitSaveSuccess">
                <tm-icon name="check" [size]="14" />
                <span>Settings updated successfully!</span>
              </div>
            </div>

            <div class="ai-alert ai-alert--warn" *ngIf="rateLimitError">
              <tm-icon name="alert-triangle" [size]="16" />
              <span>{{ rateLimitError }}</span>
            </div>

            <!-- User Lookup & Reset Sub-panel -->
            <div class="ai-user-tools">
              <h4 class="ai-subhead">Customer Support: Inspect or Reset User Quota</h4>
              <div class="ai-user-tools-row">
                <input
                  type="text"
                  class="ai-input ai-input--compact"
                  [(ngModel)]="lookupUserId"
                  placeholder="Enter User ID (e.g. 101 or customer_user_101)"
                />
                <button
                  type="button"
                  class="ai-btn ai-btn--subtle"
                  [disabled]="isLookingUpUser || !lookupUserId.trim()"
                  (click)="lookupUserUsage()"
                >
                  <tm-icon name="search" [size]="14" />
                  <span>{{ isLookingUpUser ? 'Checking...' : 'Check Usage' }}</span>
                </button>
                <button
                  type="button"
                  class="ai-btn ai-btn--danger"
                  [disabled]="isResettingUser || !lookupUserId.trim()"
                  (click)="resetUserUsage()"
                >
                  <tm-icon name="refresh" [size]="14" />
                  <span>{{ isResettingUser ? 'Resetting...' : 'Reset Limits for User' }}</span>
                </button>
              </div>

              <div class="ai-user-usage-card" *ngIf="userUsage">
                <div class="ai-usage-stat">
                  <span class="ai-stat-label">User ID:</span>
                  <span class="ai-stat-val font-mono">{{ userUsage.user_id }}</span>
                </div>
                <div class="ai-usage-stat">
                  <span class="ai-stat-label">Date:</span>
                  <span class="ai-stat-val">{{ userUsage.date }}</span>
                </div>
                <div class="ai-usage-stat">
                  <span class="ai-stat-label">Conversations Used Today:</span>
                  <span class="ai-stat-val" [class.is-limit]="userUsage.conversations_used_today >= userUsage.max_conversations_per_day">
                    {{ userUsage.conversations_used_today }} / {{ userUsage.max_conversations_per_day }}
                  </span>
                </div>
                <div class="ai-usage-stat">
                  <span class="ai-stat-label">Requests Used Today:</span>
                  <span class="ai-stat-val" [class.is-limit]="userUsage.requests_used_today >= userUsage.max_requests_per_day">
                    {{ userUsage.requests_used_today }} / {{ userUsage.max_requests_per_day }}
                  </span>
                </div>
              </div>

              <div class="ai-save-success" *ngIf="userResetSuccess">
                <tm-icon name="check" [size]="14" />
                <span>{{ userResetSuccess }}</span>
              </div>
            </div>
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

              <div class="ai-field">
                <label>Voice Mode Language</label>
                <select class="ai-input" [(ngModel)]="testLanguage">
                  <option value="en">English (en-IN)</option>
                  <option value="hi">Hindi (hi-IN)</option>
                  <option value="ur">Urdu (ur-IN)</option>
                </select>
              </div>

              <div class="ai-field" style="justify-content: flex-end;">
                <label class="ai-toggle-label" style="padding-bottom: 8px;">
                  <input type="checkbox" class="ai-checkbox" [(ngModel)]="testVoiceMode" />
                  <span>Synthesize Voice (edge-tts)</span>
                </label>
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

              <!-- Spoken Voice Audio Player -->
              <div class="ai-audio-block" *ngIf="lastResult.audio_base64">
                <div class="ai-audio-title">
                  <tm-icon name="bolt" [size]="14" />
                  <span>Synthesized Voice ({{ lastResult.audio_language?.toUpperCase() || 'AUDIO' }}):</span>
                </div>
                <audio controls [src]="'data:audio/mp3;base64,' + lastResult.audio_base64" class="ai-audio-elem"></audio>
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
      &--danger {
        background: #fee2e2;
        color: #b91c1c;
        border: 1px solid #fca5a5;
        &:hover:not(:disabled) { background: #fecaca; }
      }
      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
    .ai-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--tm-bg-subtle, #f8fafc);
      border: 1px solid var(--tm-line, #e2e8f0);
      border-radius: 8px;
    }
    .ai-toggle-label {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      font-weight: 600;
      color: var(--tm-text, #0f172a);
      cursor: pointer;
    }
    .ai-checkbox {
      width: 16px;
      height: 16px;
      accent-color: #3b82f6;
      cursor: pointer;
    }
    .ai-status-tag {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      &.is-enabled { background: #dcfce7; color: #15803d; }
      &.is-disabled { background: #fee2e2; color: #b91c1c; }
    }
    .ai-input-desc {
      font-size: 11px;
      color: var(--tm-text-muted, #64748b);
    }
    .ai-save-success {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      color: #16a34a;
      padding: 6px 10px;
    }
    .ai-user-tools {
      margin-top: 14px;
      padding-top: 16px;
      border-top: 1px solid var(--tm-line, #e2e8f0);
    }
    .ai-user-tools-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ai-input--compact {
      max-width: 280px;
    }
    .ai-user-usage-card {
      margin-top: 12px;
      padding: 12px 14px;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }
    .ai-usage-stat {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 12px;
      .ai-stat-label { color: #64748b; font-weight: 500; }
      .ai-stat-val {
        color: #0f172a;
        font-weight: 700;
        font-size: 14px;
        &.is-limit { color: #dc2626; }
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
    .ai-audio-block {
      margin-top: 10px;
      padding: 10px 14px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ai-audio-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
      color: #1e293b;
    }
    .ai-audio-elem {
      width: 100%;
      height: 38px;
    }
  `],
})
export class AdminAiAssistantComponent implements OnInit {
  health: AiHealthInfo | null = null;
  isCheckingHealth = false;

  // Rate Limiting State
  rateLimitConfig: RateLimitConfig = {
    max_conversations_per_day: 5,
    max_requests_per_day: 100,
    max_requests_per_minute: 25,
    enabled: true,
  };
  isLoadingRateLimit = false;
  isSavingRateLimit = false;
  rateLimitSaveSuccess = false;
  rateLimitError = '';

  // User Lookup and Reset State
  lookupUserId = '';
  isLookingUpUser = false;
  userUsage: UserRateLimitUsage | null = null;
  isResettingUser = false;
  userResetSuccess = '';

  testVoiceMode = false;
  testLanguage = 'en';

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
    this.loadRateLimitConfig();
  }

  loadRateLimitConfig(): void {
    this.isLoadingRateLimit = true;
    this.rateLimitError = '';
    this.api.get<RateLimitConfig>('/ai/rate-limits/config').subscribe({
      next: (cfg: RateLimitConfig) => {
        if (cfg) {
          this.rateLimitConfig = { ...cfg };
        }
        this.isLoadingRateLimit = false;
      },
      error: (err: any) => {
        this.rateLimitError = 'Failed to load rate limit settings: ' + (err?.error?.error || err?.message);
        this.isLoadingRateLimit = false;
      },
    });
  }

  saveRateLimitConfig(): void {
    this.isSavingRateLimit = true;
    this.rateLimitSaveSuccess = false;
    this.rateLimitError = '';

    this.api.post<RateLimitConfig>('/ai/rate-limits/config', this.rateLimitConfig).subscribe({
      next: (updated: RateLimitConfig) => {
        this.rateLimitConfig = { ...updated };
        this.isSavingRateLimit = false;
        this.rateLimitSaveSuccess = true;
        setTimeout(() => {
          this.rateLimitSaveSuccess = false;
        }, 4000);
      },
      error: (err: any) => {
        this.rateLimitError = 'Failed to save rate limit settings: ' + (err?.error?.error || err?.message);
        this.isSavingRateLimit = false;
      },
    });
  }

  lookupUserUsage(): void {
    if (!this.lookupUserId.trim()) return;

    this.isLookingUpUser = true;
    this.userUsage = null;
    this.userResetSuccess = '';

    this.api.get<UserRateLimitUsage>(`/ai/rate-limits/usage/${encodeURIComponent(this.lookupUserId.trim())}`).subscribe({
      next: (usage: UserRateLimitUsage) => {
        this.userUsage = usage;
        this.isLookingUpUser = false;
      },
      error: (err: any) => {
        this.rateLimitError = 'Failed to look up user usage: ' + (err?.error?.error || err?.message);
        this.isLookingUpUser = false;
      },
    });
  }

  resetUserUsage(): void {
    if (!this.lookupUserId.trim()) return;

    this.isResettingUser = true;
    this.userResetSuccess = '';

    this.api.post<{ status: string; message: string }>(`/ai/rate-limits/reset/${encodeURIComponent(this.lookupUserId.trim())}`, {}).subscribe({
      next: (res: any) => {
        this.isResettingUser = false;
        this.userResetSuccess = res?.message || `Rate limits reset for user ${this.lookupUserId}`;
        this.lookupUserUsage();
        setTimeout(() => {
          this.userResetSuccess = '';
        }, 4000);
      },
      error: (err: any) => {
        this.rateLimitError = 'Failed to reset user usage: ' + (err?.error?.error || err?.message);
        this.isResettingUser = false;
      },
    });
  }

  checkHealth(): void {
    this.isCheckingHealth = true;
    this.api.get<AiHealthInfo>('/ai/health').subscribe({
      next: (res: AiHealthInfo) => {
        this.health = res;
        this.isCheckingHealth = false;
      },
      error: (err: any) => {
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
        voice_mode: this.testVoiceMode,
        preferred_language: this.testLanguage,
      })
      .subscribe({
        next: (res: AiChatTestResult) => {
          this.lastResult = res;
          this.testStage = res.stage;
          this.isTesting = false;
        },
        error: (err: any) => {
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
