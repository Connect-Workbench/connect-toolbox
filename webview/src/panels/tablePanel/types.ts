import React from 'react';

/** 列定义（与主进程 describeTable 对齐） */
export interface ColumnDef {
  field: string;
  type: string;
  nullable: boolean;
  key: string;
  default: unknown;
  extra: string;
}

/** 单元格值（主进程已序列化：Date→ISO、Buffer→{__type:'hex',value}、bigint→string） */
export type CellValue = string | number | null | { __type: 'hex'; value: string };

/** 与 MySQL 一致的过滤操作符，直接展示给有 SQL 经验的用户 */
export type FilterOperator =
  | '='
  | '!='
  | '<>'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'NOT LIKE'
  | 'IN'
  | 'NOT IN'
  | 'BETWEEN'
  | 'NOT BETWEEN'
  | 'REGEXP'
  | 'NOT REGEXP'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

export interface FilterSpec {
  field: string;
  operator: FilterOperator;
  value?: string;
}

export interface TableQuery {
  sort?: SortSpec;
  filters: FilterSpec[];
  /** 单表 SQL WHERE 条件（不含完整 SELECT） */
  sqlFilter?: string;
}

export interface PagePayload {
  connectionName: string;
  database: string;
  table: string;
  columns: ColumnDef[];
  rows: Record<string, CellValue>[];
  total: number;
  page: number;
  pageSize: number;
  hasPk: boolean;
  pkColumns: string[];
  query?: TableQuery;
}

/** 导出设置（用户上次在导出面板的选择，主进程 globalState 持久化） */
export interface ExportSettings {
  format: 'csv' | 'sql' | 'json';
  target: 'clipboard' | 'folder';
  sqlStyle: 'single' | 'multi';
  includeHidden: boolean;
}

export interface PanelMessage {
  type: 'page' | 'error' | 'commitResult' | 'cellEdited' | 'exportSettings';
  payload?: PagePayload | CellEditedPayload | ExportSettings;
  message?: string;
  ok?: boolean;
}

/** 单元格编辑器保存结果（写回本地暂存） */
export interface CellEditedPayload {
  rowKey: string;
  field: string;
  value: string;
  /** 编辑前的原值（用于判断是否真正改动） */
  originalValue?: string;
  pkValues?: string[];
}

/** 本地变更（暂存，Commit 后一次性提交） */
export interface LocalRow {
  /** 本地行标识：服务端 r-{index}，草稿 d-{ts} */
  __key: string;
  /** 行状态：normal / new（复制新增）/ deleted（标记删除）/ modified（已修改） */
  __status: 'normal' | 'new' | 'deleted' | 'modified';
  /** 草稿复制来源行在服务端数据中的下标（插入位置跟随） */
  __afterIndex?: number;
  /** 主键定位值（修改/删除用，原始行主键） */
  __pkValues?: string[];
  [field: string]: unknown;
}

export interface CommitPayload {
  /** 新增行：字段值（空串→NULL） */
  inserts: Record<string, string>[];
  /** 修改行：主键定位 + 修改的列值 */
  updates: { pkValues: string[]; changes: Record<string, string> }[];
  /** 删除行：主键定位 */
  deletes: { pkValues: string[] }[];
}

/** 发送给主进程的操作消息 */
export interface UiMessage {
  type: 'loadPage' | 'updateCell' | 'deleteRow' | 'addRow' | 'commit' | 'editCell';
  payload: {
    page?: number;
    pkValues?: unknown[];
    column?: string;
    newValue?: string;
    values?: Record<string, string>;
    commit?: CommitPayload;
    query?: TableQuery;
    rowKey?: string;
    field?: string;
    value?: string;
  };
}
