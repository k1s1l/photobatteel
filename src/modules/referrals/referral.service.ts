import type { PrismaClient, User } from '../../generated/prisma/client.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { NotificationService } from '../notifications/notification.service.js';

/** Friends a user has to bring for one bonus, and the votes the bonus gives. */
export const FRIENDS_PER_BONUS = 5;
export const BONUS_VOTES = 3;

const PAYLOAD_PREFIX = 'ref_';

/** "ref_k3" — the inviter's id in base 36 (short enough for a /start payload). */
export function referralPayload(userId: number): string {
  return `${PAYLOAD_PREFIX}${userId.toString(36)}`;
}

export function parseReferralPayload(payload: string | undefined): number | null {
  if (!payload?.startsWith(PAYLOAD_PREFIX)) return null;
  const id = Number.parseInt(payload.slice(PAYLOAD_PREFIX.length), 36);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface ReferralProgress {
  link: string;
  counted: number;
  /** Friends still needed for the next bonus. */
  toNext: number;
  bonuses: number;
}

/**
 * "Invite 5 friends — get 3 votes". A friend is someone who opened the bot for
 * the first time through the inviter's link; they count once they vote in the
 * channel (only subscribers can), so fake accounts do not help.
 */
export class ReferralService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly botUsername: string,
  ) {}

  link(userId: number): string {
    return `https://t.me/${this.botUsername}?start=${referralPayload(userId)}`;
  }

  async progress(user: User): Promise<ReferralProgress> {
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return {
      link: this.link(user.id),
      counted: fresh.referralsCount,
      toNext: FRIENDS_PER_BONUS - (fresh.referralsCount % FRIENDS_PER_BONUS),
      bonuses: fresh.referralRewards,
    };
  }

  /** A new user came through someone's link. Only the very first contact counts; nobody can invite themselves. */
  async attach(newUser: User, payload: string | undefined): Promise<boolean> {
    const inviterId = parseReferralPayload(payload);
    if (!inviterId || inviterId === newUser.id || newUser.referredById !== null) return false;
    const inviter = await this.prisma.user.findUnique({ where: { id: inviterId } });
    if (!inviter || inviter.isBlocked) return false;
    const updated = await this.prisma.user.updateMany({ where: { id: newUser.id, referredById: null }, data: { referredById: inviterId } });
    return updated.count > 0;
  }

  /**
   * Called after a free vote in the channel: the voter's inviter gets the friend
   * counted (once), and +3 votes for every 5 friends.
   */
  async countVote(voterId: number): Promise<void> {
    const result = await this.prisma.$transaction(async (tx) => {
      const voter = await tx.user.findUnique({ where: { id: voterId } });
      if (!voter?.referredById || voter.referralCountedAt) return null;
      const marked = await tx.user.updateMany({ where: { id: voterId, referralCountedAt: null }, data: { referralCountedAt: new Date() } });
      if (marked.count === 0) return null;
      const inviter = await tx.user.update({ where: { id: voter.referredById }, data: { referralsCount: { increment: 1 } } });
      const due = Math.floor(inviter.referralsCount / FRIENDS_PER_BONUS) - inviter.referralRewards;
      if (due <= 0) return { inviter, rewarded: 0 };
      const rewarded = await tx.user.update({
        where: { id: inviter.id },
        data: { voteBalance: { increment: due * BONUS_VOTES }, referralRewards: { increment: due } },
      });
      await this.activity.log({ action: 'SETTINGS_UPDATED', userId: inviter.id, entityType: 'User', entityId: inviter.id, details: { referralBonus: due * BONUS_VOTES } }, tx);
      return { inviter: rewarded, rewarded: due * BONUS_VOTES };
    });
    if (!result) return;
    const { inviter, rewarded } = result;
    if (rewarded > 0) {
      await this.notifications.notifyUser(inviter, (l) => l.referrals.rewarded({ votes: rewarded, balance: inviter.voteBalance }));
    } else {
      await this.notifications.notifyUser(inviter, (l) => l.referrals.friendCounted({ counted: inviter.referralsCount % FRIENDS_PER_BONUS, need: FRIENDS_PER_BONUS }));
    }
  }
}
