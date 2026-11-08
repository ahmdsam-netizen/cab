import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, MenuController, ModalController, NavController } from '@ionic/angular';
import { ApiService } from '../../core/api.service';
import { AuthService, AuthUser } from '../../core/auth.service';
import { PushService } from '../../core/push.service';
import { AiBookingAssistantModalComponent } from '../ai-booking-assistant/ai-booking-assistant.component';

@Component({
  selector: 'app-side-menu',
  templateUrl: './side-menu.component.html',
  styleUrls: ['./side-menu.component.scss'],
  standalone: false,
})
export class SideMenuComponent {
  /** Set when the avatar image URL fails to load → we show initials instead. */
  avatarBroken = false;
  private lastAvatarUrl: string | null = null;

  constructor(
    public auth: AuthService,
    private api: ApiService,
    private router: Router,
    private alertCtrl: AlertController,
    private menuCtrl: MenuController,
    private modalCtrl: ModalController,
    private navCtrl: NavController,
    private push: PushService
  ) {}

  get user(): AuthUser | null {
    const u = this.auth.getUser();
    const url = this.auth.resolveAvatarUrl(u);
    if (url !== this.lastAvatarUrl) {
      this.lastAvatarUrl = url;
      this.avatarBroken = false;
    }
    return u;
  }

  getInitial(u: AuthUser | null | undefined): string {
    const name = (u?.name || '').trim();
    if (name) {
      return name.charAt(0).toUpperCase();
    }
    return 'U';
  }

  maskedPhone(phone: string): string {
    return phone.length > 4 ? '••••••' + phone.slice(-4) : phone;
  }

  async closeMenu(): Promise<void> {
    await this.menuCtrl.close('customer-menu');
  }

  isTabActive(path: string): boolean {
    const currentPath = (this.router.url || '').split(/[?#]/)[0].replace(/\/+$/, '');
    return currentPath === path;
  }

  async signOut(): Promise<void> {
    await this.menuCtrl.close('customer-menu');
    const alert = await this.alertCtrl.create({
      header: 'Sign out?',
      message: 'You will need to sign in again to book rides.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Sign out',
          role: 'destructive',
          handler: () => this.performSignOut(),
        },
      ],
    });
    await alert.present();
  }

  private async performSignOut(): Promise<void> {
    await this.push.unregister();
    this.api.post('/me/logout', {}).subscribe({
      next: () => this.finishSignOut(),
      error: () => this.finishSignOut(),
    });
  }

  private async finishSignOut(): Promise<void> {
    await this.auth.logout();
    void this.navCtrl.navigateRoot('/welcome', { animationDirection: 'back' });
  }

  async confirmDeleteAccount(): Promise<void> {
    await this.menuCtrl.close('customer-menu');
    const alert = await this.alertCtrl.create({
      header: 'Delete account',
      message: 'You are about to delete your account. Some data will be lost forever.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Continue',
          role: 'destructive',
          handler: () => this.router.navigateByUrl('/delete-account'),
        },
      ],
    });
    await alert.present();
  }

  async go(url: string): Promise<void> {
    await this.menuCtrl.close('customer-menu');
    this.router.navigateByUrl(url);
  }

  async openAiAssistant(): Promise<void> {
    await this.menuCtrl.close('customer-menu');
    const modal = await this.modalCtrl.create({
      component: AiBookingAssistantModalComponent,
      cssClass: 'dc-ai-booking-modal',
    });
    await modal.present();
  }
}
