import React from 'react';
import { Button, Dropdown, Input, Pagination, Space, Typography, Popover, Checkbox, App as AntApp } from 'antd';
import type { ColumnsType, ColumnType } from 'antd/es/table';
import { Table } from 'antd';
import { DoubleLeftOutlined, DoubleRightOutlined, SettingOutlined, ReloadOutlined, PlusOutlined, CheckOutlined } from '@ant-design/icons';
import { onMessage, postMessage } from '../../vscodeBridge';
import { ColumnDef, PagePayload, CellValue, LocalRow, PanelMessage, CellEditedPayload } from './types';
import { useColumnPrefs } from './useColumnPrefs';
import { AddRowModal } from './AddRowModal';

const PAGE_SIZE = 50;
/** 表头右边缘热区宽度（px） */
const RESIZE_HOTZONE = 10;
/** 列宽拖动最小宽度（px） */
const MIN_COL_WIDTH = 20;

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
  .ct-th-resizable:hover { cursor: col-resize; }
  .ant-table-cell { min-width: 0 !important; max-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
  .ct-row-deleted { opacity: .45; text-decoration: line-through; }
  .ct-row-new td { background: rgba(255, 200, 60, .12) !important; }
  .ct-row-modified td { background: rgba(100, 180, 255, .10) !important; }
`;

/** 正在编辑的单元格 */
interface EditingCell {
  key: string;
  field: string;
}

/**
 * 内联编辑输入框（双击单元格快速编辑）
 */
function EditInput({ value, onChange, onSave, onCancel }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <Input
      size="small"
      autoFocus
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

/** 右键菜单 */
interface CtxMenu {
  x: number;
  y: number;
  key: string;
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

  const { order, visible, widths, toggleVisible, showAll, hideAll, resetOrder, setWidth } = useColumnPrefs(state?.database ?? '', state?.table ?? '');

  const loadPage = React.useCallback((page: number) => {
    setLoading(true);
    postMessage({ type: 'loadPage', payload: { page } });
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
        setState(m.payload as PagePayload);
        setError('');
        setLoading(false);
      } else if (m.type === 'error') {
        setError(m.message ?? '未知错误');
        setLoading(false);
        setCommitting(false);
      } else if (m.type === 'commitResult') {
        setCommitting(false);
        if (m.ok) {
          msg.success(m.message ?? '提交成功');
        } else {
          msg.error(m.message ?? '提交失败');
        }
      } else if (m.type === 'cellEdited' && m.payload) {
        // 单元格编辑器保存 → 写回本地暂存（未改动则忽略）
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
        msg.success(`已暂存「${field}」的修改，点击「提交变更」生效`);
      }
    });
  }, []);

  React.useEffect(() => {
    loadPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 列宽拖拽（事件委托） ----
  React.useEffect(() => {
    let resize: { field: string; th: HTMLTableCellElement; startX: number; startW: number } | null = null;
    let lastW = 0;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const th = target.closest?.('th.ct-th-resizable') as HTMLTableCellElement | null;
      if (!th || !th.dataset.field) return;
      const rect = th.getBoundingClientRect();
      if (rect.right - e.clientX > RESIZE_HOTZONE) return;
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      lastW = th.offsetWidth;
      resize = { field: th.dataset.field, th, startX: e.clientX, startW: th.offsetWidth };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!resize) return;
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
      if (!e) return r;
      return { ...r, ...e.changes, __status: 'modified' as const };
    });
    const result = [...merged];
    [...drafts]
      .sort((a, b) => (a.__afterIndex ?? 0) - (b.__afterIndex ?? 0))
      .forEach((d) => {
        const pos = result.findIndex((r) => (r.__afterIndex ?? 0) > (d.__afterIndex ?? 0));
        result.splice(pos === -1 ? result.length : pos, 0, d);
      });
    return result;
  }, [state, drafts, edits]);

  const changeCount = drafts.length + Object.keys(edits).length + Object.keys(deletes).length;

  // 变更数实时上报主进程（用于关闭面板时提醒）
  React.useEffect(() => {
    postMessage({ type: 'dirty', payload: { count: changeCount } });
  }, [changeCount]);

  // ---- 行/单元格操作 ----
  const rowByKey = (key: string): LocalRow | undefined => displayRows.find((r) => r.__key === key);

  const startEdit = (key: string, field: string) => {
    const row = rowByKey(key);
    if (!row || isHex(row[field] as CellValue)) return;
    setEditing({ key, field });
    setEditingValue(editValue(row[field] as CellValue));
  };

  const saveEdit = () => {
    if (!editing) return;
    const row = rowByKey(editing.key);
    if (!row) { setEditing(null); return; }
    const old = editValue(row[editing.field] as CellValue);
    if (old !== editingValue) {
      setEdits((prev) => ({
        ...prev,
        [editing.key]: {
          changes: { ...(prev[editing.key]?.changes ?? {}), [editing.field]: editingValue },
          pkValues: row.__pkValues ?? [],
        },
      }));
    }
    setEditing(null);
  };

  const cancelEdit = () => setEditing(null);

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

  /** 翻页/刷新前确认（有未提交变更时） */
  const confirmDiscard = (): boolean => {
    if (changeCount === 0) return true;
    return window.confirm(`有 ${changeCount} 项未提交的本地变更，翻页/刷新将丢弃，确定继续？`);
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
      payload: { commit: { inserts, updates, deletes: delList } },
    });
  };

  // ---- 右键菜单 ----
  const ctxItems = [
    { key: 'copy', label: '复制当前行' },
    {
      key: 'edit',
      label: '在编辑器中编辑',
      disabled: !!ctxMenu && isHex(rowByKey(ctxMenu.key)?.[ctxMenu.field] as CellValue),
    },
    ...(ctxMenu && deletes[ctxMenu.key] ? [{ key: 'undelete', label: '取消删除' }] : []),
    { key: 'delete', label: '删除当前行' },
  ];
  /** 右键"编辑"：调主进程命令，用 VSCode 编辑器打开单元格（保存写回本地暂存） */
  const openInEditor = (key: string, field: string) => {
    const row = rowByKey(key);
    if (!row || isHex(row[field] as CellValue)) return;
    postMessage({
      type: 'editCell',
      payload: { rowKey: key, field, value: editValue(row[field] as CellValue), pkValues: row.__pkValues ?? [] },
    });
  };
  const onCtxClick = ({ key }: { key: string }) => {
    if (!ctxMenu) return;
    const { key: rowKey, field } = ctxMenu;
    if (key === 'copy') copyRow(rowKey);
    else if (key === 'edit') openInEditor(rowKey, field);
    else if (key === 'delete') markDelete(rowKey);
    else if (key === 'undelete') unmarkDelete(rowKey);
    setCtxMenu(null);
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
    return ordered
      .filter((c) => visible[c.field] !== false)
      .map((c) => {
        const col: ColumnType<LocalRow> = {
          title: (
            <span>
              {c.field}
              {c.key === 'PRI' && ' 🔑'}
              <div style={{ fontWeight: 'normal', fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{c.type}</div>
            </span>
          ),
          dataIndex: c.field,
          key: c.field,
          width: widths[c.field] ?? 150,
          ellipsis: true,
          onHeaderCell: () => ({
            className: 'ct-th-resizable',
            'data-field': c.field,
          }),
          render: (v: CellValue, row: LocalRow) => {
            if (editing && editing.key === row.__key && editing.field === c.field) {
              return <EditInput value={editingValue} onChange={setEditingValue} onSave={saveEdit} onCancel={cancelEdit} />;
            }
            return (
              <span
                style={{
                  color: v === null ? 'var(--vscode-descriptionForeground)' : undefined,
                  fontStyle: v === null ? 'italic' : undefined,
                  fontFamily: 'monospace',
                }}
              >
                {cellText(v)}
              </span>
            );
          },
          onCell: (row: LocalRow) => ({
            onDoubleClick: () => {
              if (row.__status === 'deleted') return;
              startEdit(row.__key, c.field);
            },
            onContextMenu: (e: React.MouseEvent) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, key: row.__key, field: c.field });
            },
          }),
        };
        return col;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, order, visible, widths, editing, editingValue, deletes]);

  if (!state) {
    return <div style={{ padding: 24 }}>{error || '加载中…'}</div>;
  }

  const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
  const scrollX = columns.reduce((sum, column) => sum + Number(column.width ?? 150), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Space style={{ padding: 8, flexWrap: 'wrap' }} wrap>
        <Button size="small" icon={<PlusOutlined />} disabled={!state.hasPk} onClick={() => setAddOpen(true)}>新增行</Button>
        <Button
          size="small"
          type={changeCount > 0 ? 'primary' : 'default'}
          icon={<CheckOutlined />}
          disabled={changeCount === 0}
          loading={committing}
          onClick={doCommit}
        >
          提交变更{changeCount > 0 ? `（${changeCount}）` : ''}
        </Button>
        <Popover
          content={<ColumnSettingsPanel columns={state.columns} order={order} visible={visible} toggleVisible={toggleVisible} showAll={showAll} hideAll={hideAll} resetOrder={resetOrder} />}
          trigger="click"
          placement="bottomRight"
        >
          <Button size="small" icon={<SettingOutlined />}>列设置</Button>
        </Popover>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => {
            if (!confirmDiscard()) return;
            loadPage(state.page);
          }}
        >
          刷新
        </Button>
        <Typography.Text type={error ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>{error}</Typography.Text>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 11, padding: '0 10px' }}>
        双击单元格快速编辑（Enter 保存 / Esc 取消）；右键单元格：复制当前行 / 在编辑器中编辑（Cmd+S 保存）/ 删除当前行；变更通过「提交变更」统一生效
      </Typography.Text>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Table
          rowKey="__key"
          columns={columns}
          dataSource={displayRows}
          size="small"
          loading={loading}
          pagination={false}
          bordered
          tableLayout="fixed"
          scroll={{ x: scrollX, y: 'calc(100vh - 150px)' }}
          onRow={(row) => ({
            className:
              row.__status === 'deleted'
                ? 'ct-row-deleted'
                : row.__status === 'new'
                  ? 'ct-row-new'
                  : row.__status === 'modified'
                    ? 'ct-row-modified'
                    : undefined,
            onClick: () => setCtxMenu(null),
          })}
        />
      </div>
      <div style={{ padding: 8, borderTop: '1px solid var(--vscode-panel-border)', display: 'flex', justifyContent: 'flex-start' }}>
        <Space size={8}>
          <Button size="small" icon={<DoubleLeftOutlined />} onClick={() => { if (confirmDiscard()) loadPage(1); }} disabled={state.page <= 1}>首页</Button>
          <Pagination
            size="small"
            current={state.page}
            total={state.total}
            pageSize={state.pageSize}
            showSizeChanger={false}
            showQuickJumper
            showTotal={(total, range) => `${range[0]}-${range[1]} / 共 ${total} 行`}
            onChange={(p) => { if (confirmDiscard()) loadPage(p); }}
          />
          <Button size="small" icon={<DoubleRightOutlined />} onClick={() => { if (confirmDiscard()) loadPage(maxPage); }} disabled={state.page >= maxPage}>末页</Button>
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
      {addOpen && (
        <AddRowModal
          columns={state.columns}
          page={state.page}
          onClose={() => setAddOpen(false)}
          onAdded={() => loadPage(state.page)}
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
  showAll,
  hideAll,
  resetOrder,
}: {
  columns: ColumnDef[];
  order: string[];
  visible: Record<string, boolean>;
  toggleVisible: (field: string, visible: boolean) => void;
  showAll: () => void;
  hideAll: () => void;
  resetOrder: () => void;
}) {
  const items = [...columns].sort((a, b) => {
    const ai = order.indexOf(a.field);
    const bi = order.indexOf(b.field);
    return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi);
  });
  return (
    <div style={{ width: 240, maxHeight: 300, overflow: 'auto' }}>
      <Space size={4} style={{ marginBottom: 8 }}>
        <Button size="small" type="primary" onClick={showAll}>全选</Button>
        <Button size="small" onClick={hideAll}>清空</Button>
        <Button size="small" onClick={resetOrder}>恢复顺序</Button>
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
