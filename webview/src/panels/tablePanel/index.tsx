import React from 'react';
import { Button, Divider, Dropdown, Input, Pagination, Space, Typography, Popover, Checkbox, Select, App as AntApp } from 'antd';
import type { ColumnsType, ColumnType } from 'antd/es/table';
import { Table } from 'antd';
import {
  DoubleLeftOutlined,
  DoubleRightOutlined,
  SettingOutlined,
  ReloadOutlined,
  PlusOutlined,
  CheckOutlined,
  FilterFilled,
  FilterOutlined,
  CaretUpFilled,
  CaretDownFilled,
} from '@ant-design/icons';
import { onMessage, postMessage } from '../../vscodeBridge';
import {
  ColumnDef,
  PagePayload,
  CellValue,
  LocalRow,
  PanelMessage,
  CellEditedPayload,
  FilterOperator,
  FilterSpec,
  SortSpec,
  TableQuery,
} from './types';
import { useColumnPrefs } from './useColumnPrefs';
import { AddRowModal } from './AddRowModal';
import { SqlFilterEditor } from './SqlFilterEditor';
import { t } from '../../i18n';

const PAGE_SIZE = 50;
/** 表头右边缘热区宽度（px）：仅交界线附近可调整列宽 */
const RESIZE_HOTZONE = 4;
/** 列宽拖动最小宽度（px） */
const MIN_COL_WIDTH = 20;
const ROW_NUMBER_WIDTH = 56;

const FILTER_OPERATOR_VALUES: FilterOperator[] = [
  '=',
  '!=',
  '<>',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'NOT LIKE',
  'IN',
  'NOT IN',
  'BETWEEN',
  'NOT BETWEEN',
  'REGEXP',
  'NOT REGEXP',
  'IS NULL',
  'IS NOT NULL',
];
const FILTER_OPERATOR_OPTIONS = FILTER_OPERATOR_VALUES.map((operator) => ({ label: operator, value: operator }));

const OPERATORS_WITHOUT_VALUE = new Set<FilterOperator>(['IS NULL', 'IS NOT NULL']);

interface FilterDraft {
  operator: FilterOperator;
  value: string;
}

/** 单元格展示文本 */
export function cellText(v: CellValue): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object' && v.__type === 'hex') return '0x' + v.value;
  return String(v);
}

export function isHex(v: CellValue): boolean {
  return !!(v && typeof v === 'object' && v.__type === 'hex');
}

/** 传给主进程的编辑值：NULL → ''（表示保持 NULL） */
export function editValue(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.__type === 'hex') return '0x' + v.value;
  return String(v);
}

const resizeThStyle = `
  .ct-th-resizable { position: relative !important; min-width: 0 !important; overflow: hidden !important; }
  .ct-th-resizable::after {
    content: ''; position: absolute; right: 0; top: 15%; bottom: 15%; width: 3px;
    background: var(--vscode-panel-border); pointer-events: none;
  }
  .ct-th-resizable:hover::after { background: var(--vscode-focusBorder); width: 4px; }
  .ant-table-cell { min-width: 0 !important; max-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
  .ct-row-deleted { opacity: .45; text-decoration: line-through; }
  .ct-row-deleted td { background: rgba(255, 90, 90, .16) !important; }
  .ct-row-new td { background: rgba(255, 200, 60, .14) !important; }
  .ct-cell-modified { background: rgba(100, 180, 255, .18) !important; }
  .ct-row-number-header, .ct-row-number-cell {
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editorGroupHeader-tabsBackground) !important;
    font-family: monospace;
  }
  .ct-row-number-cell { text-align: right; }
  .ct-sticky-header { position: sticky !important; z-index: 4 !important; }
  .ct-sticky-body { position: sticky !important; z-index: 2 !important; }
`;

/** 正在编辑的单元格 */
interface EditingCell {
  key: string;
  field: string;
}

/**
 * 内联编辑输入框（双击单元格快速编辑）
 * - ref + useEffect 手动聚焦：webview 中 autoFocus 不可靠，会导致输入框出现但光标未进入
 * - onBlur 直接保存（不做延迟）
 */
