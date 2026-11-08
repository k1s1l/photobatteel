import type { Context } from 'telegraf';
import type { User } from '../generated/prisma/client.js';
import type { Locale } from '../i18n/index.js';
import type { LockService } from '../lib/locks.js';
import type { Logger } from '../lib/logger.js';
import type { ChannelInfo, TelegramGateway } from '../modules/contracts.js';
import type { Services } from '../services.js';
import type { Env } from '../config/env.js';
import type { StageVariant, TemplateKey } from '../modules/duels/templates.js';

export type AdminInputAction = 'delete' | 'block' | 'unblock' | 'package_price' | 'transfer_details';

/** What the bot expects from the user next. */
export type ConversationState =
  | { kind: 'awaiting_photo' }
  | { kind: 'admin_input'; action: AdminInputAction; packageId?: number }
  | { kind: 'admin_broadcast' }
  | { kind: 'admin_template'; key: TemplateKey; variant?: StageVariant }
  | { kind: 'monobank_pick'; accounts: { id: string; label: string; sendLink?: string }[] }
  | { kind: 'battle_round_end'; battleId: number }
  | { kind: 'battle_create'; step: 'start' | 'round' | 'final'; startsAt?: string; roundMinutes?: number };

export interface SessionData {
  state?: ConversationState;
}

export interface AppContextDeps {
  services: Services;
  locks: LockService;
  gateway: TelegramGateway;
  channel: ChannelInfo;
  logger: Logger;
  env: Env;
}

export interface BotContext extends Context {
  session?: SessionData;
  deps: AppContextDeps;
  /** Registered profile of the sender; set by the user middleware for every update with a sender. */
  user?: User;
  isAdmin: boolean;
  locale: Locale;
}

/** Profile of the sender. Handlers run after the user middleware, so this is always present for them. */
export function currentUser(ctx: BotContext): User {
  if (!ctx.user) throw new Error('User middleware did not run for this update');
  return ctx.user;
}

export function setState(ctx: BotContext, state: ConversationState | undefined): void {
  if (!ctx.session) return;
  if (state) ctx.session.state = state;
  else delete ctx.session.state;
}

export function getState(ctx: BotContext): ConversationState | undefined {
  return ctx.session?.state;
}
