import type { Screen } from './types';

/** 配置、验证和未覆盖分开记录；这不是SEO分数，也不代替用户的发布确认。 */
export type LaunchCheckStatus = 'configured' | 'unverified' | 'passed' | 'attention' | 'failed' | 'not-applicable';
export type LaunchCheckCategory = 'content' | 'website' | 'services' | 'operations';
export interface LaunchCheckAction { screen: Screen; settingsTab?: 'general' | 'domain' | 'ai' | 'mail' | 'discovery' | 'backup' | 'language'; label: string; }
export interface LaunchCheckItem {
  id: string; category: LaunchCheckCategory; title: string; status: LaunchCheckStatus; message: string;
  checkedAt?: string; evidence?: string[]; action?: LaunchCheckAction;
}
export interface LaunchCheckReport {
  revision: number; releaseId: string | null; publicUrl: string | null; generatedAt: string;
  summary: { passed: number; configured: number; needsAttention: number; unverified: number; notApplicable: number; total: number };
  items: LaunchCheckItem[];
  lastCheck: { id: string; createdAt: string; expiresAt: string; checks: LaunchCheckKind[] } | null;
  note: string;
}
export type LaunchCheckKind = 'local' | 'public-website';
export interface LaunchCheckRequest { expectedRevision: number; expectedReleaseId: string | null; checks: LaunchCheckKind[]; }
