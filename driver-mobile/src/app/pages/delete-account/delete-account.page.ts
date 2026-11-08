import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-delete-account',
  templateUrl: './delete-account.page.html',
  styleUrls: ['./delete-account.page.scss'],
  standalone: false,
})
export class DeleteAccountPage {
  loading = false;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private router: Router,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {}

  goBack(): void {
    this.router.navigateByUrl('/tabs/more');
  }

  async confirmDelete(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Delete account?',
      message:
        'This permanently deletes your Cabbies account, including BOTH customer and driver profiles if they share this account, uploaded verification documents and account access on all devices. Independent accounting records may be retained. Deletion does not settle outstanding payments or request a ride refund. Continue?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete account',
          role: 'destructive',
          handler: () => {
            this.performDelete();
          },
        },
      ],
    });
    await alert.present();
  }

  private async performDelete(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.api.delete('/me/account', { role: 'driver', scope: 'all' }).subscribe({
      next: async () => {
        await this.auth.logout();
        const t = await this.toastCtrl.create({
          message: 'Your account has been deleted.',
          duration: 2500,
          color: 'medium',
        });
        await t.present();
        this.router.navigateByUrl('/auth/login', { replaceUrl: true });
      },
      error: async (err) => {
        this.loading = false;
        const msg =
          err?.error?.message ?? err?.message ?? 'Could not delete the account. Please try again.';
        const t = await this.toastCtrl.create({ message: msg, duration: 3000, color: 'danger' });
        await t.present();
      },
    });
  }
}
