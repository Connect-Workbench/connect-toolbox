import React from 'react';
import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';

/** 与主进程一致的值形态（Date/hex/bigint 已序列化） */
export type CellValue = string | number | null | { __type: 'hex'; value: string };

/** 单元格展示文本 */
export function cellText(v: CellValue | unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object' && (v as { __type?: string }).__type === 'hex') {
    return '0x' + (v as { value: string }).value;
  }
  return String(v);
}

function renderCell(v: CellValue | unknown): React.JSX.Element {
  const hex = !!v && typeof v === 'object' && (v as { __type?: string }).__type === 'hex';
  const isNull = v === null || v === undefined;
  return (
    <span
      style={{
        color: isNull ? 'var(--vscode-descriptionForeground)' : undefined,
        fontStyle: isNull ? 'italic' : undefined,
        fontFamily: hex ? 'monospace' : undefined,
      }}
    >
      {cellText(v)}
    </span>
  );
}

/**
 * 通用只读数据网格（antd Table），供查询结果 / 任何二维展示复用：
 * - 表头粘性 + 表体自适应父容器高度（参照表数据面板做法）
 * - 单元格按类型渲染（NULL 斜体、hex 单色字体）
 * - 大数据仍交给 antd 虚拟滚动/分页策略（查询结果默认展示前 N 行）
 */
export default function DataGrid({
  columns,
  rows,
  loading,
}: {
  columns: string[];
  rows: Record<string, CellValue | unknown>[];
  loading?: boolean;
}): React.JSX.Element {
  const areaRef = React.useRef<HTMLDivElement | null>(null);
  const [bodyHeight, setBodyHeight] = React.useState(320);

  const tableColumns: ColumnsType<Record<string, CellValue | unknown>> = React.useMemo(() => {
    return columns.map((col) => ({
      title: col,
      dataIndex: col,
      key: col,
      ellipsis: true,
      render: (v: CellValue | unknown) => renderCell(v),
    }));
  }, [columns]);

  const data = React.useMemo(() => {
    // 每行按列顺序取数，行 key 用序号
    return rows.map((row, idx) => ({ __rowKey: idx, ...row }));
  }, [rows]);

  // 自适应表体高度
  React.useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const header = area.querySelector('.ant-table-thead') as HTMLElement | null;
        const headerH = header?.getBoundingClientRect().height ?? 39;
        const next = Math.max(80, Math.floor(area.clientHeight - headerH));
        setBodyHeight((cur) => (cur === next ? cur : next));
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(area);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [rows.length, columns.length]);

  const scrollX = columns.length * 150;
  return (
    <div ref={areaRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <Table
        rowKey="__rowKey"
        columns={tableColumns}
        dataSource={data}
        size="small"
        loading={loading}
        pagination={false}
        bordered
        tableLayout="fixed"
        scroll={{ x: scrollX, y: bodyHeight }}
      />
    </div>
  );
}
