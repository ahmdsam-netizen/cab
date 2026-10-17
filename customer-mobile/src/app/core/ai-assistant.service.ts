import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { ApiService } from './api.service';

export interface DepartureOption {
  id: number;
  route_id?: number;
  driver_id?: number;
  driver_name?: string | null;
  driver_phone?: string | null;
  vehicle_name?: string | null;
  vehicle_reg_no?: string | null;
  capacity?: number;
  seats_taken?: number;
  available_seats?: number;
  price_per_seat?: number;
  boarding_opened_at?: string | null;
  announced_depart_at?: string | null;
  status?: string;
}

export interface MatchedRoute {
  id: number;
  name: string;
  board_stop: { id: number; name: string; seq?: number };
  drop_stop: { id: number; name: string; seq?: number };
  price_per_seat?: number;
}

export interface AiChatResponse {
  reply: string;
  stage:
    | 'COLLECTING'
    | 'CONFIRMING_DEPARTURE'
    | 'AWAITING_DRIVER'
    | 'ACCEPTED_PAYMENT'
    | 'EXHAUSTED'
    | 'ERROR'
    | 'SERVICE_UNAVAILABLE'
    | string;
  thread_id: string;
  options?: DepartureOption[];
  matched_route?: MatchedRoute;
  available_seats?: string[];
  selected_seats?: string[];
  luggage?: {
    has_extra_luggage: boolean;
    extra_luggage_count: number;
  };
  seat_hold_id?: number;
  payment_order?: any;
  error?: string;
}

export interface AiChatRequest {
  message: string;
  thread_id?: string;
  user_current_lat?: number;
  user_current_lng?: number;
  action?: string;
  selected_departure_id?: number;
  has_extra_luggage?: boolean;
  extra_luggage_count?: number;
  selected_seat_labels?: string[];
}

@Injectable({
  providedIn: 'root',
})
export class AiAssistantService {
  private recognition: any = null;
  private isListening = false;
  private speechResult$ = new Subject<string>();
  private speechState$ = new Subject<boolean>();

  constructor(
    private api: ApiService,
    private zone: NgZone
  ) {
    this.initSpeechRecognition();
  }

  /**
   * Send a conversational query to the backend AI agent endpoint.
   */
  chat(request: AiChatRequest): Observable<AiChatResponse> {
    return this.api.post<AiChatResponse>('/ai/chat', request);
  }

  /**
   * Check if the Agentic AI service is reachable and healthy.
   */
  checkHealth(): Observable<{ online: boolean; status: string; service_response?: any }> {
    return this.api.get<{ online: boolean; status: string; service_response?: any }>('/ai/health');
  }

  /**
   * Initializes browser speech recognition if supported on device.
   */
  private initSpeechRecognition(): void {
    if (typeof window === 'undefined') return;

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) return;

    try {
      this.recognition = new SpeechRec();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-IN';

      this.recognition.onstart = () => {
        this.zone.run(() => {
          this.isListening = true;
          this.speechState$.next(true);
        });
      };

      this.recognition.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) {
          this.zone.run(() => {
            this.speechResult$.next(transcript);
          });
        }
      };

      this.recognition.onerror = () => {
        this.zone.run(() => {
          this.isListening = false;
          this.speechState$.next(false);
        });
      };

      this.recognition.onend = () => {
        this.zone.run(() => {
          this.isListening = false;
          this.speechState$.next(false);
        });
      };
    } catch {
      this.recognition = null;
    }
  }

  /**
   * Whether voice recognition is supported by current browser environment.
   */
  get isVoiceSupported(): boolean {
    return !!this.recognition;
  }

  /**
   * Observable emitting recognized speech transcripts.
   */
  onSpeechResult(): Observable<string> {
    return this.speechResult$.asObservable();
  }

  /**
   * Observable emitting listening state changes.
   */
  onListeningState(): Observable<boolean> {
    return this.speechState$.asObservable();
  }

  /**
   * Start microphone listening.
   */
  startListening(): boolean {
    if (!this.recognition) return false;
    try {
      if (this.isListening) {
        this.recognition.stop();
      }
      this.recognition.start();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop microphone listening.
   */
  stopListening(): void {
    if (!this.recognition) return;
    try {
      this.recognition.stop();
    } catch {
      /* ignore */
    }
  }
}
