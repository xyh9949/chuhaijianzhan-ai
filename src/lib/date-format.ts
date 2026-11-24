/** 数据库存 UTC ISO，界面按站点配置时区展示；旧版纯文本时间仅作兼容展示。 */
export function formatDate(value: string, timeZone = 'Asia/Hong_Kong') {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value || '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
