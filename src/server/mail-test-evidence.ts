import { readServiceTestEvidence } from './service-test-evidence';
/** 上线工作台只读取与当前SMTP身份匹配的最后一次显式测试，模拟不会转换成真实发信证明。 */
export function readMailTestEvidence() { return readServiceTestEvidence('mail'); }
