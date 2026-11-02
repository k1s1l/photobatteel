import type { Telegraf } from 'telegraf';
import { allTranslations } from '../../i18n/index.js';
import type { BotContext } from '../context.js';
import { getState, setState } from '../context.js';
import { answer } from '../helpers.js';
import { mainMenu, NOOP } from '../keyboards.js';

export async function showMainMenu(ctx: BotContext, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...mainMenu(ctx.locale, ctx.isAdmin) });
}

export function registerCommonHandlers(bot: Telegraf<BotContext>): void {
  bot.start(async (ctx) => {
    setState(ctx, undefined);
    await showMainMenu(ctx, ctx.locale.start.welcome);
  });

  bot.command('menu', async (ctx) => {
    setState(ctx, undefined);
    await showMainMenu(ctx, ctx.locale.common.useMenu);
  });

  bot.command('cancel', async (ctx) => {
    const hadState = !!getState(ctx);
    setState(ctx, undefined);
    await showMainMenu(ctx, hadState ? ctx.locale.common.cancelled : ctx.locale.common.useMenu);
  });

  const showRules = async (ctx: BotContext) => {
    const settings = await ctx.deps.services.settings.get();
    await ctx.reply(
      ctx.locale.rules.text({
        maxPerDay: settings.maxPhotosPerDay,
        maxSizeMb: ctx.deps.env.MAX_PHOTO_SIZE_MB,
        minSide: ctx.deps.env.MIN_PHOTO_DIMENSION,
        moderation: settings.moderationEnabled,
      }),
      { parse_mode: 'HTML' },
    );
  };
  bot.command('rules', showRules);
  bot.hears(allTranslations((l) => l.menu.rules), showRules);

  const showHelp = (ctx: BotContext) => ctx.reply(ctx.locale.help.text, { parse_mode: 'HTML' });
  bot.help(showHelp);
  bot.hears(allTranslations((l) => l.menu.help), showHelp);

  bot.action(NOOP, (ctx) => answer(ctx));
}

/** Last handler: anything not understood gets a hint and the menu. */
export function registerFallback(bot: Telegraf<BotContext>): void {
  bot.on('message', async (ctx) => {
    const state = getState(ctx);
    if (state?.kind === 'awaiting_photo') {
      await ctx.reply(ctx.locale.submission.notAnImage);
      return;
    }
    await showMainMenu(ctx, ctx.locale.common.useMenu);
  });
  bot.on('callback_query', (ctx) => answer(ctx, ctx.locale.common.alreadyProcessed));
}
