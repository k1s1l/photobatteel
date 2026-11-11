import { beforeEach, describe, expect, it } from 'vitest';
import { parseReferralPayload, referralPayload } from '../../src/modules/referrals/referral.service.js';
import { createEntry, createTestContext, createUser, openBattle, postPendingDuels, startBattle, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

describe('invite friends for votes', () => {
  it('encodes the inviter in a short /start payload', () => {
    expect(referralPayload(12345)).toBe('ref_9ix');
    expect(parseReferralPayload('ref_9ix')).toBe(12345);
    expect(parseReferralPayload('duel_5')).toBeNull();
  });

  it('gives +3 votes for every 5 friends who joined through the link and voted; self-invites and repeat votes do not count', async () => {
    const battle = await openBattle(ctx);
    await createEntry(ctx, await createUser(ctx));
    await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();

    const inviter = await createUser(ctx);
    expect(await ctx.services.referrals.attach(inviter, referralPayload(inviter.id))).toBe(false);

    const friends = [];
    for (let i = 0; i < 5; i += 1) {
      const friend = await createUser(ctx);
      expect(await ctx.services.referrals.attach(friend, referralPayload(inviter.id))).toBe(true);
      friends.push(await ctx.prisma.user.findUniqueOrThrow({ where: { id: friend.id } }));
    }
    // A second link does not move a friend to another inviter.
    expect(await ctx.services.referrals.attach(friends[0]!, referralPayload((await createUser(ctx)).id))).toBe(false);

    for (const [i, friend] of friends.entries()) {
      await ctx.services.duelVotes.vote(duel.id, 0, 'A', friend);
      await ctx.services.referrals.countVote(friend.id);
      if (i === 0) {
        await ctx.services.referrals.countVote(friend.id); // the same friend votes again
        expect((await ctx.services.referrals.progress(inviter)).counted).toBe(1);
      }
    }
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: inviter.id } });
    expect(after).toMatchObject({ referralsCount: 5, referralRewards: 1, voteBalance: 3 });
    const dms = ctx.telegram.callsOf('sendMessage').filter((c) => c.chatId === Number(inviter.telegramId)).map((c) => String(c.args[0]));
    expect(dms.some((t) => t.includes('+3 голоса'))).toBe(true);
    expect(await ctx.services.referrals.progress(inviter)).toMatchObject({ counted: 5, toNext: 5, bonuses: 1 });
  });
});
