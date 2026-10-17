import { Component, Input, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { ModalController, ToastController } from '@ionic/angular';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  AiAssistantService,
  AiChatResponse,
  DepartureOption,
  MatchedRoute,
} from '../../core/ai-assistant.service';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  time: string;
  stage?: string;
  matchedRoute?: MatchedRoute;
  options?: DepartureOption[];
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
  threadId: string = 'session_' + Date.now();

  selectedDepartureId?: number;
  selectedSeats: string[] = [];
  hasExtraLuggage = false;
  extraLuggageCount = 0;

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
    private router: Router
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
          this.sendMessage();
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
    this.subs.unsubscribe();
    this.aiService.stopListening();
  }

  get isVoiceSupported(): boolean {
    return this.aiService.isVoiceSupported;
  }

  close(): void {
    void this.modalCtrl.dismiss();
  }

  resetConversation(): void {
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
  }

  sendQuickPrompt(promptText: string): void {
    this.inputText = promptText;
    this.sendMessage();
  }

  toggleVoice(): void {
    if (this.isListening) {
      this.aiService.stopListening();
    } else {
      const ok = this.aiService.startListening();
      if (!ok) {
        this.showToast('Voice input is not supported in this browser.');
      }
    }
  }

  sendMessage(action?: string): void {
    const text = this.inputText.trim();
    if (!text && !action) return;

    const userMsgText = text || (action === 'confirm' ? 'Confirm booking' : action || 'Select');
    this.inputText = '';

    // Append user message
    this.messages.push({
      id: 'msg_user_' + Date.now(),
      sender: 'user',
      text: userMsgText,
      time: this.currentTimeString(),
    });
    this.scrollToBottom();

    this.isLoading = true;

    this.aiService
      .chat({
        message: userMsgText,
        thread_id: this.threadId,
        user_current_lat: this.userLat,
        user_current_lng: this.userLng,
        action: action,
        selected_departure_id: this.selectedDepartureId,
        selected_seat_labels: this.selectedSeats.length ? this.selectedSeats : undefined,
        has_extra_luggage: this.hasExtraLuggage,
        extra_luggage_count: this.extraLuggageCount,
      })
      .subscribe({
        next: (res: AiChatResponse) => {
          this.isLoading = false;
          this.handleAiResponse(res);
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
    this.hasExtraLuggage = hasLuggage;
    this.extraLuggageCount = count;
    this.sendMessage(hasLuggage ? `I have ${count} extra bag(s)` : 'No extra luggage');
  }

  confirmBooking(): void {
    this.sendMessage('confirm');
  }

  openPayment(paymentOrder: any, seatHoldId?: number): void {
    void this.modalCtrl.dismiss({ booked: true, holdId: seatHoldId });
    if (seatHoldId) {
      void this.router.navigate(['/customer-tabs/fixed-rides', seatHoldId]);
    } else {
      void this.router.navigate(['/customer-tabs/go']);
    }
  }

  private handleAiResponse(res: AiChatResponse): void {
    this.messages.push({
      id: 'msg_ai_' + Date.now(),
      sender: 'assistant',
      text: res.reply,
      time: this.currentTimeString(),
      stage: res.stage,
      matchedRoute: res.matched_route,
      options: res.options,
      availableSeats: res.available_seats,
      selectedSeats: res.selected_seats,
      luggage: res.luggage,
      seatHoldId: res.seat_hold_id,
      paymentOrder: res.payment_order,
    });

    if (res.selected_seats && res.selected_seats.length) {
      this.selectedSeats = res.selected_seats;
    }
    if (res.luggage) {
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
