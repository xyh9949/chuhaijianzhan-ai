/** 自托管Node启动时恢复通知队列；未配置和构建阶段不会启动外发任务。 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { startNotificationWorker } = await import('./server/notification-jobs');
    startNotificationWorker();
    const {startDiscoveryWorker}=await import('./server/discovery-runtime');startDiscoveryWorker();
  }
}
