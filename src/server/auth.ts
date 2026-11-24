import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { getDatabase } from "./database";
import { getAuthEnvironment } from "./env";
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { assertRecoveryToken, deliverRecoveryToken, RECOVERY_LIFETIME_SECONDS, type RecoveryContext, type RecoveryDelivery } from './account-recovery-core';

/** 注入投递函数只供本机CLI和隔离测试代码使用，HTTP或环境参数不能开启本机捕获。 */
export function createRecoveryAuth(options: { delivery?: RecoveryDelivery } = {}) {
  const env = getAuthEnvironment();
  const db = getDatabase();
  let context: () => Promise<RecoveryContext> = async () => { throw new Error('认证上下文尚未初始化'); };
  const assertReset = async (token: unknown, adapter: RecoveryContext['internalAdapter'], nativeRequired = true) => {
    try { await assertRecoveryToken(db, adapter, token, nativeRequired); } catch { throw new APIError('BAD_REQUEST', { message: '恢复链接无效或已过期，请重新申请', code: 'INVALID_TOKEN' }); }
  };
  const auth = betterAuth({
    appName: "Form Studio",
    baseURL: env.baseURL,
    secret: env.secret,
    // 认证库可能把端点上下文带入异常；只记录固定类别，不让恢复链接或账号进入日志。
    logger: { log: level => { if (level === 'error') console.error('Authentication operation failed'); } },
    database: db,
    trustedOrigins: [env.baseURL],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: false, revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: RECOVERY_LIFETIME_SECONDS,
      sendResetPassword: async data => { const ctx = await context(); await deliverRecoveryToken(db, ctx.internalAdapter, data, options.delivery); },
    },
    // 重置入口与实际账号写入前都检查当前状态；原生库负责token单次消费、会话撤销和密码哈希。
    hooks: { before: createAuthMiddleware(async ctx => { if (ctx.path === '/reset-password') await assertReset(ctx.body?.token ?? ctx.query?.token, ctx.context.internalAdapter); }) },
    databaseHooks: { account: {
      update: { before: async (account, ctx) => { if (ctx?.path === '/reset-password') await assertReset(ctx.body?.token ?? ctx.query?.token, ctx.context.internalAdapter, false); return { data: account }; } },
      create: { before: async (account, ctx) => { if (ctx?.path === '/reset-password') await assertReset(ctx.body?.token ?? ctx.query?.token, ctx.context.internalAdapter, false); return { data: account }; } },
    } },
    user: { modelName: "auth_user", deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    session: { modelName: "auth_session", expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: env.secureCookies },
    rateLimit: { enabled: true, window: 60, max: 100, customRules: { "/sign-in/email": { window: 60, max: 10 } } },
    plugins: [admin({ defaultRole: "viewer", roles: { admin: adminAc, editor: userAc, viewer: userAc } })],
  });
  context = () => auth.$context;
  return auth;
}

let instance: ReturnType<typeof createRecoveryAuth> | undefined;
/** 构建和 CLI 都可以导入模块；仅实际使用认证时连接已配置的数据库。 */
export function getAuth() { return instance ??= createRecoveryAuth(); }
