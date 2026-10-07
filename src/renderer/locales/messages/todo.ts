/** Task and phase labels shared by the plan popover. */
export const todoMessages: Record<'en' | 'zh-CN', Record<string, string>> = {
  en: {
    'todo.currentPhase': 'Current', 'todo.status.paused': 'Paused',
    'todo.status.pending': 'Pending', 'todo.status.in_progress': 'In progress', 'todo.status.completed': 'Completed',
    'todo.status.blocked': 'Blocked', 'todo.status.abandoned': 'Abandoned',
  },
  'zh-CN': {
    'todo.currentPhase': '当前阶段', 'todo.status.paused': '已暂停',
    'todo.status.pending': '待开始', 'todo.status.in_progress': '进行中', 'todo.status.completed': '已完成',
    'todo.status.blocked': '受阻', 'todo.status.abandoned': '已放弃',
  },
};
