import type { Config } from '@puckeditor/core';

export interface ProjectMilestone {
  label: string;
  title: string;
  description: string;
}

export const PROJECT_TIMELINE_MAX_ITEMS = 12;
export const projectTimelineDefaults = {
  title: 'Project milestones',
  items: [
    { label: 'Planning', title: 'Review the requirements', description: 'Describe what the project team needs before work starts.' },
    { label: 'Handover', title: 'Confirm the next step', description: 'Explain how the team shares the outcome and agrees the next action.' },
  ] satisfies ProjectMilestone[],
};

/** 草稿可暂留空白，发布需要阶段标题。阶段标记是自填文字，可以写日期、阶段或留空。 */
export function projectTimelineErrors(props: Record<string, unknown>, publishing: boolean): string[] {
  const { title, items } = props;
  const errors: string[] = [];
  if (typeof title !== 'string' || title.length > 160) errors.push('时间线标题不能超过160字符');
  if (!Array.isArray(items) || items.length > PROJECT_TIMELINE_MAX_ITEMS || publishing && !items.length) {
    errors.push(`请填写1–${PROJECT_TIMELINE_MAX_ITEMS}个项目阶段`);
  } else if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).some(key => !['label', 'title', 'description'].includes(key))
    || typeof item.label !== 'string' || item.label.length > 80
    || typeof item.title !== 'string' || item.title.length > 160 || publishing && !item.title.trim()
    || typeof item.description !== 'string' || item.description.length > 1200)) {
    errors.push('阶段标记、标题或说明无效，请填写阶段标题并检查文字长度');
  }
  return errors;
}

/** 公开与隔离预览共用有序列表，读取顺序与编辑面板一致。 */
export const projectTimelineView: Config['components'][string] = {
  render: ({ title, items = [] }) => (
    <div className="site-project-timeline">
      {title && <h2>{title}</h2>}
      <ol className="site-project-milestones" role="list">
        {(items as ProjectMilestone[]).map((item, index) => <li key={index}>
          {item.label && <span className="site-project-milestone-label">{item.label}</span>}
          <h3>{item.title}</h3>
          {item.description && <p>{item.description}</p>}
        </li>)}
      </ol>
    </div>
  ),
};
