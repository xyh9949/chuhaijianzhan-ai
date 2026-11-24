import type { useStudioRuntime } from './studio-client';
import { RequestError } from './studio-client';
/** 只在队列已保存时重读，不能用accept绕过版本约束或悄悄丢弃待保存画布；冲突沿用顶部导出/重载流程。 */
export async function readFreshStudio(runtime:ReturnType<typeof useStudioRuntime>){
 if(runtime.getSaveState()!=='saved')throw new RequestError(409,'工作区同步未完成。请先在顶部导出需保留的草稿，再选择“重新加载”；本弹层输入仍保留。');
 await runtime.refresh();return runtime.getEnvelope();
}
