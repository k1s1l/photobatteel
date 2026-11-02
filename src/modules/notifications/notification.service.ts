import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { AdminService } from '../admins/admin.service.js';
import type { SendOptions, TelegramGateway } from '../contracts.js';
import type { UserService } from '../users/user.service.js';

/** Best-effort direct messages: failures are logged, never propagated. */
export class NotificationService {
  constructor(
    private readonly telegram: TelegramGateway,
    private readonly users: UserService,
    private readonly admins: AdminService,
    private readonly logger: Logger,
  ) {}

  async notifyUser(telegramId: number | bigint, text: string, options: SendOptions = { parseMode: 'HTML' }): Promise<boolean> {
    const chatId = Number(telegramId);
    try {
      await this.telegram.sendMessage(chatId, text, options);
      return true;
    } catch (error) {
      const classified = classifyTelegramError(error);
      if (classified.kind === 'bot_blocked') await this.users.markBotBlocked(chatId);
      else this.logger.warn({ err: error, chatId }, 'Failed to notify user');
      return false;
    }
  }

  async notifyAdmins(text: string, options: SendOptions = { parseMode: 'HTML', disablePreview: true }): Promise<void> {
    const adminIds = await this.admins.listAdminTelegramIds();
    await Promise.all(adminIds.map((id) => this.notifyUser(id, text, options)));
  }

  async notifyAdminsWithPhoto(fileId: string, caption: string, options: SendOptions): Promise<void> {
    const adminIds = await this.admins.listAdminTelegramIds();
    await Promise.all(
      adminIds.map(async (id) => {
        try {
          await this.telegram.sendPhoto(id, fileId, { ...options, caption });
        } catch (error) {
          this.logger.warn({ err: error, adminId: id }, 'Failed to send photo to admin');
        }
      }),
    );
  }
}
