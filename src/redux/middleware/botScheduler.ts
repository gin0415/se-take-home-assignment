import { Middleware } from '@reduxjs/toolkit';
import { botAction } from '../actions/botAction';
import { orderAction } from '../actions/orderAction';
import { BOT_STATUS } from '../constants/botConstant';
import { ORDER_STATUS, ORDER_TYPE, PROCESS_DURATION_MS } from '../constants/orderConstant';
import type { Bot } from '../reducers/botReducer';
import type { RootState } from '../reducers/reducer';

const timers = new Map<number, ReturnType<typeof setTimeout>>();
let isReconciling = false;

const pickBotToRemove = (state: RootState): Bot | null => {
    const bots = state.bot.bots;
    if (bots.length === 0) return null;

    const orderTypeFor = (bot: Bot) => {
        if (bot.orderId === null) return null;
        return state.order.orders.find((o) => o.id === bot.orderId)?.type ?? null;
    };

    const tierOf = (bot: Bot): 0 | 1 | 2 => {
        if (bot.status === BOT_STATUS.IDLE || bot.orderId === null) return 0;
        return orderTypeFor(bot) === ORDER_TYPE.VIP ? 2 : 1;
    };

    let target = bots[0];
    let targetTier = tierOf(target);
    for (let i = 1; i < bots.length; i++) {
        const bot = bots[i];
        const tier = tierOf(bot);
        // Lower tier wins; equal tier prefers the newer (later) bot.
        if (tier < targetTier || tier === targetTier) {
            target = bot;
            targetTier = tier;
        }
    }
    return target;
};

export const botScheduler: Middleware<{}, RootState> = (store) => (next) => (action: any) => {
    if (botAction.removeBot.match(action)) {
        const prevState = store.getState();
        const target = action.payload?.botId
            ? prevState.bot.bots.find((b) => b.id === action.payload!.botId) ?? null
            : pickBotToRemove(prevState);
        if (target) {
            const timer = timers.get(target.id);
            if (timer) {
                clearTimeout(timer);
                timers.delete(target.id);
            }
            if (target.orderId !== null) {
                store.dispatch(
                    orderAction.returnOrderToPending({ orderId: target.orderId }),
                );
            }
            if (!action.payload?.botId) {
                // Replace the untargeted action with one that names the chosen bot,
                // so the reducer removes that specific bot instead of just popping.
                action = botAction.removeBot({ botId: target.id });
            }
        }
    }

    const result = next(action);

    if (isReconciling) return result;
    isReconciling = true; // basically a lock
    try {
        const state = store.getState();
        const idleBots = state.bot.bots.filter((b) => b.status === BOT_STATUS.IDLE);
        const pendingOrders = state.order.orders.filter(
            (o) => o.status === ORDER_STATUS.PENDING,
        );
        const matches = Math.min(idleBots.length, pendingOrders.length);
        for (let i = 0; i < matches; i++) {
            const bot = idleBots[i];
            const order = pendingOrders[i];
            store.dispatch(botAction.setBotBusy({ botId: bot.id, orderId: order.id }));
            store.dispatch(orderAction.assignOrder({ orderId: order.id, botId: bot.id }));
            const timer = setTimeout(() => {
                store.dispatch(orderAction.completeOrder({ orderId: order.id }));
                store.dispatch(botAction.setBotIdle({ botId: bot.id }));
                timers.delete(bot.id);
            }, PROCESS_DURATION_MS);
            timers.set(bot.id, timer);
        }
    } finally {
        isReconciling = false;
    }

    return result;
};