function EditInput({ value, onChange, onSave, onCancel }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const ref = React.useRef<React.ElementRef<typeof Input> | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select?.();
    }
  }, []);
  return (
    <Input
      ref={ref}
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPressEnter={onSave}
      onBlur={onSave}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

/**
 * 单元格内容（memo 隔离）：双击进入编辑时只有目标单元格重渲染，
 * 避免整个 Table 的所有单元格重新调和导致的编辑延迟
 */
const CellContent = React.memo(function CellContent({ value, editing, editingValue, onChange, onSave, onCancel }: {
  value: CellValue;
  editing: boolean;
  editingValue: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  if (editing) {
    return <EditInput value={editingValue} onChange={onChange} onSave={onSave} onCancel={onCancel} />;
  }
  return (
    <span
      style={{
        color: value === null ? 'var(--vscode-descriptionForeground)' : undefined,
        fontStyle: value === null ? 'italic' : undefined,
        fontFamily: 'monospace',
      }}
    >
      {cellText(value)}
    </span>
  );
});

/** 右键菜单 */
interface CtxMenu {
  x: number;
  y: number;
  key: string;
  field: string;
}

/** 表头右键菜单 */
interface HeaderMenu {
  x: number;
  y: number;
  field: string;
}

export default function TablePanel(): React.JSX.Element {
  const { message: msg } = AntApp.useApp();
  React.useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.textContent = resizeThStyle;
    document.head.appendChild(styleEl);
    return () => { styleEl.remove(); };
  }, []);

  const [state, setState] = React.useState<PagePayload | null>(null);
  const [error, setError] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);

  // ---- 本地暂存（Commit 后一次性提交） ----
  const [drafts, setDrafts] = React.useState<LocalRow[]>([]);
  const [edits, setEdits] = React.useState<Record<string, { changes: Record<string, string>; pkValues: string[] }>>({});
  const [deletes, setDeletes] = React.useState<Record<string, string[]>>({});
  const [editing, setEditing] = React.useState<EditingCell | null>(null);
  const [editingValue, setEditingValue] = React.useState('');
  const [ctxMenu, setCtxMenu] = React.useState<CtxMenu | null>(null);
  const [headerMenu, setHeaderMenu] = React.useState<HeaderMenu | null>(null);
  const [sort, setSort] = React.useState<SortSpec | null>(null);
  const [filters, setFilters] = React.useState<Record<string, FilterSpec>>({});
  const [sqlFilter, setSqlFilter] = React.useState('');
  const [sqlFilterDraft, setSqlFilterDraft] = React.useState('');
  const [filterOpenField, setFilterOpenField] = React.useState<string | null>(null);
  const [filterDrafts, setFilterDrafts] = React.useState<Record<string, FilterDraft>>({});
  const filterCloseHandledRef = React.useRef<{ field: string; action: 'apply' | 'clear' } | null>(null);
  const tableAreaRef = React.useRef<HTMLDivElement | null>(null);
  const [tableBodyHeight, setTableBodyHeight] = React.useState(240);

  const { order, visible, widths, marked, toggleVisible, toggleAllVisible, resetOrder, setWidth, toggleMarked } = useColumnPrefs(state?.database ?? '', state?.table ?? '');

  const loadPage = React.useCallback((page: number, query: TableQuery) => {
    setLoading(true);
    postMessage({ type: 'loadPage', payload: { page, query } });
  }, []);

  React.useEffect(() => {
    return onMessage<PanelMessage>((m) => {
      if (m.type === 'page' && m.payload) {
        // 页面数据刷新：清空本地暂存（服务端已持久化）
        setDrafts([]);
        setEdits({});
        setDeletes({});
        setEditing(null);
        setCtxMenu(null);
        setHeaderMenu(null);
        setFilterOpenField(null);
        const pagePayload = m.payload as PagePayload;
        if (pagePayload.query) {
          setSort(pagePayload.query.sort ?? null);
          setFilters(Object.fromEntries(pagePayload.query.filters.map((filter) => [filter.field, filter])));
          const nextSqlFilter = pagePayload.query.sqlFilter ?? '';
          setSqlFilter(nextSqlFilter);
          setSqlFilterDraft(nextSqlFilter);
        }
        setState(pagePayload);
        setError('');
        setLoading(false);
      } else if (m.type === 'error') {
        setError(m.message ?? t('unknownError'));
        setLoading(false);
        setCommitting(false);
      } else if (m.type === 'commitResult') {
        setCommitting(false);
        if (m.ok) {
          msg.success(m.message ?? t('commitSuccess'));
        } else {
          msg.error(m.message ?? t('commitFailure'));
        }
      } else if (m.type === 'cellEdited' && m.payload) {
        // 单元格编辑器自动保存 → 写回本地暂存（未改动则忽略）
        const { rowKey, field, value, originalValue, pkValues } = m.payload as CellEditedPayload;
        if (value === originalValue) return;
        setEdits((prev) => {
          const cur = prev[rowKey]?.changes?.[field];
          if (cur === value) return prev;
          return {
            ...prev,
            [rowKey]: {
              changes: { ...(prev[rowKey]?.changes ?? {}), [field]: value },
              pkValues: pkValues ?? prev[rowKey]?.pkValues ?? [],
            },
          };
        });
      }
    });
  }, []);

  React.useEffect(() => {
    loadPage(1, { filters: [], sqlFilter: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 列宽拖拽（事件委托） ----
  React.useEffect(() => {
    let resize: { field: string; th: HTMLTableCellElement; startX: number; startW: number } | null = null;
    let lastW = 0;

    const findResizeHeader = (target: EventTarget | null, clientX: number): HTMLTableCellElement | null => {
      const element = target as HTMLElement | null;
      const th = element?.closest?.('th.ct-th-resizable') as HTMLTableCellElement | null;
      if (!th || !th.dataset.field) return null;
      const rect = th.getBoundingClientRect();
      const distanceToRight = rect.right - clientX;
      return distanceToRight >= 0 && distanceToRight <= RESIZE_HOTZONE ? th : null;
    };

    const onMouseDown = (e: MouseEvent) => {
      const th = findResizeHeader(e.target, e.clientX);
      if (!th || !th.dataset.field) return;
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      lastW = th.offsetWidth;
      resize = { field: th.dataset.field, th, startX: e.clientX, startW: th.offsetWidth };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!resize) {
        const th = findResizeHeader(e.target, e.clientX);
        document.body.style.cursor = th ? 'col-resize' : '';
        return;
      }
      const w = Math.max(MIN_COL_WIDTH, resize.startW + (e.clientX - resize.startX));
      lastW = w;
      resize.th.style.width = w + 'px';
      const container = resize.th.closest('.ant-table-container') as HTMLElement | null;
      const rootTable = resize.th.closest('table');
      const tables = container ? Array.from(container.querySelectorAll('table')) : (rootTable ? [rootTable] : []);
      const thIndex = resize.th.parentElement ? Array.from(resize.th.parentElement.children).indexOf(resize.th) : -1;
      tables.forEach((table) => {
        const col = table.querySelectorAll('colgroup col')[thIndex] as HTMLTableColElement | undefined;
        if (col) col.style.width = w + 'px';
      });
    };

    const onMouseUp = () => {
      if (!resize) return;
      setWidth(resize.field, Math.max(MIN_COL_WIDTH, lastW));
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resize = null;
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [setWidth]);

  // ---- 本地行合并：服务端行 + 草稿 + 修改 + 删除标记 ----
  const displayRows: LocalRow[] = React.useMemo(() => {
    if (!state) return [];
    const base: LocalRow[] = state.rows.map((row, i) => {
      const pkValues = state.pkColumns.map((c) => editValue(row[c] as CellValue));
      return {
        ...row,
        __key: `r-${i}`,
        __status: 'normal',
        __afterIndex: i,
        __pkValues: pkValues,
      };
    });
    const merged = base.map((r) => {
      const e = edits[r.__key];
      const status = deletes[r.__key]
        ? 'deleted'
        : e
          ? 'modified'
          : 'normal';
      return {
        ...r,
        ...(e?.changes ?? {}),
        __status: status as LocalRow['__status'],
      };
    });
    const result = [...merged];
    [...drafts]
      .sort((a, b) => (a.__afterIndex ?? 0) - (b.__afterIndex ?? 0))
      .forEach((d) => {
        const pos = result.findIndex((r) => (r.__afterIndex ?? 0) > (d.__afterIndex ?? 0));
        result.splice(pos === -1 ? result.length : pos, 0, d);
      });
    return result;
  }, [state, drafts, edits, deletes]);

  const changeCount = drafts.length + Object.keys(edits).length + Object.keys(deletes).length;

  // 变更数实时上报主进程（用于关闭面板时提醒）
  React.useEffect(() => {
    postMessage({ type: 'dirty', payload: { count: changeCount } });
  }, [changeCount]);

  // ---- 行/单元格操作 ----
  // editing / editingValue 同步到 ref：saveEdit 保持稳定引用，CellContent 的 memo 才生效
  const editingRef = React.useRef<EditingCell | null>(null);
  editingRef.current = editing;
  const editingValueRef = React.useRef('');
  editingValueRef.current = editingValue;

  const rowByKey = React.useCallback(
    (key: string): LocalRow | undefined => displayRows.find((r) => r.__key === key),
    [displayRows],
  );

  const startEdit = React.useCallback((key: string, field: string) => {
    const row = rowByKey(key);
    if (!row || isHex(row[field] as CellValue)) return;
    setEditing({ key, field });
    setEditingValue(editValue(row[field] as CellValue));
  }, [rowByKey]);

  const saveEdit = React.useCallback(() => {
    const cur = editingRef.current;
    if (!cur) return;
    const row = rowByKey(cur.key);
    if (!row) { setEditing(null); return; }
    const old = editValue(row[cur.field] as CellValue);
    const newVal = editingValueRef.current;
    if (old !== newVal) {
      setEdits((prev) => ({
        ...prev,
        [cur.key]: {
          changes: { ...(prev[cur.key]?.changes ?? {}), [cur.field]: newVal },
          pkValues: row.__pkValues ?? [],
        },
      }));
    }
    setEditing(null);
  }, [rowByKey]);

  const cancelEdit = React.useCallback(() => setEditing(null), []);

  const onEditValueChange = React.useCallback((v: string) => setEditingValue(v), []);

  const copyRow = (key: string) => {
    const src = rowByKey(key);
    if (!src) return;
    const newKey = `d-${Date.now()}`;
    const draft: LocalRow = {
      __key: newKey,
      __status: 'new',
      __afterIndex: src.__afterIndex,
      __pkValues: [],
    };
    (state?.columns ?? []).forEach((c) => {
      // 主键列清空（auto_increment 由数据库生成），其余复制
      draft[c.field] = state?.pkColumns.includes(c.field) ? '' : src[c.field];
    });
    setDrafts((prev) => [...prev, draft]);
  };

  const markDelete = (key: string) => {
    const row = rowByKey(key);
    if (!row) return;
    if (row.__status === 'new') {
      // 草稿行直接移除
      setDrafts((prev) => prev.filter((d) => d.__key !== key));
    } else {
      setDeletes((prev) => ({ ...prev, [key]: row.__pkValues ?? [] }));
    }
  };

  const unmarkDelete = (key: string) => {
    setDeletes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /** 只撤销当前 cell 的本地修改，其他字段修改保持不变 */
  const undoCellEdit = (key: string, field: string) => {
    setEdits((prev) => {
      const current = prev[key];
      if (!current || !Object.prototype.hasOwnProperty.call(current.changes, field)) return prev;
      const changes = { ...current.changes };
      delete changes[field];
      const next = { ...prev };
      if (Object.keys(changes).length === 0) {
        delete next[key];
      } else {
        next[key] = { ...current, changes };
      }
      return next;
    });
    if (editing?.key === key && editing.field === field) setEditing(null);
  };

  /** 撤销本地新增行 */
  const undoNewRow = (key: string) => {
    setDrafts((prev) => prev.filter((row) => row.__key !== key));
    setEdits((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (editing?.key === key) setEditing(null);
  };

  /** 翻页/刷新前确认（有未提交变更时） */
  const confirmDiscard = (): boolean => {
    if (changeCount === 0) return true;
    return window.confirm(t('discardWarning', { count: changeCount }));
  };

  const makeQuery = (
    nextSort: SortSpec | null,
    nextFilters: Record<string, FilterSpec>,
    nextSqlFilter: string = sqlFilter,
  ): TableQuery => ({
    sort: nextSort ?? undefined,
    filters: Object.values(nextFilters),
    sqlFilter: nextSqlFilter.trim() || undefined,
  });

  const applyQuery = (
    nextSort: SortSpec | null,
    nextFilters: Record<string, FilterSpec>,
    nextSqlFilter: string = sqlFilter,
  ): boolean => {
    const currentFields = new Set(Object.keys(filters));
    const nextFields = new Set(Object.keys(nextFilters));
    const filtersChanged = currentFields.size !== nextFields.size
      || [...currentFields].some((field) => {
        const before = filters[field];
        const after = nextFilters[field];
        return !after || !before || before.operator !== after.operator || before.value !== after.value;
      });
    const sortChanged = sort?.field !== nextSort?.field || sort?.direction !== nextSort?.direction;
    const normalizedSqlFilter = nextSqlFilter.trim();
    const sqlFilterChanged = sqlFilter !== normalizedSqlFilter;
    if (!sortChanged && !filtersChanged && !sqlFilterChanged) {
      setFilterOpenField(null);
      return true;
    }
    if (!confirmDiscard()) return false;
    setSort(nextSort);
    setFilters(nextFilters);
    setSqlFilter(normalizedSqlFilter);
    setFilterOpenField(null);
    loadPage(1, makeQuery(nextSort, nextFilters, normalizedSqlFilter));
    return true;
  };

  const handleSort = (field: string, direction: 'asc' | 'desc') => {
    const nextSort = sort?.field === field && sort.direction === direction
      ? null
      : { field, direction };
    applyQuery(nextSort, filters);
  };

  const openFilter = (field: string) => {
    filterCloseHandledRef.current = null;
    const current = filters[field];
    setFilterDrafts((prev) => ({
      ...prev,
      [field]: { operator: current?.operator ?? '=', value: current?.value ?? '' },
    }));
    setFilterOpenField(field);
    setHeaderMenu(null);
  };

  const updateFilterDraft = (field: string, patch: Partial<FilterDraft>) => {
    filterCloseHandledRef.current = null;
    setFilterDrafts((prev) => ({
      ...prev,
      [field]: {
        operator: patch.operator ?? prev[field]?.operator ?? '=',
        value: patch.value ?? prev[field]?.value ?? '',
      },
    }));
  };

  const applyFilterDraft = (field: string): boolean => {
    const draft = filterDrafts[field] ?? { operator: '=', value: '' };
    const nextFilters = { ...filters };
    const hasValue = OPERATORS_WITHOUT_VALUE.has(draft.operator) || draft.value.trim().length > 0;
    if (hasValue) {
      nextFilters[field] = {
        field,
        operator: draft.operator,
        ...(OPERATORS_WITHOUT_VALUE.has(draft.operator) ? {} : { value: draft.value }),
      };
    } else {
      delete nextFilters[field];
    }
    const applied = applyQuery(sort, nextFilters);
    if (applied) {
      filterCloseHandledRef.current = { field, action: 'apply' };
    }
    return applied;
  };

  const clearFilter = (field: string) => {
    const nextFilters = { ...filters };
    delete nextFilters[field];
    const applied = applyQuery(sort, nextFilters);
    if (!applied) return;
    filterCloseHandledRef.current = { field, action: 'clear' };
    setFilterDrafts((prev) => ({ ...prev, [field]: { operator: '=', value: '' } }));
  };

  const applySqlFilter = () => {
    const nextSqlFilter = sqlFilterDraft.trim();
    if (applyQuery(sort, filters, nextSqlFilter)) {
      setSqlFilterDraft(nextSqlFilter);
    }
  };

  const doCommit = () => {
    if (changeCount === 0) return;
    setCommitting(true);
    const autoInc = (state?.columns ?? []).filter((c) => /auto_increment/i.test(c.extra)).map((c) => c.field);
    // 新增：跳过 auto_increment 列
    const inserts = drafts.map((d) => {
      const values: Record<string, string> = {};
      (state?.columns ?? []).forEach((c) => {
        if (!autoInc.includes(c.field)) {
          values[c.field] = editValue(d[c.field] as CellValue);
        }
      });
      return values;
    });
    // 修改（排除已标记删除的行）
    const updates = Object.entries(edits)
      .filter(([key]) => !deletes[key])
      .map(([, e]) => ({ pkValues: e.pkValues, changes: e.changes }));
    // 删除
    const delList = Object.entries(deletes).map(([, pk]) => ({ pkValues: pk }));
    postMessage({
      type: 'commit',
      payload: { commit: { inserts, updates, deletes: delList }, page: state?.page, query: makeQuery(sort, filters) },
    });
  };

  // ---- 右键菜单 ----
  const ctxRow = ctxMenu ? rowByKey(ctxMenu.key) : undefined;
  const ctxCellEdited = !!ctxMenu && !!edits[ctxMenu.key]
    && Object.prototype.hasOwnProperty.call(edits[ctxMenu.key].changes, ctxMenu.field);
  const canEditCtxCell = !!ctxRow
    && ctxRow.__status !== 'deleted'
    && !isHex(ctxRow[ctxMenu?.field ?? ''] as CellValue);
  const canDeleteCtxRow = !!ctxRow
    && ctxRow.__status !== 'new'
    && ctxRow.__status !== 'deleted';
  const ctxItems = [
    { key: 'copy', label: t('copyRow') },
    // 不能操作的按钮直接不显示（例如删除行不能编辑、新增行不能再次删除）
    ...(canEditCtxCell ? [{ key: 'edit', label: t('editInEditor') }] : []),
    ...(canDeleteCtxRow ? [{ key: 'delete', label: t('deleteRow') }] : []),
    // 所有撤销操作统一放在菜单最下面
    ...(ctxCellEdited ? [{ key: 'undoEdit', label: t('undoEdit') }] : []),
    ...(ctxRow?.__status === 'new' ? [{ key: 'undoNew', label: t('undoNew') }] : []),
    ...(ctxRow?.__status === 'deleted' ? [{ key: 'undelete', label: t('undoDelete') }] : []),
  ];
  const headerItems = headerMenu
    ? [{ key: 'toggleMark', label: marked.includes(headerMenu.field) ? t('unpinColumn') : t('pinColumn') }]
    : [];
  /** 右键"编辑"：调主进程命令，用 VSCode 编辑器打开单元格（自动写回本地暂存） */
  const openInEditor = (key: string, field: string) => {
    const row = rowByKey(key);
    if (!row || row.__status === 'deleted' || isHex(row[field] as CellValue)) return;
    postMessage({
      type: 'editCell',
      payload: { rowKey: key, field, value: editValue(row[field] as CellValue), pkValues: row.__pkValues ?? [] },
    });
  };
  const onCtxClick = ({ key }: { key: string }) => {
    if (!ctxMenu) return;
    const { key: rowKey, field } = ctxMenu;
    if (key === 'copy') copyRow(rowKey);
    else if (key === 'undoEdit') undoCellEdit(rowKey, field);
    else if (key === 'undoNew') undoNewRow(rowKey);
    else if (key === 'edit') openInEditor(rowKey, field);
    else if (key === 'delete') markDelete(rowKey);
    else if (key === 'undelete') unmarkDelete(rowKey);
    setCtxMenu(null);
  };
  const onHeaderMenuClick = ({ key }: { key: string }) => {
    if (key === 'toggleMark' && headerMenu) {
      toggleMarked(headerMenu.field);
    }
    setHeaderMenu(null);
  };

  // ---- 列定义 ----
  const columns: ColumnsType<LocalRow> = React.useMemo(() => {
    if (!state) return [];
    const colDefs = state.columns;
    const ordered = [...colDefs].sort((a, b) => {
      const ai = order.indexOf(a.field);
      const bi = order.indexOf(b.field);
      return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi);
    });
    const rowNumberColumn: ColumnType<LocalRow> = {
      title: '#',
      key: '__rowNumber',
      width: ROW_NUMBER_WIDTH,
      align: 'right',
      onHeaderCell: () => ({
        className: 'ct-row-number-header ct-sticky-header',
        style: {
          position: 'sticky',
          left: 0,
          zIndex: 4,
          background: 'var(--vscode-editorGroupHeader-tabsBackground)',
        },
      }),
      onCell: (row: LocalRow) => ({
        className: 'ct-row-number-cell ct-sticky-body',
        style: {
          position: 'sticky',
          left: 0,
          zIndex: 2,
          background:
            row.__status === 'deleted'
              ? 'rgba(255, 90, 90, .16)'
              : row.__status === 'new'
                ? 'rgba(255, 200, 60, .14)'
                : 'var(--vscode-editorGroupHeader-tabsBackground)',
        },
      }),
      render: (_value: unknown, _row: LocalRow, index: number) => (
        <span>{(state.page - 1) * state.pageSize + index + 1}</span>
      ),
    };
    const markedSet = new Set(marked);
    const visibleColumns = ordered
      .filter((c) => visible[c.field] !== false)
      .sort((a, b) => Number(markedSet.has(b.field)) - Number(markedSet.has(a.field)));
    const stickyLeftByField = new Map<string, number>();
    let nextStickyLeft = ROW_NUMBER_WIDTH;
    visibleColumns.forEach((column) => {
      if (markedSet.has(column.field)) {
        stickyLeftByField.set(column.field, nextStickyLeft);
        nextStickyLeft += widths[column.field] ?? 150;
      }
    });
    return [
      rowNumberColumn,
      ...visibleColumns
        .map((c) => {
          const stickyLeft = stickyLeftByField.get(c.field);
          const isSticky = stickyLeft !== undefined;
          const col: ColumnType<LocalRow> = {
            title: (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  minWidth: 0,
                  gap: 2,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.field}
                  {c.key === 'PRI' && ' 🔑'}
                  <div style={{ fontWeight: 'normal', fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{c.type}</div>
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', flex: '0 0 16px', alignItems: 'center' }}>
                  <Button
                    type="text"
                    size="small"
                    aria-label={t('ascendingSort', { field: c.field })}
                    icon={<CaretUpFilled />}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleSort(c.field, 'asc');
                    }}
                    style={{
                      width: 16,
                      height: 12,
                      padding: 0,
                      lineHeight: '12px',
                      fontSize: 10,
                      color: sort?.field === c.field && sort.direction === 'asc'
                        ? 'var(--vscode-focusBorder)'
                        : 'var(--vscode-descriptionForeground)',
                    }}
                  />
                  <Button
                    type="text"
                    size="small"
                    aria-label={t('descendingSort', { field: c.field })}
                    icon={<CaretDownFilled />}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleSort(c.field, 'desc');
                    }}
                    style={{
                      width: 16,
                      height: 12,
                      padding: 0,
                      lineHeight: '12px',
                      fontSize: 10,
                      color: sort?.field === c.field && sort.direction === 'desc'
                        ? 'var(--vscode-focusBorder)'
                        : 'var(--vscode-descriptionForeground)',
                    }}
                  />
                </span>
                <Popover
                  trigger="click"
                  open={filterOpenField === c.field}
                  placement="bottomRight"
                  onOpenChange={(open) => {
                    if (open) {
                      openFilter(c.field);
                    } else if (filterCloseHandledRef.current?.field === c.field) {
                      filterCloseHandledRef.current = null;
                    } else {
                      applyFilterDraft(c.field);
                    }
                  }}
                  content={(
                    <div style={{ width: 190 }} onMouseDown={(event) => event.stopPropagation()}>
                      <Select<FilterOperator>
                        size="small"
                        value={filterDrafts[c.field]?.operator ?? filters[c.field]?.operator ?? '='}
                        options={FILTER_OPERATOR_OPTIONS}
                        onChange={(operator) => updateFilterDraft(c.field, { operator, value: '' })}
                        getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
                        style={{ width: '100%', marginBottom: 8 }}
                      />
                      {!OPERATORS_WITHOUT_VALUE.has(filterDrafts[c.field]?.operator ?? filters[c.field]?.operator ?? '=') && (
                        <Input
                          size="small"
                          autoFocus
                          value={filterDrafts[c.field]?.value ?? filters[c.field]?.value ?? ''}
                          placeholder={
                            ['IN', 'NOT IN'].includes(filterDrafts[c.field]?.operator ?? filters[c.field]?.operator ?? '=')
                              ? t('multipleValues')
                              : ['BETWEEN', 'NOT BETWEEN'].includes(filterDrafts[c.field]?.operator ?? filters[c.field]?.operator ?? '=')
                                ? t('twoValues')
                                : t('filterValue')
                          }
                          onChange={(event) => updateFilterDraft(c.field, { value: event.target.value })}
                          onPressEnter={() => applyFilterDraft(c.field)}
                        />
                      )}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                        <Button size="small" onClick={() => clearFilter(c.field)}>
                          {t('clear')}
                        </Button>
                        <Button type="primary" size="small" onClick={() => applyFilterDraft(c.field)}>
                          {t('confirm')}
                        </Button>
                      </div>
                    </div>
                  )}
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label={t('filterColumn', { field: c.field })}
                    icon={filters[c.field] ? <FilterFilled /> : <FilterOutlined />}
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: 18,
                      height: 20,
                      padding: 0,
                      color: filters[c.field]
                        ? 'var(--vscode-focusBorder)'
                        : 'var(--vscode-descriptionForeground)',
                    }}
                  />
                </Popover>
              </div>
            ),
            dataIndex: c.field,
            key: c.field,
            width: widths[c.field] ?? 150,
            ellipsis: true,
            onHeaderCell: () => ({
              className: `ct-th-resizable${isSticky ? ' ct-sticky-header' : ''}`,
              'data-field': c.field,
              style: isSticky
                ? {
                    position: 'sticky',
                    left: stickyLeft,
                    zIndex: 4,
                    background: 'var(--vscode-editorGroupHeader-tabsBackground)',
                  }
                : undefined,
              onContextMenu: (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu(null);
                setHeaderMenu({ x: e.clientX, y: e.clientY, field: c.field });
              },
            }),
            render: (v: CellValue, row: LocalRow) => (
              <CellContent
                value={v}
                editing={!!(editing && editing.key === row.__key && editing.field === c.field)}
                editingValue={editingValue}
                onChange={onEditValueChange}
                onSave={saveEdit}
                onCancel={cancelEdit}
              />
            ),
            onCell: (row: LocalRow) => {
              const cellEdited = row.__status !== 'new'
                && row.__status !== 'deleted'
                && !!edits[row.__key]
                && Object.prototype.hasOwnProperty.call(edits[row.__key].changes, c.field);
              const className = [
                isSticky ? 'ct-sticky-body' : '',
                cellEdited ? 'ct-cell-modified' : '',
              ].filter(Boolean).join(' ') || undefined;
              return {
                className,
                style: isSticky
                  ? {
                      position: 'sticky',
                      left: stickyLeft,
                      zIndex: 2,
                      background:
                        row.__status === 'deleted'
                          ? 'rgba(255, 90, 90, .16)'
                          : row.__status === 'new'
                            ? 'rgba(255, 200, 60, .14)'
                            : cellEdited
                              ? 'rgba(100, 180, 255, .18)'
                              : 'var(--vscode-editor-background)',
                    }
                  : undefined,
                onDoubleClick: () => {
                  if (row.__status === 'deleted') return;
                  startEdit(row.__key, c.field);
                },
                onContextMenu: (e: React.MouseEvent) => {
                  e.preventDefault();
                  setHeaderMenu(null);
                  setCtxMenu({ x: e.clientX, y: e.clientY, key: row.__key, field: c.field });
                },
              };
            },
          };
          return col;
        }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state,
    order,
    visible,
    widths,
    marked,
    editing,
    editingValue,
    edits,
    deletes,
    sort,
    filters,
    filterOpenField,
    filterDrafts,
  ]);

  // 表格区域自适应：让表头 + 数据体（包含横向滚动条）完整落在可用高度内
  React.useLayoutEffect(() => {
    const area = tableAreaRef.current;
    if (!area) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const header = area.querySelector('.ant-table-thead') as HTMLElement | null;
        const headerHeight = header?.getBoundingClientRect().height ?? 48;
        const nextHeight = Math.max(100, Math.floor(area.clientHeight - headerHeight));
        setTableBodyHeight((current) => current === nextHeight ? current : nextHeight);
      });
    };
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(area);
    const header = area.querySelector('.ant-table-thead');
    if (header) resizeObserver.observe(header);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [state, columns.length]);

  if (!state) {
    return <div style={{ padding: 24 }}>{error || t('loading')}</div>;
  }

  const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
  const scrollX = columns.reduce((sum, column) => sum + Number(column.width ?? 150), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <SqlFilterEditor
        value={sqlFilterDraft}
        tableName={state.table}
        columns={state.columns}
        onChange={setSqlFilterDraft}
        onApply={applySqlFilter}
      />
      <div ref={tableAreaRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Table
          rowKey="__key"
          columns={columns}
          dataSource={displayRows}
          size="small"
          loading={loading}
          pagination={false}
          bordered
          tableLayout="fixed"
          scroll={{ x: scrollX, y: tableBodyHeight }}
          onRow={(row) => ({
            className:
              row.__status === 'deleted'
                ? 'ct-row-deleted'
                : row.__status === 'new'
                  ? 'ct-row-new'
                  : row.__status === 'modified'
                    ? 'ct-row-modified'
                    : undefined,
            onClick: () => {
              setCtxMenu(null);
              setHeaderMenu(null);
            },
          })}
        />
      </div>
      <div
        style={{
          padding: 8,
          borderTop: '1px solid var(--vscode-panel-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 8,
          overflowX: 'auto',
        }}
      >
        <Space size={8} wrap={false} style={{ flexShrink: 0 }}>
          <Button size="small" icon={<DoubleLeftOutlined />} onClick={() => { if (confirmDiscard()) loadPage(1, makeQuery(sort, filters)); }} disabled={state.page <= 1}>{t('firstPage')}</Button>
          <Pagination
            size="small"
            current={state.page}
            total={state.total}
            pageSize={state.pageSize}
            showSizeChanger={false}
            showQuickJumper
            showTotal={(total, range) => t('totalRows', { start: range[0], end: range[1], total })}
            onChange={(p) => { if (confirmDiscard()) loadPage(p, makeQuery(sort, filters)); }}
          />
          <Button size="small" icon={<DoubleRightOutlined />} onClick={() => { if (confirmDiscard()) loadPage(maxPage, makeQuery(sort, filters)); }} disabled={state.page >= maxPage}>{t('lastPage')}</Button>
        </Space>
        <Divider type="vertical" style={{ height: 20, margin: '0 4px', borderColor: 'var(--vscode-panel-border)' }} />
        <Space size={8} wrap={false} style={{ flexShrink: 0 }}>
          <Button size="small" icon={<PlusOutlined />} disabled={!state.hasPk} onClick={() => setAddOpen(true)}>{t('addRow')}</Button>
          <Button
            size="small"
            type={changeCount > 0 ? 'primary' : 'default'}
            icon={<CheckOutlined />}
            disabled={changeCount === 0}
            loading={committing}
            onClick={doCommit}
          >
            {changeCount > 0 ? t('submitChangesCount', { count: changeCount }) : t('submitChanges')}
          </Button>
          <Popover
            content={<ColumnSettingsPanel columns={state.columns} order={order} visible={visible} toggleVisible={toggleVisible} toggleAllVisible={toggleAllVisible} resetOrder={resetOrder} />}
            trigger="click"
            placement="topRight"
          >
            <Button size="small" icon={<SettingOutlined />}>{t('columnSettings')}</Button>
          </Popover>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => {
              if (!confirmDiscard()) return;
              loadPage(state.page, makeQuery(sort, filters));
            }}
          >
            {t('refresh')}
          </Button>
          <Typography.Text type={error ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>{error}</Typography.Text>
        </Space>
      </div>

      {ctxMenu && (
        <Dropdown
          open
          trigger={[]}
          menu={{ items: ctxItems, onClick: onCtxClick }}
          overlayStyle={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 1000, minWidth: 130, width: 140 }}
        >
          <span />
        </Dropdown>
      )}
      {headerMenu && (
        <Dropdown
          open
          trigger={[]}
          menu={{ items: headerItems, onClick: onHeaderMenuClick }}
          onOpenChange={(open) => {
            if (!open) setHeaderMenu(null);
          }}
          overlayStyle={{ position: 'fixed', left: headerMenu.x, top: headerMenu.y, zIndex: 1000, minWidth: 120, width: 130 }}
        >
          <span />
        </Dropdown>
      )}
      {addOpen && (
        <AddRowModal
          columns={state.columns}
          page={state.page}
          onClose={() => setAddOpen(false)}
          onAdded={() => loadPage(state.page, makeQuery(sort, filters))}
        />
      )}
    </div>
  );
}

function ColumnSettingsPanel({
  columns,
  order,
  visible,
  toggleVisible,
  toggleAllVisible,
  resetOrder,
}: {
  columns: ColumnDef[];
  order: string[];
  visible: Record<string, boolean>;
  toggleVisible: (field: string, visible: boolean) => void;
  toggleAllVisible: (fields: string[]) => void;
  resetOrder: () => void;
}) {
  const items = [...columns].sort((a, b) => {
    const ai = order.indexOf(a.field);
    const bi = order.indexOf(b.field);
    return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi);
  });
  const allVisible = columns.length > 0 && columns.every((column) => visible[column.field] !== false);
  return (
    <div style={{ width: 240, maxHeight: 300, overflow: 'auto' }}>
      <Space size={4} style={{ marginBottom: 8 }}>
        <Button
          size="small"
          type={allVisible ? 'default' : 'primary'}
          onClick={() => toggleAllVisible(columns.map((column) => column.field))}
        >
          {allVisible ? t('clearAll') : t('selectAll')}
        </Button>
        <Button size="small" onClick={resetOrder}>{t('resetOrder')}</Button>
      </Space>
      {items.map((c) => (
        <div key={c.field} style={{ padding: '2px 4px' }}>
          <Checkbox
            checked={visible[c.field] !== false}
            onChange={(e) => toggleVisible(c.field, e.target.checked)}
          >
            <Typography.Text style={{ fontSize: 12 }}>{c.field}</Typography.Text>
          </Checkbox>
        </div>
      ))}
    </div>
  );
}