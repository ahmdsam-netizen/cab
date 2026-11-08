import { Component, Input, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { ModalController, ToastController } from '@ionic/angular';
import { Router } from '@angular/router';
import { interval, Subscription } from 'rxjs';
import {
  AiAssistantService,
  AiChatResponse,
  DepartureOption,
  MatchedRoute,
} from '../../core/ai-assistant.service';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { AuthService } from '../../core/auth.service';
import { AudioAlertService } from '../../core/audio-alert.service';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  time: string;
  stage?: string;
  matchedRoute?: MatchedRoute;
  options?: DepartureOption[];
  selectedDeparture?: DepartureOption;
  availableSeats?: string[];
  selectedSeats?: string[];
  luggage?: { has_extra_luggage: boolean; extra_luggage_count: number };
  seatHoldId?: number;
  paymentOrder?: any;
}

@Component({
  selector: 'app-ai-booking-assistant',
  templateUrl: './ai-booking-assistant.component.html',
  styleUrls: ['./ai-booking-assistant.component.scss'],
  standalone: false,
})
export class AiBookingAssistantModalComponent implements OnInit, OnDestroy {
  @Input() initialQuery?: string;
  @Input() userLat?: number;
  @Input() userLng?: number;

  @ViewChild('chatScroll', { static: false }) private chatScroll?: ElementRef<HTMLDivElement>;

  messages: ChatMessage[] = [];
  inputText = '';
  isLoading = false;
  isListening = false;
  isOnline = true;
  voiceModeEnabled = false;
  isSpeaking = false;
  threadId: string = 'session_' + Date.now();

  selectedDepartureId?: number;
  selectedDeparture?: DepartureOption;
  selectedSeats: string[] = [];
  seatsRequested = 1;
  hasExtraLuggage = false;
  extraLuggageCount = 0;
  luggageExplicitlySet = false;
  seatHoldId?: number;

  private currentAudio: HTMLAudioElement | null = null;
  private holdPollSub?: Subscription;
  private unsubscribeHoldRealtime?: () => void;
  private unsubscribeCustomerRealtime?: () => void;
  private subs = new Subscription();

  quickPrompts = [
    'Ride to Sopore',
    'From Lal Chowk to Baramulla',
    'Book next departure',
    'With 1 extra bag',
  ];

  constructor(
    private modalCtrl: ModalController,
    private aiService: AiAssistantService,
    private toastCtrl: ToastController,
    private router: Router,
    private api: ApiService,
    private realtime: RealtimeService,
    private auth: AuthService,
    private audioAlert: AudioAlertService,
  ) {}

  ngOnInit(): void {
    // Generate or read persistent thread ID for this customer session
    const savedThread = sessionStorage.getItem('dc_ai_thread_id');
    if (savedThread) {
      this.threadId = savedThread;
    } else {
      this.threadId = 'thread_' + Math.random().toString(36).substring(2, 10);
      try {
        sessionStorage.setItem('dc_ai_thread_id', this.threadId);
      } catch {
        /* ignore */
      }
    }

    // Subscribe to speech recognition
    this.subs.add(
      this.aiService.onSpeechResult().subscribe((transcript) => {
        if (transcript) {
          this.inputText = transcript;
          this.sendMessage(undefined, undefined, true);
        }
      })
    );

    this.subs.add(
      this.aiService.onListeningState().subscribe((listening) => {
        this.isListening = listening;
      })
    );

    // Initial check of AI service health
    this.aiService.checkHealth().subscribe({
      next: (h) => {
        this.isOnline = h.online;
      },
      error: () => {
        this.isOnline = false;
      },
    });

    // Add initial greeting message
    this.messages.push({
      id: 'msg_welcome',
      sender: 'assistant',
      text: 'Hello! I am your DreamCabs AI ride assistant. Where would you like to travel today?',
      time: this.currentTimeString(),
    });

    if (this.initialQuery) {
      this.inputText = this.initialQuery;
      this.sendMessage();
    }
  }

  ngOnDestroy(): void {
    this.stopAudioPlayback();
    this.stopDriverApprovalTracking();
    this.subs.unsubscribe();
    this.aiService.stopListening();
  }

  get isVoiceSupported(): boolean {
    return this.aiService.isVoiceSupported;
  }

  close(): void {
    this.stopAudioPlayback();
    void this.modalCtrl.dismiss();
  }

