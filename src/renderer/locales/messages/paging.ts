/** Paging strings (2026-09-29 reading fixes). */
export const pagingMessages: Record<'en' | 'zh-CN', Record<string, string>> = {
  en: {
    'omp.paging.loading': 'Loading earlier messages…',
    'omp.paging.failed': 'Loading failed',
    'omp.paging.retry': 'Retry',
    'omp.paging.beginning': 'Beginning of conversation',
    'omp.paging.start': 'Jump to loaded beginning',
  },
  'zh-CN': {
    'omp.paging.loading': '正在加载更早的消息…',
    'omp.paging.failed': '加载失败',
    'omp.paging.retry': '重试',
    'omp.paging.beginning': '已到会话开头',
    'omp.paging.start': '跳到已加载内容开头',
  },
};
