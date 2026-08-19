export type Locale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number>;

const enMessages = {
  unknownPanel: 'Unknown panel: {panel}',
  loading: 'Loading…',
  unknownError: 'Unknown error',
  commitSuccess: 'Submitted successfully',
  commitFailure: 'Submission failed',
  discardWarning: '{count} unsaved local change(s) will be discarded when changing page or refreshing. Continue?',
  copyRow: 'Copy current row',
  editInEditor: 'Edit in Editor',
  deleteRow: 'Delete current row',
  undoEdit: 'Undo edit',
  undoNew: 'Undo new row',
  undoDelete: 'Undo delete',
  pinColumn: 'Pin column',
  unpinColumn: 'Unpin column',
  ascendingSort: 'Sort {field} ascending',
  descendingSort: 'Sort {field} descending',
  filterColumn: 'Filter {field}',
  filterValue: 'Enter filter value',
  multipleValues: 'Separate multiple values with commas',
  twoValues: 'Separate two values with commas',
  clear: 'Clear',
  confirm: 'Confirm',
  firstPage: 'First',
  totalRows: '{start}-{end} / {total} rows',
  lastPage: 'Last',
  addRow: 'Add row',
  submitChanges: 'Submit changes',
  submitChangesCount: 'Submit changes ({count})',
  columnSettings: 'Column settings',
  refresh: 'Refresh',
  selectAll: 'Select all',
  clearAll: 'Clear all',
  resetOrder: 'Reset order',
  addRowTitle: 'Add row (auto_increment columns are generated automatically)',
  cancel: 'Cancel',
  submitInsert: 'Insert',
  requiredField: 'Enter {field}',
  sqlFilterTitle: 'SQL filter condition; press Enter to apply',
  sqlFilterInput: 'SQL filter condition input',
  sqlFilterPlaceholder: "Enter SQL condition, e.g. status = 'active' AND (score > 80 OR name LIKE '%test%')",
} as const;

type MessageKey = keyof typeof enMessages;

const zhMessages: Record<MessageKey, string> = {
  unknownPanel: '未知面板: {panel}',
  loading: '加载中…',
  unknownError: '未知错误',
  commitSuccess: '提交成功',
  commitFailure: '提交失败',
  discardWarning: '有 {count} 项未提交的本地变更，翻页/刷新将丢弃，确定继续？',
  copyRow: '复制当前行',
  editInEditor: '在编辑器中编辑',
  deleteRow: '删除当前行',
  undoEdit: '撤销修改',
  undoNew: '撤销新增',
  undoDelete: '撤销删除',
  pinColumn: '固定列',
  unpinColumn: '取消固定列',
  ascendingSort: '按 {field} 升序排序',
  descendingSort: '按 {field} 降序排序',
  filterColumn: '过滤 {field}',
  filterValue: '输入过滤值',
  multipleValues: '多个值用逗号分隔',
  twoValues: '两个值用逗号分隔',
  clear: '清除',
  confirm: '确认',
  firstPage: '首页',
  totalRows: '{start}-{end} / 共 {total} 行',
  lastPage: '末页',
  addRow: '新增行',
  submitChanges: '提交变更',
  submitChangesCount: '提交变更（{count}）',
  columnSettings: '列设置',
  refresh: '刷新',
  selectAll: '全选',
  clearAll: '清空',
  resetOrder: '恢复顺序',
  addRowTitle: '新增行（auto_increment 列自动生成）',
  cancel: '取消',
  submitInsert: '提交插入',
  requiredField: '请输入 {field}',
  sqlFilterTitle: 'SQL 过滤条件，按 Enter 应用',
  sqlFilterInput: 'SQL 过滤条件输入框',
  sqlFilterPlaceholder: "输入 SQL 条件，例如 status = 'active' AND (score > 80 OR name LIKE '%test%')",
};

export function normalizeLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

declare global {
  interface Window {
    __connectToolboxLocale?: string;
  }
}

export const currentLocale = normalizeLocale(
  window.__connectToolboxLocale
    ?? new URLSearchParams(window.location.search).get('lang')
    ?? navigator.language,
);

export function t(key: MessageKey, params: MessageParams = {}): string {
  const messages = currentLocale === 'zh-CN' ? zhMessages : enMessages;
  const template = messages[key] ?? enMessages[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