  resetConversation(): void {
    this.stopAudioPlayback();
    this.threadId = 'thread_' + Math.random().toString(36).substring(2, 10);
    try {
      sessionStorage.setItem('dc_ai_thread_id', this.threadId);
    } catch {
      /* ignore */
    }
    this.messages = [
      {
        id: 'msg_reset_' + Date.now(),
        sender: 'assistant',
        text: 'Conversation reset. Where would you like to go?',
        time: this.currentTimeString(),
      },
    ];
    this.selectedDepartureId = undefined;
    this.selectedSeats = [];
    this.luggageExplicitlySet = false;
    this.hasExtraLuggage = false;
    this.extraLuggageCount = 0;
  }

  toggleVoiceMode(): void {
    this.voiceModeEnabled = !this.voiceModeEnabled;
    if (!this.voiceModeEnabled) {
      this.stopAudioPlayback();
    }
  }

  playAudioBase64(base64: string): void {
    try {
      this.stopAudioPlayback();
      this.currentAudio = new Audio('data:audio/mp3;base64,' + base64);
      this.isSpeaking = true;
      this.currentAudio.onended = () => {
        this.isSpeaking = false;
        this.currentAudio = null;
      };
      this.currentAudio.onerror = () => {
        this.isSpeaking = false;
        this.currentAudio = null;
      };
      void this.currentAudio.play().catch(() => {
        this.isSpeaking = false;
      });
    } catch {
      this.isSpeaking = false;
    }
  }

  stopAudioPlayback(): void {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch {}
      this.currentAudio = null;
    }
    this.isSpeaking = false;
  }

  sendQuickPrompt(promptText: string): void {
    this.inputText = promptText;
    this.sendMessage();
  }

  toggleVoice(): void {
    if (this.isListening) {
      this.aiService.stopListening();
    } else {
      this.voiceModeEnabled = true;
      const ok = this.aiService.startListening();
      if (!ok) {
        this.showToast('Voice input is not supported in this browser.');
      }
    }
  }

  sendMessage(explicitTextOrAction?: string, explicitAction?: string, wasVoiceTriggered: boolean = false): void {
    let action = explicitAction;
    let text = (this.inputText || '').trim();

    if (explicitTextOrAction && !explicitAction) {
      if (explicitTextOrAction === 'confirm') {
        action = 'confirm';
        text = '';
      } else {
        text = explicitTextOrAction;
      }
    } else if (explicitTextOrAction && explicitAction) {
      text = explicitTextOrAction;
      action = explicitAction;
    }

    if (!text && !action) return;

    const userMsgText = text || (action === 'confirm' ? 'Confirm booking' : action || 'Select');
    this.inputText = '';

    // If starting a new route search, reset previously stored luggage & departure state
    const lower = userMsgText.toLowerCase();
    const isNewRoute = (lower.includes('to ') || lower.includes('from ') || lower.includes('wanna go') || lower.includes('ride')) && action !== 'luggage' && action !== 'confirm';
    if (isNewRoute) {
      this.selectedDepartureId = undefined;
      this.selectedSeats = [];
      this.seatsRequested = 1;
      this.luggageExplicitlySet = false;
      this.hasExtraLuggage = false;
      this.extraLuggageCount = 0;
    }

    // Append user message
    this.messages.push({
      id: 'msg_user_' + Date.now(),
      sender: 'user',
      text: userMsgText,
      time: this.currentTimeString(),
    });
    this.scrollToBottom();

    this.isLoading = true;

    const sendVoice = this.voiceModeEnabled || wasVoiceTriggered;

    this.aiService
      .chat({
        message: userMsgText,
        thread_id: this.threadId,
        user_current_lat: this.userLat,
        user_current_lng: this.userLng,
        action: action,
        selected_departure_id: this.selectedDepartureId,
        selected_seat_labels: this.selectedSeats.length ? this.selectedSeats : undefined,
        seats_requested: this.seatsRequested > 1 ? this.seatsRequested : undefined,
        has_extra_luggage: this.luggageExplicitlySet ? this.hasExtraLuggage : undefined,
        extra_luggage_count: this.luggageExplicitlySet ? this.extraLuggageCount : undefined,
        voice_mode: sendVoice,
      })
      .subscribe({
        next: (res: AiChatResponse) => {
          this.isLoading = false;
          this.handleAiResponse(res, sendVoice);
        },
        error: (err) => {
          this.isLoading = false;
          this.messages.push({
            id: 'msg_err_' + Date.now(),
            sender: 'assistant',
            text:
              err?.error?.error ||
              'Sorry, I could not complete that request. Please check your connection or choose manually.',
            time: this.currentTimeString(),
            stage: 'ERROR',
          });
          this.scrollToBottom();
        },
      });
  }

  selectDeparture(dep: DepartureOption): void {
    this.selectedDepartureId = dep.id;
    this.sendMessage(`Choose vehicle departing at ${dep.announced_depart_at || 'scheduled time'}`);
  }

  onRideBoxClick(dep: DepartureOption): void {
    const time = this.formatDepartTime(dep.announced_depart_at || dep.depart_at);
    this.selectedDepartureId = dep.id;
    this.inputText = `Ride departing at ${time}`;
  }

  onSeatTagClick(seat: string): void {
    const cleanSeat = seat.split(' ')[0];
    if (this.seatsRequested > 1) {
      const idx = this.selectedSeats.indexOf(cleanSeat);
      if (idx > -1) {
        this.selectedSeats.splice(idx, 1);
      } else {
        if (this.selectedSeats.length >= this.seatsRequested) {
          this.selectedSeats.shift();
        }
        this.selectedSeats.push(cleanSeat);
      }
      if (this.selectedSeats.length === 1) {
        this.inputText = `Book seat ${this.selectedSeats[0]}`;
      } else if (this.selectedSeats.length > 1) {
        this.inputText = `Book seats ${this.selectedSeats.join(' and ')}`;
      } else {
        this.inputText = '';
      }
    } else {
      this.selectedSeats = [cleanSeat];
      this.inputText = `Book seat ${cleanSeat}`;
    }
  }

  isSeatSelected(seat: string): boolean {
    const clean = seat.split(' ')[0];
    return this.selectedSeats.includes(clean);
  }

  toggleSeat(seat: string): void {
    const idx = this.selectedSeats.indexOf(seat);
    if (idx > -1) {
      this.selectedSeats.splice(idx, 1);
    } else {
      this.selectedSeats = [seat]; // pick 1 seat by default
    }
    this.sendMessage(`Book seat ${seat}`);
  }

  setLuggage(hasLuggage: boolean, count: number): void {
    this.luggageExplicitlySet = true;
    this.hasExtraLuggage = hasLuggage;
    this.extraLuggageCount = count;
    this.sendMessage(hasLuggage ? `I have ${count} extra bag(s)` : 'No extra luggage', 'luggage');
  }

  confirmBooking(): void {
    this.sendMessage('confirm');
  }

  async openPayment(paymentOrder: any, seatHoldId?: number): Promise<void> {
    const targetHoldId = seatHoldId || this.seatHoldId;
    this.stopDriverApprovalTracking();
    await this.modalCtrl.dismiss({ booked: true, holdId: targetHoldId });
    await this.router.navigate(['/customer-tabs/book/fixed'], {
      queryParams: targetHoldId ? { hold_id: targetHoldId } : undefined,
    });
  }

  cancelHold(): void {
    this.stopDriverApprovalTracking();
    this.sendMessage('cancel');
  }

  onSwitchRideClick(): void {
    this.stopDriverApprovalTracking();
    this.selectedDepartureId = undefined;
    this.selectedDeparture = undefined;
    this.selectedSeats = [];
    this.sendMessage('show other rides');
  }

  private startDriverApprovalTracking(holdId: number): void {
    this.stopDriverApprovalTracking();

    // 1. WebSocket Realtime subscription
    try {
      this.unsubscribeHoldRealtime = this.realtime.subscribeFixedHold(
        holdId,
        (payload) => this.onDriverAccepted(payload),
        (payload) => this.onDriverRejected(payload),
      );

      const user = this.auth.getUser();
      if (user?.id) {
        this.unsubscribeCustomerRealtime = this.realtime.subscribeCustomerFixedHoldEvents(
          user.id,
          (payload) => {
            if (payload.hold_id === holdId) {
              this.onDriverAccepted(payload);
            }
          },
          (payload) => {
            if (payload.hold_id === holdId) {
              this.onDriverRejected(payload);
            }
          },
        );
      }
    } catch {
      /* ignore realtime init error if websocket unavailable */
    }

    // 2. HTTP Polling fallback every 2.5s
    this.holdPollSub = interval(2500).subscribe(() => {
      this.api.get<{ hold: any }>(`/fixed/seat-holds/${holdId}`).subscribe({
        next: (res) => {
          const h = res?.hold;
          if (!h) return;
          if (h.status === 'ACCEPTED') {
            this.onDriverAccepted(h);
          } else if (h.status === 'REJECTED') {
            this.onDriverRejected(h);
          }
        },
        error: () => {},
      });
    });
  }

  private stopDriverApprovalTracking(): void {
    this.holdPollSub?.unsubscribe();
    this.holdPollSub = undefined;
    if (this.unsubscribeHoldRealtime) {
      this.unsubscribeHoldRealtime();
      this.unsubscribeHoldRealtime = undefined;
    }
    if (this.unsubscribeCustomerRealtime) {
      this.unsubscribeCustomerRealtime();
      this.unsubscribeCustomerRealtime = undefined;
    }
  }

  private onDriverAccepted(payload: any): void {
    this.stopDriverApprovalTracking();
    try {
      this.audioAlert.playDriverAccepted();
    } catch {}

    const driverName = this.selectedDeparture?.driver_name || payload?.driver_name || 'Assigned Driver';
    const vehName = this.selectedDeparture?.vehicle_name || payload?.vehicle_name || 'Vehicle';
    const seats = this.selectedSeats.length ? ` (Seat ${this.selectedSeats.join(', ')})` : '';

    this.messages.push({
      id: 'msg_ai_' + Date.now(),
      sender: 'assistant',
      text: `Driver **${driverName}** on **${vehName}** has accepted your booking request${seats}.\n\nPlease complete payment to confirm your seats and secure your ticket.`,
      time: this.currentTimeString(),
      stage: 'ACCEPTED_PAYMENT',
      seatHoldId: this.seatHoldId,
      selectedDeparture: this.selectedDeparture,
      selectedSeats: this.selectedSeats,
      paymentOrder: payload?.payment_order || payload?.order || null,
    });
    this.scrollToBottom();
  }

  private onDriverRejected(payload: any): void {
    this.stopDriverApprovalTracking();
    try {
      this.audioAlert.playDriverDeclined();
    } catch {}

    this.messages.push({
      id: 'msg_ai_' + Date.now(),
      sender: 'assistant',
      text: `The driver was unable to accept your request at this time. Here are the remaining available rides on this route.`,
      time: this.currentTimeString(),
      stage: 'CONFIRMING_DEPARTURE',
      selectedDeparture: undefined,
    });
    this.selectedDepartureId = undefined;
    this.selectedDeparture = undefined;
    this.seatHoldId = undefined;
    this.selectedSeats = [];
    this.scrollToBottom();
  }

  private handleAiResponse(res: AiChatResponse, playAudio: boolean = false): void {
    this.messages.push({
      id: 'msg_ai_' + Date.now(),
      sender: 'assistant',
      text: res.reply,
      time: this.currentTimeString(),
      stage: res.stage,
      matchedRoute: res.matched_route,
      options: res.options,
      selectedDeparture: res.selected_departure,
      availableSeats: res.available_seats,
      selectedSeats: res.selected_seats,
      luggage: res.luggage,
      seatHoldId: res.seat_hold_id,
      paymentOrder: res.payment_order,
    });

    if (playAudio && res.audio_base64) {
      this.playAudioBase64(res.audio_base64);
    }

    if (res.seat_hold_id) {
      this.seatHoldId = res.seat_hold_id;
    }

    if (res.stage === 'AWAITING_DRIVER' && res.seat_hold_id) {
      this.startDriverApprovalTracking(res.seat_hold_id);
    } else if (res.stage !== 'AWAITING_DRIVER') {
      this.stopDriverApprovalTracking();
    }

    if (res.selected_departure) {
      this.selectedDeparture = res.selected_departure;
      if (res.selected_departure.id) {
        this.selectedDepartureId = res.selected_departure.id;
      }
    } else if (res.stage === 'CONFIRMING_DEPARTURE' && (!res.available_seats || !res.available_seats.length)) {
      this.selectedDeparture = undefined;
      this.selectedDepartureId = undefined;
    }

    if (res.selected_seats && res.selected_seats.length) {
      this.selectedSeats = res.selected_seats;
    }
    if (res.seats_requested) {
      this.seatsRequested = res.seats_requested;
    }
    if (res.luggage && res.stage !== 'COLLECTING') {
      this.luggageExplicitlySet = true;
      this.hasExtraLuggage = res.luggage.has_extra_luggage;
      this.extraLuggageCount = res.luggage.extra_luggage_count;
    }

    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.chatScroll?.nativeElement) {
        this.chatScroll.nativeElement.scrollTop = this.chatScroll.nativeElement.scrollHeight;
      }
    }, 100);
  }

  formatMessage(text: string): string {
    if (!text) return '';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br/>');
  }

  formatDepartTime(val?: string | null): string {
    if (!val) return 'Ready to board';
    const s = String(val).trim();
    if (!s || s.toLowerCase() === 'none') return 'Ready to board';
    if (s.includes('T')) {
      try {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
      } catch {
        /* fallback */
      }
    }
    return s;
  }

  private currentTimeString(): string {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private async showToast(message: string): Promise<void> {
    const t = await this.toastCtrl.create({
      message,
      duration: 3000,
      position: 'bottom',
    });
    await t.present();
  }
}
